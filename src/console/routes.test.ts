import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { createConsoleRoutes } from "./routes.js";

test("console confirmation binds principal, route, revision, expiry and replay command ID", async () => {
  let revision = "1";
  const confirmAction = vi.fn(async () => ({
    status: "unknown" as const,
    detail: "Reconcile first.",
  }));
  const app = new Hono().route(
    "/private/console",
    createConsoleRoutes({
      security: {
        origin: "https://console.example",
        csrfSecret: "x".repeat(32),
        authenticate: async (req) =>
          req.headers.get("test-principal") ?? undefined,
      },
      inspect: async () => ({ observedAt: "now", sections: {} }),
      inspectAction: async (_principal, id) => ({
        id,
        revision,
        title: "Revoke grant",
        detail: "Stops future use only.",
        facts: { grant: "grant-1" },
      }),
      confirmAction,
    }),
  );
  const path = "/private/console/actions/revoke";
  const markup = await (
    await app.request(path, { headers: { "test-principal": "owner" } })
  ).text();
  expect(confirmAction).not.toHaveBeenCalled();
  const proof = markup.match(/name="proof" value="([^"]+)"/)?.[1] ?? "";
  const post = (
    principal = "owner",
    route = path,
    confirmed = "yes",
    originHeaders: Record<string, string> = {
      origin: "https://console.example",
    },
    submittedProof = proof,
  ) =>
    app.request(route, {
      method: "POST",
      headers: {
        "test-principal": principal,
        "content-type": "application/x-www-form-urlencoded",
        ...originHeaders,
      },
      body: new URLSearchParams({ proof: submittedProof, confirmed }),
    });
  const rejectedOrigins: Record<string, string>[] = [
    {},
    { "sec-fetch-site": "same-origin" },
    { origin: "null" },
    { origin: "null", "sec-fetch-site": "same-site" },
    { origin: "null", "sec-fetch-site": "cross-site" },
    { origin: "null", "sec-fetch-site": "none" },
    { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
    { origin: "https://console.example", "sec-fetch-site": "cross-site" },
  ];
  for (const originHeaders of rejectedOrigins) {
    const response = await post("owner", path, "yes", originHeaders);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  }
  const browserOrigin = { origin: "null", "sec-fetch-site": "same-origin" };
  expect((await post("owner", path, "yes", browserOrigin, "")).status).toBe(
    403,
  );
  expect(
    (await post("owner", path, "yes", browserOrigin, `${proof}x`)).status,
  ).toBe(403);
  expect((await post("", path, "yes", browserOrigin)).status).toBe(401);
  expect((await post("other")).status).toBe(403);
  expect(
    (await post("owner", "/private/console/actions/different")).status,
  ).toBe(403);
  expect((await post("owner", path, "no")).status).toBe(403);
  revision = "2";
  expect((await post()).status).toBe(403);
  revision = "1";
  expect(confirmAction).not.toHaveBeenCalled();
  expect((await post()).status).toBe(200);
  expect((await post("owner", path, "yes", browserOrigin)).status).toBe(200);
  expect(confirmAction.mock.calls[0]).toEqual(confirmAction.mock.calls[1]);
  expect(confirmAction.mock.calls[0]).toEqual([
    "owner",
    {
      id: "revoke",
      revision: "1",
      commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    },
  ]);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
  try {
    expect((await post()).status).toBe(403);
  } finally {
    vi.restoreAllMocks();
  }
  expect(confirmAction).toHaveBeenCalledTimes(2);
});
