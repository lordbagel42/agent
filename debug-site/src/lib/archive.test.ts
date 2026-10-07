import * as webauthn from "@simplewebauthn/browser";
import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArchive } from "./archive.js";
import type { OperationDetail, OperationSummary } from "./types.js";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const snapshot = (id: string, data: unknown = {}) => ({
  id,
  sessionId: "session-1",
  capturedAt: "2026-10-04T12:00:00.000Z",
  revision: "test",
  scope: ["private"],
  reason: "",
  exclusions: [],
  data,
});

function transport() {
  const requests: {
    path: string;
    init?: RequestInit;
    resolve: (value: Response) => void;
  }[] = [];
  const fetcher = (path: string, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      requests.push({ path, init, resolve });
    });
  const reply = (path: string, value: unknown, status = 200) => {
    const index = requests.findIndex((request) => request.path === path);
    const request = requests.splice(index, 1)[0];
    if (!request || index < 0) throw new Error(`No request: ${path}`);
    request.resolve(new Response(JSON.stringify(value), { status }));
  };
  return { requests, fetcher, reply };
}

describe("private archive client", () => {
  it("does not let a slow previous capture replace the selected capture", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const first = archive.select("first");
    const second = archive.select("second");
    network.reply("/api/snapshots/second", snapshot("second"));
    await second;
    network.reply("/api/snapshots/first", snapshot("first"));
    await first;
    expect(get(archive).snapshot?.id).toBe("second");
    expect(get(archive).selectedId).toBe("second");
  });

  it("clears all capture data on expiry and ignores already-in-flight private responses", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const loaded = archive.select("retained");
    network.reply(
      "/api/snapshots/retained",
      snapshot("retained", { private: "evidence" }),
    );
    await loaded;
    const index = archive.search("", 0);
    const capture = archive.select("pending");
    network.reply(
      "/api/snapshots?q=&offset=0",
      { privateError: "never shown" },
      401,
    );
    await index;
    network.reply(
      "/api/snapshots/pending",
      snapshot("pending", { private: "evidence" }),
    );
    await capture;
    expect(get(archive)).toMatchObject({
      phase: "login",
      snapshot: null,
      index: null,
      selectedId: null,
    });
    expect(JSON.stringify(get(archive))).not.toContain("evidence");
    expect(JSON.stringify(get(archive))).not.toContain("privateError");
  });

  it("does not start a chained newest-capture read after the session is cleared", async () => {
    const paths: string[] = [];
    const latest = Promise.withResolvers<Response>();
    const archive = createArchive(async (path) => {
      paths.push(path);
      return path === "/api/snapshots?q=&offset=0"
        ? latest.promise
        : new Response(JSON.stringify(snapshot("latest")));
    });
    const pending = archive.select(null);
    archive.clear();
    latest.resolve(
      new Response(
        JSON.stringify({
          items: [{ ...snapshot("latest"), bytes: 500 }],
          total: 1,
          nextOffset: null,
        }),
      ),
    );
    await pending;
    expect(paths).toEqual(["/api/snapshots?q=&offset=0"]);
    expect(get(archive).snapshot).toBeNull();
  });

  it("sends credentials in a same-origin JSON body and distinguishes unavailable captures from server failures", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const login = archive.login("synthetic-viewer-token", null);
    expect(network.requests[0]).toMatchObject({
      path: "/api/session",
      init: {
        credentials: "same-origin",
        method: "POST",
        body: '{"token":"synthetic-viewer-token"}',
      },
    });
    network.reply("/api/session", {}, 401);
    await login;
    expect(JSON.stringify(get(archive))).not.toContain(
      "synthetic-viewer-token",
    );
    const missing = archive.select("not-uploaded");
    network.reply("/api/snapshots/not-uploaded", {}, 404);
    await missing;
    expect(get(archive).captureError).toBe("missing");
    const failed = archive.select("failed");
    network.reply(
      "/api/snapshots/failed",
      { error: "private stack trace" },
      500,
    );
    await failed;
    expect(get(archive).captureError).toBe("failed");
    expect(JSON.stringify(get(archive))).not.toContain("private stack trace");
  });

  it("rechecks session state after waiting for the cross-tab cookie lock", async () => {
    const granted = Promise.withResolvers<void>();
    const lock = vi.fn((_name: string, task: () => Promise<Response>) =>
      granted.promise.then(task),
    );
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { locks: { request: lock } });
    const fetcher = vi.fn(async () => Response.json({}));
    const archive = createArchive(fetcher);
    const login = archive.login("synthetic-viewer-token", null);
    expect(lock.mock.calls[0]?.[0]).toBe("june-debug-auth");
    expect(fetcher).not.toHaveBeenCalled();
    archive.clear();
    granted.resolve();
    await login;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not silently omit cookie coordination in an unsupported browser", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    const fetcher = vi.fn(async () => Response.json({}));
    const archive = createArchive(fetcher);
    await archive.loginWithPasskey(null);
    expect(fetcher).not.toHaveBeenCalled();
    expect(get(archive).loginError).toContain("Update your browser");
    expect(get(archive).loginBusy).toBe(false);
  });

  it("does not submit a passkey response after sign-out invalidates the browser prompt", async () => {
    const prompt = Promise.withResolvers<webauthn.AuthenticationResponseJSON>();
    let waiting = false;
    vi.mocked(webauthn.startAuthentication).mockImplementation(() => {
      waiting = true;
      return prompt.promise;
    });
    const paths: string[] = [];
    const archive = createArchive(async (path) => {
      paths.push(path);
      return Response.json({ challenge: "synthetic-challenge" });
    });
    const login = archive.loginWithPasskey("deep-capture");
    await vi.waitFor(() => expect(waiting).toBe(true));
    archive.clear();
    prompt.resolve({
      id: "test",
      rawId: "test",
      type: "public-key",
      clientExtensionResults: {},
      response: {
        authenticatorData: "test",
        clientDataJSON: "test",
        signature: "test",
        userHandle: "test",
      },
    });
    await login;
    expect(paths).toEqual(["/api/passkeys/login/options"]);
    expect(get(archive).phase).toBe("login");
    expect(get(archive).snapshot).toBeNull();
  });

  it("keeps the credential fallback usable after a cancelled passkey prompt", async () => {
    vi.mocked(webauthn.startAuthentication).mockRejectedValue(
      new DOMException("private platform detail", "NotAllowedError"),
    );
    const archive = createArchive(async () =>
      Response.json({ challenge: "test" }),
    );
    await archive.loginWithPasskey(null);
    expect(get(archive)).toMatchObject({ phase: "login", loginBusy: false });
    expect(get(archive).loginError).toContain("cancelled");
    expect(get(archive).loginError).not.toContain("private platform detail");
  });

  it("clears private evidence after passkey revocation but keeps it for a reauthentication-required response", async () => {
    let status = 403;
    const archive = createArchive(async (path) =>
      path.includes("/delete")
        ? Response.json({ error: "reauthentication_required" }, { status })
        : Response.json(snapshot("private-capture")),
    );
    await archive.select("private-capture");
    await archive.removePasskey("key");
    expect(get(archive).snapshot?.id).toBe("private-capture");
    expect(get(archive).passkeyError).toContain("Sign in again");
    status = 200;
    await archive.removePasskey("key");
    expect(get(archive)).toMatchObject({
      phase: "login",
      snapshot: null,
      index: null,
    });
  });
});

