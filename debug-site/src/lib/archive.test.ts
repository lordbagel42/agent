import * as webauthn from "@simplewebauthn/browser";
import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArchive } from "./archive.js";
import type { OperationRoute, OperationScope, Route } from "./route.js";
import type {
  OperationDetail,
  OperationEvent,
  OperationSummary,
} from "./types.js";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const overview: Route = { view: "overview" };
const capture = (id: string): Route => ({
  view: "capture",
  id,
  page: "evidence",
});
const operations = (
  scope: OperationScope,
  update: Partial<OperationRoute> = {},
): OperationRoute => ({
  view: "operations",
  scope,
  id: null,
  query: "",
  source: "",
  failureKey: "",
  offset: 0,
  ...update,
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
  it("fences issue metadata by selection and session, including late responses after expiry", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const first = archive.loadIssues("debug:first");
    const latest = archive.loadIssues("debug:latest");
    network.reply("/api/issues?source=debug%3Alatest", {
      enabled: true,
      items: [{ number: 37 }],
      total: 1,
      pending: [],
    });
    await latest;
    network.reply("/api/issues?source=debug%3Afirst", {
      enabled: true,
      items: [{ number: 12 }],
      total: 1,
      pending: [],
    });
    await first;
    expect(get(archive).issues?.items[0]?.number).toBe(37);
    const pending = archive.loadIssues();
    const expired = archive.search("");
    network.reply("/api/snapshots?q=&offset=0", {}, 401);
    await expired;
    network.reply("/api/issues", {
      enabled: true,
      items: [{ title: "private issue" }],
      total: 1,
      pending: [],
    });
    await pending;
    expect(get(archive).phase).toBe("login");
    expect(get(archive).issues).toBeNull();
    expect(JSON.stringify(get(archive))).not.toContain("private issue");
  });

  it("restores the Issues route after sign-in and reloads metadata when switching between the index and a capture", async () => {
    const paths: string[] = [];
    const archive = createArchive(async (path) => {
      paths.push(path);
      if (path === "/api/session")
        return Response.json({ authenticated: true });
      if (path.startsWith("/api/issues"))
        return Response.json({
          enabled: true,
          items: [{ number: path.includes("source=") ? 37 : 42 }],
          total: 1,
          pending: [],
        });
      if (path.startsWith("/api/operations"))
        return Response.json(operationIndex("debugshare:linked"));
      return Response.json(snapshot("linked"));
    });
    const issues: Route = { view: "issues" };
    await archive.start(issues);
    expect(paths).toEqual(["/api/session", "/api/issues"]);
    expect(get(archive).issues?.items[0]?.number).toBe(42);
    paths.length = 0;
    await archive.open(capture("linked"));
    expect(paths).toContain("/api/issues?source=debug%3Alinked");
    expect(get(archive).issues?.items[0]?.number).toBe(37);
    paths.length = 0;
    await archive.open(capture("linked"));
    expect(paths).toEqual([]);
    await archive.open(issues);
    expect(paths).toEqual(["/api/issues"]);
    expect(get(archive).issues?.items[0]?.number).toBe(42);
    paths.length = 0;
    await archive.open(issues);
    expect(paths).toEqual([]);
    await archive.open(issues, true);
    expect(paths).toEqual(["/api/issues"]);
    paths.length = 0;
    await archive.login("synthetic-viewer-token", issues);
    expect(paths).toEqual(["/api/session", "/api/issues"]);
    expect(get(archive).phase).toBe("ready");
    archive.clear();
    expect(get(archive).issues).toBeNull();
  });

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

  it("keeps the selected capture mounted during refresh but clears it when the selection changes", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const first = archive.select("retained");
    network.reply(
      "/api/snapshots/retained",
      snapshot("retained", { value: 1 }),
    );
    await first;
    const refresh = archive.select("retained");
    expect(get(archive)).toMatchObject({
      captureBusy: true,
      snapshot: { id: "retained", data: { value: 1 } },
    });
    network.reply(
      "/api/snapshots/retained",
      snapshot("retained", { value: 2 }),
    );
    await refresh;
    expect(get(archive).snapshot?.data).toEqual({ value: 2 });
    const next = archive.select("different");
    expect(get(archive).snapshot).toBeNull();
    network.reply("/api/snapshots/different", snapshot("different"));
    await next;
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

  it("keeps recorded operation and issue links with the capture that requested them", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const first = archive.open(capture("first"));
    const second = archive.open(capture("second"));
    network.reply("/api/snapshots/second", snapshot("second"));
    network.reply(
      "/api/operations?q=second&offset=0&limit=20",
      operationIndex("debugshare:second"),
    );
    network.reply("/api/issues?source=debug%3Asecond", {
      enabled: true,
      items: [{ number: 37 }],
      total: 1,
      pending: [],
    });
    await second;
    network.reply("/api/snapshots/first", snapshot("first"));
    network.reply(
      "/api/operations?q=first&offset=0&limit=20",
      operationIndex("debugshare:first"),
    );
    network.reply("/api/issues?source=debug%3Afirst", {
      enabled: true,
      items: [{ number: 12 }],
      total: 1,
      pending: [],
    });
    await first;
    expect(get(archive).issues?.items[0]?.number).toBe(37);
    expect(get(archive).captureLinks).toMatchObject({ id: "second" });
    expect(JSON.stringify(get(archive))).not.toContain("debugshare:first");
  });

  it("sends credentials in a same-origin JSON body and distinguishes unavailable captures from server failures", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const login = archive.login("synthetic-viewer-token", overview);
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
    const login = archive.login("synthetic-viewer-token", overview);
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
    await archive.loginWithPasskey(overview);
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
    const login = archive.loginWithPasskey(capture("deep-capture"));
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
    await archive.loginWithPasskey(overview);
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

function operation(id: string, failed = false): OperationSummary {
  const latest: OperationEvent = {
    id: `${id}:1`,
    operationId: id,
    source: (id.split(":")[0] ?? "recovery") as OperationEvent["source"],
    sequence: 1,
    observedAt: 2000,
    occurredAt: null,
    status: "pending",
    failure: failed,
    phase: "readiness",
    reason: "health_failed",
  };
  return {
    latest,
    firstObservedAt: 2000,
    lastObservedAt: 2000,
    eventCount: 1,
    failure: failed ? latest : null,
    failureKey: failed ? `${latest.source}:readiness:health_failed` : null,
    matchingFailures: failed ? 1 : 0,
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
const operationIndex = (id: string, failed = false) => ({
  items: [operation(id, failed)],
  total: 1,
  nextOffset: null,
  controller: null,
});
const captureIndex = (id: string) => ({
  items: [{ ...snapshot(id), bytes: 500 }],
  total: 1,
  nextOffset: null,
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
    await archive.login(
      "synthetic-viewer-token",
      operations("operations", { id: "recovery:deep" }),
    );
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

describe("overview and workspace navigation", () => {
  const failures = "/api/operations?q=&failuresOnly=true&offset=0&limit=8";
  const deployments =
    "/api/operations?q=&sources=deployment%2Crecovery&offset=0&limit=8";
  const amp =
    "/api/operations?q=&sources=debugshare%2Camp-task%2Ccoding&offset=0&limit=8";

  it("clears every overview pane when one parallel read expires and ignores late private successes", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const pending = archive.open(overview);
    expect(network.requests.map((request) => request.path).sort()).toEqual([
      failures,
      amp,
      deployments,
      "/api/snapshots?q=&offset=0",
    ]);
    network.reply(
      "/api/snapshots?q=&offset=0",
      captureIndex("private-capture"),
    );
    await vi.waitFor(() =>
      expect(get(archive).overview.captures.data).not.toBeNull(),
    );
    network.reply(failures, {}, 401);
    network.reply(deployments, operationIndex("deployment:private-late"));
    network.reply(amp, operationIndex("coding:private-late"));
    await pending;
    expect(get(archive)).toMatchObject({
      phase: "login",
      overview: {
        captures: { data: null },
        failures: { data: null },
        deployments: { data: null },
        amp: { data: null },
        controller: undefined,
      },
    });
    expect(JSON.stringify(get(archive))).not.toContain("private-");
  });

  it("keeps the newest controller observation when parallel overview responses arrive out of order", async () => {
    const network = transport();
    const archive = createArchive(network.fetcher);
    const pending = archive.open(overview);
    const newest = {
      ...operation("controller:newest").latest,
      observedAt: 3000,
    };
    network.reply(failures, {
      ...operationIndex("recovery:failed", true),
      controller: newest,
    });
    await vi.waitFor(() =>
      expect(get(archive).overview.controller).toEqual(newest),
    );
    network.reply(deployments, {
      ...operationIndex("deployment:older"),
      controller: { ...operation("controller:older").latest, observedAt: 1000 },
    });
    network.reply(amp, operationIndex("coding:earlier-without-controller"));
    network.reply("/api/snapshots?q=&offset=0", captureIndex("capture"));
    await pending;
    expect(get(archive).overview.controller).toEqual(newest);
  });

  it("follows an overview record into its workspace and reloads only what navigation changed", async () => {
    const paths: string[] = [];
    const archive = createArchive(async (path) => {
      paths.push(path);
      if (path.startsWith("/api/snapshots"))
        return Response.json(captureIndex("capture"));
      if (path.startsWith("/api/operations?"))
        return Response.json(
          path.includes("failuresOnly")
            ? operationIndex("recovery:failed", true)
            : operationIndex(
                path.includes("debugshare") ? "debugshare:amp" : "recovery:x",
              ),
        );
      const id = decodeURIComponent(path.split("/")[3]?.split("?")[0] ?? "");
      return Response.json(detail(id));
    });
    await archive.open(overview);
    paths.length = 0;
    const route = operations("errors", { id: "recovery:failed" });
    await archive.open(route);
    expect(paths).toEqual([
      "/api/operations?q=&failuresOnly=true&offset=0&limit=50",
      "/api/operations/recovery%3Afailed?offset=0",
    ]);
    paths.length = 0;
    // Back/Forward between already-loaded views is not an implicit refresh.
    await archive.open(overview);
    await archive.open(route);
    expect(paths).toEqual([]);
    expect(
      get(archive).overview.failures.data?.items[0]?.latest.operationId,
    ).toBe("recovery:failed");
    await archive.open({
      ...route,
      failureKey: "recovery:readiness:health_failed",
    });
    expect(paths).toEqual([
      "/api/operations?q=&failuresOnly=true&failureKey=recovery%3Areadiness%3Ahealth_failed&offset=0&limit=50",
    ]);
    expect(get(archive).operations.selectedId).toBe("recovery:failed");
    paths.length = 0;
    await archive.open(route, true);
    expect(paths).toEqual([
      "/api/operations?q=&failuresOnly=true&offset=0&limit=50",
      "/api/operations/recovery%3Afailed?offset=0",
    ]);
  });
});
