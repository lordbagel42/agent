import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBrowserSession } from "./session.js";

let origin: string;
let home: string;
let deniedWrites = 0;
let targetOrigin: string;
let targetRequests = 0;
let loginPosts = 0;
const unlockedPage =
  '<h1>Unlocked same session</h1><script src="/login-script.js"></script><video src="/asymmetric.webm" preload="auto" width="320" height="180"></video>';
const target = createServer((_req, res) => {
  targetRequests++;
  res.end("Redirect escaped");
});
const server = createServer((req, res) => {
  if (req.url === "/login-script.js") {
    res.setHeader("content-type", "text/javascript");
    res.end('document.body.append("External script loaded")');
    return;
  }
  if (req.url === "/unlocked") {
    res.setHeader("content-type", "text/html");
    res.end(unlockedPage);
    return;
  }
  if (req.url?.startsWith("/redirect-pin/")) {
    res.setHeader("content-type", "text/html");
    res.end(
      `<form action="/redirect-post/${req.url.split("/").at(-1)}" method="post"><input type="password" name="pin"><button>Unlock</button></form>`,
    );
    return;
  }
  if (req.url?.startsWith("/redirect-post/")) {
    res
      .writeHead(Number(req.url.split("/").at(-1)), {
        location: `${targetOrigin}/secret`,
      })
      .end();
    return;
  }
  if (req.url === "/direct") {
    res.setHeader("content-type", "text/html");
    res.end(
      '<form action="/login-direct" method="post"><input type="password" name="pin"><input type="hidden" name="csrf" value="required"><button>Unlock</button></form>',
    );
    return;
  }
  if (req.url === "/asymmetric.webm") {
    const data = readFileSync(
      new URL(
        "../../tests/fixtures/browser-companion/asymmetric.webm",
        import.meta.url,
      ),
    );
    const start = Number(
      /^bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0,
    );
    res.setHeader("content-type", "video/webm");
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-length", data.length - start);
    if (req.headers.range) {
      res.statusCode = 206;
      res.setHeader(
        "content-range",
        `bytes ${start}-${data.length - 1}/${data.length}`,
      );
    }
    res.end(data.subarray(start));
    return;
  }
  if (req.url === "/media") {
    res.setHeader("content-type", "text/html");
    res.end(
      '<video src="/asymmetric.webm" preload="auto" width="320" height="180"></video><div style="height:2000px">Scroll fixture</div>',
    );
    return;
  }
  if (req.url === "/noop") {
    res.setHeader("content-type", "text/html");
    res.end(
      '<form action="/login" method="post" onsubmit="event.preventDefault()"><input type="password" name="pin"><button>Unlock</button></form>',
    );
    return;
  }
  if (req.url === "/write") deniedWrites++;
  if (req.url === "/redirect") {
    res.writeHead(302, { location: `${targetOrigin}/denied` }).end();
    return;
  }
  if (
    (req.url === "/login" || req.url === "/login-direct") &&
    req.method === "POST"
  ) {
    loginPosts++;
    res.setHeader("content-type", "text/html");
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (body === "pin=246810&csrf=required") {
        res.writeHead(req.url === "/login-direct" ? 200 : 303, {
          ...(req.url === "/login-direct" ? {} : { location: "/unlocked" }),
          "content-type": "text/html",
          "set-cookie": "gate=yes; HttpOnly; SameSite=Strict",
        });
        res.end(unlockedPage);
      } else
        res.end(
          '<form action="/login" method="post"><input type="password" name="pin" value="000000"><input type="hidden" name="csrf" value="required"><button>Unlock</button></form>',
        );
    });
    return;
  }
  if (req.url === "/cookie") {
    res.end(
      req.headers.cookie === "gate=yes" ? "Cookie retained" : "No cookie",
    );
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(
    '<h1>PIN gate</h1><form action="/login" method="post"><input type="password" name="pin"><input type="hidden" name="csrf" value="required"><button>Unlock</button></form><script>fetch("/write", {method:"POST"}).catch(()=>{});</script>',
  );
});
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "june-browser-test-"));
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  if (!targetAddress || typeof targetAddress === "string")
    throw new Error("No target address");
  targetOrigin = `http://127.0.0.1:${targetAddress.port}`;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => target.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});
const open = () =>
  createBrowserSession({
    url: origin,
    navigationOrigins: [origin],
    resourceOrigins: [origin],
    home,
    tempDirectory: home,
    allowLoopbackHttp: true,
  });