function operation(id: string): OperationSummary {
  return {
    latest: {
      id: `${id}:1`,
      operationId: id,
      source: "recovery",
      sequence: 1,
      observedAt: 2000,
      occurredAt: null,
      status: "pending",
      failure: false,
      phase: "readiness",
      reason: "health_failed",
    },
    firstObservedAt: 2000,
    lastObservedAt: 2000,
    eventCount: 1,
    failure: null,
    failureKey: null,
    matchingFailures: 0,
  };
}
function detail(id: string): OperationDetail {
  const summary = operation(id);
  return {
    operation: summary,
    events: [summary.latest],
    totalEvents: 1,
    nextOffset: null,
    related: [],
  };
}
const operationIndex = (id: string) => ({
  items: [operation(id)],
  total: 1,
  nextOffset: null,
  controller: null,
});

describe("private operations client", () => {
  it("searches retained metadata with source and symptom filters, ignoring older results", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const first = archive.searchOperations({ query: "old" });
    const second = archive.searchOperations({
      query: "health_failed",
      source: "recovery",
      failureKey: "recovery:readiness:health_failed",
      offset: 50,
    });
    network.reply(
      "/api/operations?q=health_failed&source=recovery&failureKey=recovery%3Areadiness%3Ahealth_failed&offset=50&limit=50",
      operationIndex("recovery:second"),
    );
    await second;
    network.reply(
      "/api/operations?q=old&offset=0&limit=50",
      operationIndex("recovery:first"),
    );
    await first;
    expect(get(archive).operations.index?.items[0]?.latest.operationId).toBe(
      "recovery:second",
    );
    expect(get(archive).operations).toMatchObject({
      query: "health_failed",
      source: "recovery",
      offset: 50,
      indexBusy: false,
    });
  });

  it("keeps the selected incident when list refreshes and rejects late timeline pages", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const older = archive.selectOperation("recovery:first", 100);
    const selected = archive.selectOperation("recovery:second");
    network.reply(
      "/api/operations/recovery%3Asecond?offset=0",
      detail("recovery:second"),
    );
    await selected;
    const refresh = archive.searchOperations({});
    network.reply(
      "/api/operations?q=&offset=0&limit=50",
      operationIndex("recovery:third"),
    );
    await refresh;
    network.reply(
      "/api/operations/recovery%3Afirst?offset=100",
      detail("recovery:first"),
    );
    await older;
    expect(get(archive).operations).toMatchObject({
      selectedId: "recovery:second",
      eventOffset: 0,
      detailBusy: false,
    });
    expect(get(archive).operations.detail?.operation.latest.operationId).toBe(
      "recovery:second",
    );
  });

  it.each(["expiry", "logout", "pagehide"])(
    "clears all operations metadata on %s and ignores outstanding reads",
    async (cause) => {
      const network = transport();
      const archive = createArchive(network.fetcher);
      const loaded = archive.selectOperation("recovery:private-retained");
      network.reply(
        "/api/operations/recovery%3Aprivate-retained?offset=0",
        detail("recovery:private-retained"),
      );
      await loaded;
      const index = archive.searchOperations({ query: "private-query" });
      const pending = archive.selectOperation("recovery:private-pending");
      if (cause === "expiry") {
        const expired = archive.search("expiry");
        network.reply("/api/snapshots?q=expiry&offset=0", {}, 401);
        await expired;
      } else if (cause === "logout") {
        const logout = archive.logout();
        network.reply("/api/logout", {});
        await logout;
      } else archive.clear();
      network.reply(
        "/api/operations?q=private-query&offset=0&limit=50",
        operationIndex("recovery:private-index"),
      );
      network.reply(
        "/api/operations/recovery%3Aprivate-pending?offset=0",
        detail("recovery:private-pending"),
      );
      await Promise.all([index, pending]);
      expect(get(archive)).toMatchObject({
        phase: "login",
        operations: { index: null, detail: null, selectedId: null, query: "" },
      });
      expect(JSON.stringify(get(archive))).not.toContain("private-");
    },
  );

  it("enters an operations deep link after sign-in without reading capture bodies", async () => {
    const paths: string[] = [];
    const archive = createArchive(async (path) => {
      paths.push(path);
      if (path === "/api/session")
        return Response.json({ authenticated: true });
      return Response.json(
        path.includes("?q=")
          ? operationIndex("recovery:deep")
          : detail("recovery:deep"),
      );
    });
    await archive.login("synthetic-viewer-token", {
      operationId: "recovery:deep",
    });
    expect(paths).toEqual([
      "/api/session",
      "/api/operations?q=&offset=0&limit=50",
      "/api/operations/recovery%3Adeep?offset=0",
    ]);
    expect(get(archive).operations.selectedId).toBe("recovery:deep");
    expect(get(archive).phase).toBe("ready");
  });

  it("expires the shared session on an operations 401 and keeps failed response bodies private", async () => {
    const archive = createArchive(async () =>
      Response.json({ error: "private-error" }, { status: 401 }),
    );
    await archive.selectOperation("recovery:private");
    expect(get(archive).phase).toBe("login");
    expect(get(archive).operations.detail).toBeNull();
    expect(JSON.stringify(get(archive))).not.toContain("private-error");
  });
});
