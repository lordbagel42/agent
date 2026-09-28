import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { BrowserCompanion } from "./companion.js";
import { createBrowserLiveView } from "./live-view.js";
import type { BrowserSession } from "./session.js";

function fixture(shutdown?: AbortSignal) {
  let principal: string | undefined = "owner";
  const session = {
    generation: "generation-one",
    epoch: 0,
    state: "live",
    frame: vi.fn(async () => ({
      generation: session.generation,
      epoch: session.epoch,
      capturedAt: 123,
      data: new Uint8Array([1, 2, 3]),
    })),
  } as unknown as BrowserSession;
  let current: BrowserSession | undefined = session;
  const companion = {
    status: (_id: string, owner: string) =>
      owner === "owner" ? { status: "running" } : undefined,
    session: (_id: string, owner: string) =>
      owner === "owner" ? current : undefined,
  } as Pick<BrowserCompanion, "status" | "session">;
  const app = new Hono().route(
    "/console/browser",
    createBrowserLiveView(
      {
        origin: "https://june.test",
        csrfSecret: "s".repeat(32),
        authenticate: async () => principal,
      },
      companion,
      shutdown,
    ),
  );
  return {
    app,
    session,
    principal: (value?: string) => {
      principal = value;
    },
    replace: (value?: BrowserSession) => {
      current = value;
    },
  };
}
async function event(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  return new TextDecoder().decode(result.value);
}
function readerFor(response: Response) {
  if (!response.body) throw new Error("Expected stream body");
  return response.body.getReader();
}
describe("browser live view", () => {
  it("terminates a consuming real HTTP stream before server shutdown waits for it", async () => {
    const shutdown = new AbortController();
    const f = fixture(shutdown.signal);
    const listening = Promise.withResolvers<void>();
    const server = serve(
      { fetch: f.app.fetch, hostname: "127.0.0.1", port: 0 },
      () => listening.resolve(),
    );
    try {
      await listening.promise;
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing server address");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/console/browser/task/stream`,
      );
      const reader = readerFor(response);
      expect(await event(reader)).toContain("event: state");
      const drained = (async () => {
        try {
          while (!(await reader.read()).done) {}
        } catch {
          /* SSE abort closes transport */
        }
      })();
      shutdown.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await drained;
    } finally {
      shutdown.abort();
      server.close();
    }
  });
  it("rejects unauthenticated and wrong-owner HTML and streams", async () => {
    const f = fixture();
    for (const principal of [undefined, "other"]) {
      f.principal(principal);
      for (const suffix of ["", "/stream"])
        expect(
          (await f.app.request(`/console/browser/task${suffix}`)).status,
        ).toBe(principal ? 404 : 401);
    }
    expect(f.session.frame).not.toHaveBeenCalled();
  });
  it("renders a nonce-bound read-only page and streams the existing session", async () => {
    const f = fixture();
    const page = await f.app.request("/console/browser/task");
    expect(page.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect(await page.text()).toContain("Browser live view");
    const reader = readerFor(
      await f.app.request("/console/browser/task/stream"),
    );
    expect(await event(reader)).toContain('"state":"live"');
    let frame = await event(reader);
    if (!frame.includes("event: frame")) frame = await event(reader);
    expect(frame).toContain('"generation":"generation-one"');
    expect(frame).toContain('"image":"data:image/jpeg;base64,AQID"');
    await reader.cancel();
  });
  it.each(["private", "expired", "ended", "replacement"])(
    "discards capture crossing %s",
    async (change) => {
      const f = fixture();
      let resolve!: (
        value: Awaited<ReturnType<BrowserSession["frame"]>>,
      ) => void;
      vi.mocked(f.session.frame).mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const reader = readerFor(
        await f.app.request("/console/browser/task/stream"),
      );
      expect(await event(reader)).toContain('"state":"live"');
      await vi.waitFor(() => expect(resolve).toBeDefined());
      if (change === "expired") f.principal(undefined);
      else if (change === "replacement") f.replace({ ...f.session });
      else Object.assign(f.session, { state: change, epoch: 1 });
      const state = await event(reader);
      resolve({
        generation: "generation-one",
        epoch: 0,
        capturedAt: 123,
        data: new Uint8Array([1, 2, 3]),
      });
      expect(state).not.toContain("event: frame");
      expect(state).toContain(
        `"state":"${change === "private" ? "private" : change === "expired" ? "error" : "ended"}"`,
      );
      await reader.cancel();
    },
  );
  it("reports ended sessions without capture", async () => {
    const f = fixture();
    f.replace(undefined);
    const response = await f.app.request("/console/browser/task/stream");
    expect(await response.text()).toContain('"state":"ended"');
    expect(f.session.frame).not.toHaveBeenCalled();
  });
  it.each(["private", "expired"])(
    "revalidates a backpressured frame after %s when the consumer finally reads",
    async (change) => {
      const f = fixture();
      const reader = readerFor(
        await f.app.request("/console/browser/task/stream"),
      );
      await event(reader);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (change === "private")
        Object.assign(f.session, { state: "private", epoch: 1 });
      else f.principal(undefined);
      const result = await event(reader);
      await reader.cancel();
      expect(result).not.toContain("event: frame");
      expect(result).toContain(
        `"state":"${change === "private" ? "private" : "error"}"`,
      );
    },
  );
  it("bounds subscribers and frees disconnected or stalled viewer slots", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const one = await f.app.request("/console/browser/task/stream");
      const two = await f.app.request("/console/browser/task/stream");
      expect((await f.app.request("/console/browser/task/stream")).status).toBe(
        429,
      );
      await one.body?.cancel();
      await vi.advanceTimersByTimeAsync(0);
      const three = await f.app.request("/console/browser/task/stream");
      expect(three.status).toBe(200);
      await vi.advanceTimersByTimeAsync(5100);
      const four = await f.app.request("/console/browser/task/stream");
      expect(four.status).toBe(200);
      await four.body?.cancel();
      await two.body?.cancel().catch(() => {});
      await three.body?.cancel().catch(() => {});
      expect(f.session.frame).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects service frames larger than the stream's 1 MiB budget", async () => {
    const f = fixture();
    vi.mocked(f.session.frame).mockResolvedValue({
      generation: "generation-one",
      epoch: 0,
      capturedAt: 123,
      data: new Uint8Array(1024 * 1024 + 1),
    });
    const response = await f.app.request("/console/browser/task/stream");
    const result = await response.text();
    expect(result).toContain('"state":"error"');
    expect(result).not.toContain("event: frame");
  });
});