function refs(text: string) {
  const elements = JSON.parse(text).elements as { ref: string; tag: string }[];
  return {
    inputRef: elements.find((e) => e.tag === "input")?.ref,
    submitRef: elements.find((e) => e.tag === "button")?.ref,
  };
}
test("revocation during PIN form inspection prevents submission without waiting for abort", async () => {
  const session = await open();
  try {
    await session.tool("request_pin", refs((await session.observe()).text));
    let valid = true;
    const postsBefore = loginPosts;
    const submission = session.enterPin("246810", () => valid);
    valid = false;
    await expect(submission).rejects.toThrow("uncertain");
    expect(loginPosts).toBe(postsBefore);
    expect(await session.frame()).toBeUndefined();
  } finally {
    await session.close();
  }
});
test("PIN pause fences captures, retries safely, and retains the original cookie context", async () => {
  const session = await open();
  try {
    const first = await session.observe();
    expect(first.image?.data.byteLength).toBeGreaterThan(100);
    const late = session.frame();
    await session.tool("request_pin", refs(first.text));
    expect(session.state).toBe("private");
    expect(await late).toBeUndefined();
    expect(await session.frame()).toBeUndefined();
    expect((await session.observe()).image).toBeUndefined();
    expect(session.pendingInput()?.origin).toBe(origin);
    const challengeId = session.pendingInput()?.challengeId;
    expect(challengeId).toEqual(expect.any(String));
    await session.enterPin("000000");
    expect(session.state).toBe("live");
    await expect(session.enterPin("246810")).rejects.toThrow(
      "No pending input",
    );
    await session.tool("request_pin", refs((await session.observe()).text));
    expect(session.pendingInput()?.challengeId).not.toBe(challengeId);
    const postsBefore = loginPosts;
    await session.enterPin("246810");
    expect(loginPosts - postsBefore).toBe(1);
    expect((await session.observe()).text).toContain("Unlocked same session");
    const unlocked = await session.observe();
    expect(unlocked.text).toContain("External script loaded");
    const videoRef = JSON.parse(unlocked.text).elements.find(
      (e: { tag: string }) => e.tag === "video",
    ).ref;
    expect(
      (await session.tool("video_frame", { ref: videoRef, timeSeconds: 2 }))
        .image?.data.byteLength,
    ).toBeGreaterThan(100);
    expect((await session.tool("discover_media", {})).text).toContain("video");
    expect(
      (await session.tool("navigate", { url: `${origin}/cookie` })).text,
    ).toContain("Cookie retained");
    expect(deniedWrites).toBe(0);
  } finally {
    await session.close();
  }
  expect(session.state).toBe("ended");
  expect(await session.frame()).toBeUndefined();
});
test("denies unapproved redirects, arbitrary code, and stale references", async () => {
  const session = await open();
  try {
    const old = refs((await session.observe()).text);
    await session.tool("navigate", { url: origin });
    expect((await session.tool("request_pin", old)).text).toContain(
      "unavailable",
    );
    expect((await session.tool("evaluate", { code: "1+1" })).text).toContain(
      "unavailable",
    );
    expect(
      (await session.tool("navigate", { url: `${origin}/redirect` })).text,
    ).toContain("unavailable");
    expect(targetRequests).toBe(0);
  } finally {
    await session.close();
  }
});
test.each([303, 307, 308])(
  "never forwards a native secret POST through a %i redirect to a reachable disallowed server",
  async (status) => {
    const session = await open();
    try {
      const observation = await session.tool("navigate", {
        url: `${origin}/redirect-pin/${status}`,
      });
      await session.tool("request_pin", refs(observation.text));
      await expect(session.enterPin("246810")).rejects.toThrow("uncertain");
      expect(targetRequests).toBe(0);
      expect(session.state).toBe("private");
    } finally {
      await session.close();
    }
  },
);
test("a direct native PIN response loads configured scripts and real media without replaying POST", async () => {
  const session = await open();
  try {
    const observation = await session.tool("navigate", {
      url: `${origin}/direct`,
    });
    await session.tool("request_pin", refs(observation.text));
    const postsBefore = loginPosts;
    await session.enterPin("246810");
    expect(loginPosts - postsBefore).toBe(1);
    const unlocked = await session.observe();
    expect(unlocked.text).toContain("External script loaded");
    const ref = JSON.parse(unlocked.text).elements.find(
      (e: { tag: string }) => e.tag === "video",
    ).ref;
    const frame = await session.tool("video_frame", { ref, timeSeconds: 2 });
    expect(frame.image?.data.byteLength).toBeGreaterThan(100);
    expect(frame.image?.data.byteLength).toBeLessThanOrEqual(1024 * 1024);
  } finally {
    await session.close();
  }
});
test("captures different real video frames with actual timestamps and closes only the aborted session", async () => {
  const controller = new AbortController();
  const session = await createBrowserSession({
    url: `${origin}/media`,
    navigationOrigins: [origin],
    resourceOrigins: [origin],
    home,
    tempDirectory: home,
    allowLoopbackHttp: true,
    signal: controller.signal,
  });
  const independent = await open();
  try {
    const observation = await session.observe();
    const ref = JSON.parse(observation.text).elements.find(
      (e: { tag: string }) => e.tag === "video",
    ).ref;
    const first = await session.tool("video_frame", { ref, timeSeconds: 0.2 });
    const second = await session.tool("video_frame", { ref, timeSeconds: 2 });
    expect(first.image?.data.byteLength).toBeGreaterThan(100);
    expect(second.image?.data.byteLength).toBeGreaterThan(100);
    expect(first.image?.data).not.toEqual(second.image?.data);
    expect(JSON.parse(first.text).timeSeconds).toBeCloseTo(0.2);
    expect(JSON.parse(second.text).timeSeconds).toBeCloseTo(2);
    expect(second.text).toContain("no audio heard");
    controller.abort();
    await session.close();
    expect(session.state).toBe("ended");
    expect(await session.frame()).toBeUndefined();
    expect((await independent.frame())?.data.byteLength).toBeGreaterThan(100);
  } finally {
    await session.close();
    await independent.close();
  }
});
test("an unconfirmed submit never resumes observations or retries a secret", async () => {
  const session = await open();
  try {
    const observation = await session.tool("navigate", {
      url: `${origin}/noop`,
    });
    await session.tool("request_pin", refs(observation.text));
    await expect(session.enterPin("246810")).rejects.toThrow("uncertain");
    expect(session.state).toBe("private");
    expect(await session.frame()).toBeUndefined();
    expect(session.pendingInput()).toBeUndefined();
  } finally {
    await session.close();
  }
});
