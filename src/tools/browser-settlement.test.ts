import {
  type Browser,
  chromium,
  type Route,
  type WebSocketRoute,
} from "playwright";
import { afterEach, expect, test, vi } from "vitest";
import { CapabilityBroker } from "./broker.js";
import { BrowserAdapter } from "./browser.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const navigation = Promise.withResolvers<void>();
  const contextClosed = Promise.withResolvers<void>();
  const browserClosed = Promise.withResolvers<void>();
  let route: ((route: Route) => Promise<void>) | undefined;
  let websocket: ((socket: WebSocketRoute) => void) | undefined;
  const frame = {};
  const page = {
    on: vi.fn(),
    mainFrame: () => frame,
    goto: vi.fn(() => navigation.promise),
    locator: () => ({
      waitFor: async () => {},
      textContent: async () => "done",
    }),
  };
  const context = {
    close: vi.fn(() => contextClosed.promise),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    routeWebSocket: async (_pattern: unknown, handler: typeof websocket) => {
      websocket = handler;
    },
    newPage: async () => page,
    on: vi.fn(),
    route: async (_pattern: unknown, handler: typeof route) => {
      route = handler;
    },
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(() => browserClosed.promise),
  };
  const action = {
    tool: "browser",
    account: "fixture",
    item: "fixture",
    origin: "https://fixture.example",
    arguments: { operation: "check" },
  };
  const adapter = new BrowserAdapter({
    operations: [
      {
        name: "check",
        account: action.account,
        item: action.item,
        origin: action.origin,
        url: `${action.origin}/`,
        requests: [{ url: `${action.origin}/`, method: "GET" }],
        success: { selector: "#ok", text: "done" },
      },
    ],
  });
  const broker = new CapabilityBroker(":memory:", {
    owner: "owner",
    tools: { browser: adapter },
    resolveCredential: async () => null,
  });
  const grant = broker.grant("owner", {
    audience: "owner",
    action,
    expiresAt: Date.now() + 60_000,
  });
  vi.spyOn(chromium, "launch").mockResolvedValueOnce(
    browser as unknown as Browser,
  );
  return {
    navigation,
    contextClosed,
    browserClosed,
    page,
    context,
    browser,
    action,
    adapter,
    broker,
    grant,
    frame,
    route: () => route,
    websocket: () => websocket,
  };
}

