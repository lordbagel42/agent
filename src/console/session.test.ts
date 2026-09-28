import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { createConsoleRoutes } from "./routes.js";
import { privateRoutes } from "./security.js";
import { createConsoleSessionBridge } from "./session.js";

test("browser sessions require host auth, same-origin proof, expire, and revoke on logout/token rotation", async () => {
  let accepted = "fixture-token-never-echoed";
  const security = {
    origin: "https://console.example",
    csrfSecret: "x".repeat(32),
    authenticate: async (req: Request) =>
      req.headers.get("authorization") === `Bearer ${accepted}`
        ? "owner"
        : undefined,
  };
  const bridge = createConsoleSessionBridge(security);
  const app = new Hono().route("/session", bridge.routes).route(
    "/console",
    createConsoleRoutes({
      security: { ...security, authenticate: bridge.authenticate },
      inspect: async () => ({ observedAt: "now", sections: {} }),
    }),
  );
  const getProof = async (path: string, cookie = "") =>
    (await (await app.request(path, { headers: { cookie } })).text()).match(
      /name="proof" value="([^"]+)"/,
    )?.[1] ?? "";
  const post = (
    path: string,
    body: Record<string, string>,
    cookie = "",
    site = "same-origin",
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        origin: "null",
        "sec-fetch-site": site,
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      body: new URLSearchParams(body),
    });
  const proof = await getProof("/session/login");
  expect(
    (await post("/session/login", { proof, token: accepted }, "", "cross-site"))
      .status,
  ).toBe(403);
  expect((await post("/session/login", { proof, token: "wrong" })).status).toBe(
    401,
  );
  expect((await post("/session/login", { token: accepted })).status).toBe(403);
  const login = await post("/session/login", { proof, token: accepted });
  // Straight to the validated destination, not a success interstitial.
  expect(login.status).toBe(303);
  expect(login.headers.get("location")).toBe("/console");
  expect(await login.text()).not.toContain(accepted);
  const setCookie = login.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).not.toContain(accepted);
  const cookie = setCookie.split(";")[0] ?? "";
  expect((await app.request("/console", { headers: { cookie } })).status).toBe(
    200,
  );
  // An existing session continues instead of asking for the token again.
  const again = await app.request("/session/login", { headers: { cookie } });
  expect(again.status).toBe(303);
  expect(again.headers.get("location")).toBe("/console");
  const logoutPage = await (
    await app.request("/session/logout", { headers: { cookie } })
  ).text();
  expect(logoutPage).not.toContain('type="checkbox"');
  const logoutProof = await getProof("/session/logout", cookie);
  // One click, but still CSRF-bound: no proof or a cross-site POST changes nothing.
  expect((await post("/session/logout", {}, cookie)).status).toBe(403);
  expect(
    (
      await post(
        "/session/logout",
        { proof: logoutProof },
        cookie,
        "cross-site",
      )
    ).status,
  ).toBe(403);
  expect((await app.request("/console", { headers: { cookie } })).status).toBe(
    200,
  );
  expect(
    (await post("/session/logout", { proof: logoutProof }, cookie)).status,
  ).toBe(200);
  expect((await app.request("/console", { headers: { cookie } })).status).toBe(
    401,
  );
  const rotated = await post("/session/login", { proof, token: accepted });
  const rotatedCookie = rotated.headers.get("set-cookie")?.split(";")[0] ?? "";
  accepted = "rotated-token";
  expect(
    (await app.request("/console", { headers: { cookie: rotatedCookie } }))
      .status,
  ).toBe(401);
  const expires = await post("/session/login", { proof, token: accepted });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 900_001);
  try {
    expect(
      (
        await app.request("/console", {
          headers: {
            cookie: expires.headers.get("set-cookie")?.split(";")[0] ?? "",
          },
        })
      ).status,
    ).toBe(401);
  } finally {
    vi.restoreAllMocks();
  }
});

test("missing and expired sessions recover locally without replaying actions or changing the return proof", async () => {
  const security = {
    origin: "https://console.example",
    csrfSecret: "x".repeat(32),
    signInPath: "/session/login",
    authenticate: async (req: Request) =>
      req.headers.get("authorization") === "Bearer fixture"
        ? "owner"
        : undefined,
  };
  const bridge = createConsoleSessionBridge(security);
  let writes = 0;
  const protectedRoutes = privateRoutes({
    ...security,
    authenticate: bridge.authenticate,
  });
  protectedRoutes.get("/review", (c) => c.text("Review still required"));
  protectedRoutes.post("/review", (c) => {
    writes++;
    return c.text("write");
  });
  const app = new Hono()
    .route("/session", bridge.routes)
    .route("/console", protectedRoutes);
  const recovery = await app.request("/console/review?code=not-carried");
  expect(recovery.status).toBe(401);
  const recoveryHtml = await recovery.text();
  expect(recoveryHtml).toContain(
    'href="/session/login?returnTo=%2Fconsole%2Freview"',
  );
  // A cross-site navigation lacks the Strict cookie: continue through a
  // same-origin document, never carrying the query.
  expect(recoveryHtml).toContain(
    `http-equiv="refresh" content="0; url='/session/login?returnTo=%2Fconsole%2Freview'"`,
  );
  expect(recoveryHtml).not.toContain("not-carried");
  const formPage = await app.request(
    "/session/login?returnTo=%2Fconsole%2Freview",
  );
  // Without a session, sign-in renders instead of redirecting back: no loop.
  expect(formPage.status).toBe(200);
  const formHtml = await formPage.text();
  expect(formHtml).not.toContain('http-equiv="refresh"');
  const proof = formHtml.match(/name="proof" value="([^"]+)"/)?.[1] ?? "";
  const post = (returnTo: string, token = "fixture") =>
    app.request("/session/login", {
      method: "POST",
      headers: {
        origin: security.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ proof, returnTo, token }),
    });
  expect((await post("/console/other")).status).toBe(403);
  const rejected = await post("/console/review", "wrong");
  expect(rejected.status).toBe(401);
  expect(await rejected.text()).toContain(
    'href="/session/login?returnTo=%2Fconsole%2Freview"',
  );
  const login = await post("/console/review");
  expect(login.status).toBe(303);
  expect(login.headers.get("location")).toBe("/console/review");
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(
    await (
      await app.request("/console/review", { headers: { cookie } })
    ).text(),
  ).toBe("Review still required");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 900_001);
  try {
    const expired = await app.request("/console/review", {
      headers: { cookie },
    });
    expect(expired.status).toBe(401);
    expect(await expired.text()).toContain(
      'href="/session/login?returnTo=%2Fconsole%2Freview"',
    );
    const deniedPost = await app.request("/console/review", {
      method: "POST",
      headers: { cookie },
      body: "never-replay",
    });
    expect(deniedPost.status).toBe(401);
    const deniedHtml = await deniedPost.text();
    expect(deniedHtml).toContain('href="/session/login"');
    expect(deniedHtml).not.toContain('http-equiv="refresh"');
    expect(writes).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
  for (const returnTo of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/%2f%2fevil.example",
    "/a/../elsewhere",
    "/console?code=secret",
    "/console#fragment",
    "/\t/evil.example",
  ]) {
    const page = await (
      await app.request(
        `/session/login?returnTo=${encodeURIComponent(returnTo)}`,
      )
    ).text();
    expect(page).toContain('name="returnTo" value="/console"');
  }
});
