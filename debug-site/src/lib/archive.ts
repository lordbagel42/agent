import {
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { writable } from "svelte/store";
import type {
  DebugSnapshot,
  DiagnosticIndex,
  PasskeySummary,
} from "./types.js";

export interface ArchiveState {
  phase: "checking" | "login" | "ready" | "error";
  index: DiagnosticIndex | null;
  snapshot: DebugSnapshot | null;
  selectedId: string | null;
  query: string;
  offset: number;
  indexBusy: boolean;
  captureBusy: boolean;
  loginBusy: boolean;
  downloadBusy: boolean;
  passkeys: PasskeySummary[] | null;
  passkeyBusy: boolean;
  passkeyError: string;
  passkeyNotice: string;
  indexError: boolean;
  captureError: "missing" | "failed" | null;
  notice: string;
  loginError: string;
  actionError: string;
}

const initial = (): ArchiveState => ({
  phase: "checking",
  index: null,
  snapshot: null,
  selectedId: null,
  query: "",
  offset: 0,
  indexBusy: false,
  captureBusy: false,
  loginBusy: false,
  downloadBusy: false,
  passkeys: null,
  passkeyBusy: false,
  passkeyError: "",
  passkeyNotice: "",
  indexError: false,
  captureError: null,
  notice: "",
  loginError: "",
  actionError: "",
});

class HttpError extends Error {
  constructor(readonly status: number) {
    super("Archive request failed");
  }
}

function passkeyError(error: unknown) {
  if (error instanceof HttpError) {
    if (error.status === 426)
      return "Secure sign-in requires a current browser with Web Locks support. Update your browser and try again.";
    if (error.status === 403)
      return "Sign in again before changing passkeys. A sign-in within the last five minutes is required.";
    if (error.status === 429)
      return "Too many attempts. Wait a minute and try again.";
    if (error.status === 409)
      return "That passkey is already registered, or the 16-passkey limit has been reached.";
  }
  if (
    error instanceof Error &&
    ["NotAllowedError", "AbortError"].includes(error.name)
  )
    return "The passkey prompt was cancelled or timed out. Try again, or use your viewer credential.";
  if (error instanceof Error && error.name === "InvalidStateError")
    return "This device already has a passkey for June Debug. Use another device or password manager.";
  return "The passkey could not be verified. Try again, or use your viewer credential.";
}

/** In-memory only. Session changes invalidate every outstanding evidence read. */
export function createArchive(
  fetcher: (path: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  let state = initial();
  const store = writable(state);
  let epoch = 0;
  let indexSequence = 0;
  let captureSequence = 0;
  function patch(update: Partial<ArchiveState>) {
    state = { ...state, ...update };
    store.set(state);
  }
  function clear(phase: ArchiveState["phase"], notice = "") {
    epoch++;
    WebAuthnAbortService.cancelCeremony();
    state = { ...initial(), phase, notice };
    store.set(state);
  }
  async function request(
    path: string,
    generation: number,
    init: RequestInit = {},
  ) {
    if (generation !== epoch) throw new HttpError(0);
    const send = () => {
      if (generation !== epoch) throw new HttpError(0);
      return fetcher(path, {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    };
    let response: Response;
    if (init.method === "POST" && typeof window !== "undefined") {
      // All POSTs change authentication state. Serialize their response cookies
      // across tabs, including the very first browser identity and logout.
      // Device prompts and evidence reads do not hold this lock.
      if (!navigator.locks) throw new HttpError(426);
      response = await navigator.locks.request("june-debug-auth", send);
    } else response = await send();
    if (response.status === 401 && generation === epoch) {
      clear(
        "login",
        "Your session expired. Sign in again to view the private archive.",
      );
    }
    if (!response.ok) throw new HttpError(response.status);
    return response;
  }
  async function search(query: string, offset = 0) {
    const generation = epoch;
    const sequence = ++indexSequence;
    patch({ query, offset, indexBusy: true, indexError: false, index: null });
    try {
      const index = (await (
        await request(
          `/api/snapshots?${new URLSearchParams({ q: query, offset: String(offset) })}`,
          generation,
        )
      ).json()) as DiagnosticIndex;
      if (!Array.isArray(index.items) || !Number.isSafeInteger(index.total))
        throw new HttpError(0);
      if (generation === epoch && sequence === indexSequence)
        patch({ index, indexBusy: false });
    } catch {
      if (generation === epoch && sequence === indexSequence)
        patch({ indexError: true, indexBusy: false });
    }
  }
  async function select(id: string | null) {
    const generation = epoch;
    const sequence = ++captureSequence;
    patch({
      selectedId: id,
      snapshot: null,
      captureBusy: true,
      captureError: null,
      actionError: "",
    });
    try {
      if (id === null) {
        const index = (await (
          await request("/api/snapshots?q=&offset=0", generation)
        ).json()) as DiagnosticIndex;
        id = index.items[0]?.id ?? null;
      }
      const snapshot =
        id === null
          ? null
          : ((await (
              await request(
                `/api/snapshots/${encodeURIComponent(id)}`,
                generation,
              )
            ).json()) as DebugSnapshot);
      if (
        snapshot &&
        (snapshot.id !== id ||
          !Array.isArray(snapshot.scope) ||
          !Array.isArray(snapshot.exclusions))
      )
        throw new HttpError(0);
      if (generation === epoch && sequence === captureSequence)
        patch({ snapshot, selectedId: id, captureBusy: false });
    } catch (error) {
      if (generation === epoch && sequence === captureSequence)
        patch({
          captureError:
            error instanceof HttpError && error.status === 404
              ? "missing"
              : "failed",
          captureBusy: false,
        });
    }
  }
  async function enter(id: string | null) {
    patch({ phase: "ready", loginBusy: false, loginError: "", notice: "" });
    await Promise.all([search(""), select(id)]);
  }
  async function start(id: string | null) {
    clear("checking");
    const generation = epoch;
    try {
      const session = (await (
        await request("/api/session", generation)
      ).json()) as { authenticated: boolean };
      if (generation !== epoch) return;
      if (session.authenticated === true) await enter(id);
      else clear("login");
    } catch {
      if (generation === epoch) patch({ phase: "error" });
    }
  }
  async function login(token: string, id: string | null) {
    clear("login");
    const generation = epoch;
    patch({ loginBusy: true });
    try {
      await request("/api/session", generation, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (generation === epoch) await enter(id);
    } catch (error) {
      // An unauthorized login intentionally clears the epoch in request().
      if (
        generation === epoch ||
        (generation + 1 === epoch && state.phase === "login")
      ) {
        patch({
          loginBusy: false,
          notice: "",
          loginError:
            error instanceof HttpError && error.status === 426
              ? passkeyError(error)
              : error instanceof HttpError && [401, 403].includes(error.status)
                ? "That viewer credential was not accepted. Check it and try again."
                : "Sign-in is unavailable. Try again.",
        });
      }
    }
  }
  async function logout() {
    clear("login", "Signing out…");
    const generation = epoch;
    patch({ loginBusy: true });
    try {
      await request("/api/logout", generation, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (generation === epoch)
        patch({
          loginBusy: false,
          notice: "Signed out. Captured data has been cleared from this page.",
        });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return;
      if (generation === epoch)
        patch({
          loginBusy: false,
          notice: "",
          actionError:
            "Captured data is cleared, but sign-out could not be confirmed. Retry sign out.",
        });
    }
  }
  async function loginWithPasskey(id: string | null) {
    clear("login");
    const generation = epoch;
    patch({ loginBusy: true });
    try {
      const optionsJSON = await (
        await request("/api/passkeys/login/options", generation, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).json();
      if (generation !== epoch) return;
      const response = await startAuthentication({ optionsJSON });
      await request("/api/passkeys/login/verify", generation, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response),
      });
      if (generation === epoch) await enter(id);
    } catch (error) {
      if (generation === epoch)
        patch({ loginBusy: false, loginError: passkeyError(error) });
    }
  }
  async function loadPasskeys() {
    const generation = epoch;
    patch({ passkeyBusy: true, passkeyError: "" });
    try {
      const result = (await (
        await request("/api/passkeys", generation)
      ).json()) as { items: PasskeySummary[] };
      if (generation === epoch) patch({ passkeys: result.items });
    } catch {
      if (generation === epoch)
        patch({ passkeyError: "Passkeys could not be loaded. Try again." });
    } finally {
      if (generation === epoch) patch({ passkeyBusy: false });
    }
  }
  async function addPasskey(name: string) {
    if (state.passkeyBusy) return;
    const generation = epoch;
    patch({ passkeyBusy: true, passkeyError: "", passkeyNotice: "" });
    try {
      const optionsJSON = await (
        await request("/api/passkeys/register/options", generation, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).json();
      if (generation !== epoch) return;
      const response = await startRegistration({ optionsJSON });
      await request("/api/passkeys/register/verify", generation, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, response }),
      });
      if (generation === epoch) {
        patch({
          passkeyNotice:
            "Passkey added. You can use it the next time you sign in.",
        });
        await loadPasskeys();
      }
    } catch (error) {
      if (generation === epoch) patch({ passkeyError: passkeyError(error) });
    } finally {
      if (generation === epoch) patch({ passkeyBusy: false });
    }
  }
  async function removePasskey(id: string) {
    if (state.passkeyBusy) return;
    const generation = epoch;
    patch({ passkeyBusy: true, passkeyError: "", passkeyNotice: "" });
    try {
      await request(
        `/api/passkeys/${encodeURIComponent(id)}/delete`,
        generation,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (generation === epoch)
        clear(
          "login",
          "Passkey removed. All devices have been signed out. Use a remaining passkey or your viewer credential.",
        );
    } catch (error) {
      if (generation === epoch) patch({ passkeyError: passkeyError(error) });
    } finally {
      if (generation === epoch) patch({ passkeyBusy: false });
    }
  }
  async function download() {
    const id = state.snapshot?.id;
    if (!id || state.downloadBusy) return null;
    const generation = epoch;
    patch({ downloadBusy: true, actionError: "" });
    try {
      const response = await request(
        `/api/snapshots/${encodeURIComponent(id)}/download`,
        generation,
      );
      const blob = await response.blob();
      return generation === epoch ? { blob, id } : null;
    } catch {
      if (generation === epoch)
        patch({
          actionError: "Export could not be downloaded. Try Export JSON again.",
        });
      return null;
    } finally {
      if (generation === epoch) patch({ downloadBusy: false });
    }
  }
  return {
    subscribe: store.subscribe,
    start,
    select,
    search,
    login,
    loginWithPasskey,
    loadPasskeys,
    addPasskey,
    removePasskey,
    logout,
    download,
    clear: () => clear("login"),
  };
}