test.each(["page", "cleanup"])(
  "cancel retains admission when %s settles first and leaves other sessions alone",
  async (first) => {
    const f = fixture();
    const other = fixture();
    let settled = false;
    const execution = f.broker
      .execute("owner", f.grant, f.action)
      .then((receipt) => {
        settled = true;
        return receipt;
      });
    const otherExecution = other.broker.execute(
      "owner",
      other.grant,
      other.action,
    );
    await vi.waitFor(() => expect(f.page.goto).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(other.page.goto).toHaveBeenCalledOnce());
    expect(() => f.broker.cancel("stranger", f.grant)).toThrow(
      "capability_denied",
    );
    expect(f.context.close).not.toHaveBeenCalled();
    expect(f.broker.cancel("owner", f.grant)?.status).toBe("unknown");
    await vi.waitFor(() => expect(f.context.close).toHaveBeenCalledOnce());
    const stopped = { confirmedStopped: true, outcome: "failed" };
    if (first === "page") f.navigation.resolve();
    else {
      f.contextClosed.resolve();
      f.browserClosed.resolve();
      await vi.waitFor(() => expect(f.browser.close).toHaveBeenCalledOnce());
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(() => f.broker.reconcile("owner", f.grant, stopped)).toThrow(
      "capability_denied",
    );
    expect(other.context.close).not.toHaveBeenCalled();
    expect(other.browser.close).not.toHaveBeenCalled();
    other.navigation.resolve();
    other.contextClosed.resolve();
    other.browserClosed.resolve();
    expect((await otherExecution).status).toBe("succeeded");
    f.navigation.resolve();
    f.contextClosed.resolve();
    f.browserClosed.resolve();
    expect((await execution).status).toBe("unknown");
    expect(f.context.close).toHaveBeenCalledOnce();
    expect(f.browser.close).toHaveBeenCalledOnce();
    expect(f.broker.reconcile("owner", f.grant, stopped).status).toBe("failed");
    await expect(f.broker.execute("owner", f.grant, f.action)).rejects.toThrow(
      "capability_denied",
    );
    await Promise.all([f.adapter.close(), other.adapter.close()]);
    f.broker.close();
    other.broker.close();
  },
);

test("page and close settlement cannot release a pending request-header callback", async () => {
  const f = fixture();
  const headers = Promise.withResolvers<Record<string, string>>();
  let settled = false;
  const execution = f.broker
    .execute("owner", f.grant, f.action)
    .then((receipt) => {
      settled = true;
      return receipt;
    });
  await vi.waitFor(() => expect(f.page.goto).toHaveBeenCalledOnce());
  const fetch = vi.fn();
  const routed = f.route()?.({
    request: () => ({
      url: () => `${f.action.origin}/`,
      method: () => "GET",
      frame: () => f.frame,
      redirectedFrom: () => null,
      allHeaders: () => headers.promise,
    }),
    fetch,
    abort: async () => {},
  } as unknown as Route);
  expect(routed).toBeDefined();
  f.broker.cancel("owner", f.grant);
  f.navigation.reject(new Error("private-page-error"));
  f.contextClosed.resolve();
  f.browserClosed.resolve();
  await vi.waitFor(() => expect(f.browser.close).toHaveBeenCalledOnce());
  const shutdown = f.adapter.close();
  expect(settled).toBe(false);
  expect(() =>
    f.broker.reconcile("owner", f.grant, {
      confirmedStopped: true,
      outcome: "failed",
    }),
  ).toThrow();
  headers.resolve({});
  await routed;
  await shutdown;
  expect((await execution).status).toBe("unknown");
  expect(fetch).not.toHaveBeenCalled();
  f.broker.close();
});

test("blocked WebSocket close must settle before execution or shutdown releases admission", async () => {
  const f = fixture();
  const socketClosed = Promise.withResolvers<void>();
  let settled = false;
  let shutdownSettled = false;
  const execution = f.broker
    .execute("owner", f.grant, f.action)
    .then((receipt) => {
      settled = true;
      return receipt;
    });
  await vi.waitFor(() => expect(f.page.goto).toHaveBeenCalledOnce());
  expect(f.websocket()).toBeDefined();
  f.websocket()?.({
    close: () => socketClosed.promise,
  } as unknown as WebSocketRoute);
  f.navigation.resolve();
  f.contextClosed.resolve();
  f.browserClosed.resolve();
  await vi.waitFor(() => expect(f.browser.close).toHaveBeenCalledOnce());
  const shutdown = f.adapter.close().then(() => {
    shutdownSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(shutdownSettled).toBe(false);
  expect(() =>
    f.broker.reconcile("owner", f.grant, {
      confirmedStopped: true,
      outcome: "failed",
    }),
  ).toThrow("capability_denied");
  socketClosed.resolve();
  expect((await execution).status).toBe("unknown");
  await shutdown;
  f.broker.close();
});

test("failed cleanup cannot confirm a successful page or silently reopen the adapter", async () => {
  const f = fixture();
  const execution = f.broker.execute("owner", f.grant, f.action);
  f.navigation.resolve();
  await vi.waitFor(() => expect(f.context.close).toHaveBeenCalledOnce());
  f.contextClosed.reject(new Error("private-cleanup-error"));
  f.browserClosed.resolve();
  const receipt = await execution;
  expect(receipt.status).toBe("unknown");
  expect(JSON.stringify(receipt)).not.toContain("private");
  expect(f.browser.close).toHaveBeenCalledOnce();
  await expect(f.adapter.close()).rejects.toThrow("browser_cleanup_failed");
  await expect(f.adapter.execute(f.action, null)).rejects.toThrow(
    "browser_action_failed",
  );
  expect(chromium.launch).toHaveBeenCalledOnce();
  expect(await f.broker.execute("owner", f.grant, f.action)).toEqual(receipt);
  f.broker.close();
});

test("cancellation during launch waits for the late owned browser and closes it once", async () => {
  const f = fixture();
  const launched = Promise.withResolvers<Browser>();
  vi.mocked(chromium.launch).mockReset().mockReturnValueOnce(launched.promise);
  const execution = f.broker.execute("owner", f.grant, f.action);
  await vi.waitFor(() => expect(chromium.launch).toHaveBeenCalledOnce());
  f.broker.cancel("owner", f.grant);
  const shutdown = f.adapter.close();
  launched.resolve(f.browser as unknown as Browser);
  await vi.waitFor(() => expect(f.browser.close).toHaveBeenCalledOnce());
  expect(f.browser.newContext).not.toHaveBeenCalled();
  f.browserClosed.resolve();
  expect((await execution).status).toBe("unknown");
  await shutdown;
  f.broker.close();
});
