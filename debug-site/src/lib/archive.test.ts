import * as webauthn from "@simplewebauthn/browser";
import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArchive } from "./archive.js";

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
