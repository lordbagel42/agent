import { writable } from "svelte/store";
import type { DebugSnapshot, DiagnosticIndex } from "./types.js";

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
    state = { ...initial(), phase, notice };
    store.set(state);
  }
  async function request(
    path: string,
    generation: number,
    init: RequestInit = {},
  ) {
    if (generation !== epoch) throw new HttpError(0);
    const response = await fetcher(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
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
            error instanceof HttpError && [401, 403].includes(error.status)
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
    logout,
    download,
    clear: () => clear("login"),
  };
}
