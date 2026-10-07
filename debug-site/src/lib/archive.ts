import {
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { writable } from "svelte/store";
import {
  type OperationFilters,
  operationsPath,
  type Route,
  sameFilters,
} from "./route.js";
import type {
  DebugSnapshot,
  DiagnosticIndex,
  IssueIndex,
  OperationDetail,
  OperationEvent,
  OperationIndex,
  PasskeySummary,
} from "./types.js";

export type ListError = "failed" | null;
export interface OperationsState extends OperationFilters {
  index: OperationIndex | null;
  /** Latest archived controller event from any validated index read. */
  controller: OperationEvent | null | undefined;
  detail: OperationDetail | null;
  selectedId: string | null;
  eventOffset: number;
  indexBusy: boolean;
  detailBusy: boolean;
  indexError: ListError;
  detailError: "missing" | "failed" | null;
}
export interface Section<T> {
  data: T | null;
  busy: boolean;
  error: ListError;
}
export interface OverviewState {
  captures: Section<DiagnosticIndex>;
  failures: Section<OperationIndex>;
  deployments: Section<OperationIndex>;
  amp: Section<OperationIndex>;
  controller: OperationEvent | null | undefined;
}
type OverviewName = Exclude<keyof OverviewState, "controller">;
/** Operations whose retained metadata contains a capture ID. */
export interface CaptureLinks {
  id: string | null;
  index: OperationIndex | null;
  busy: boolean;
  error: boolean;
}

const overviewReads: Record<
  Exclude<OverviewName, "captures">,
  OperationFilters
> = {
  failures: {
    scope: "errors",
    query: "",
    source: "",
    failureKey: "",
    offset: 0,
  },
  deployments: {
    scope: "deployments",
    query: "",
    source: "",
    failureKey: "",
    offset: 0,
  },
  amp: { scope: "amp", query: "", source: "", failureKey: "", offset: 0 },
};
export const OVERVIEW_ROWS = 8;
const section = <T>(): Section<T> => ({ data: null, busy: false, error: null });

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
  issues: IssueIndex | null;
  issuesSource: string | null;
  issuesBusy: boolean;
  issuesError: boolean;
  indexError: boolean;
  captureError: "missing" | "failed" | null;
  notice: string;
  loginError: string;
  actionError: string;
  operations: OperationsState;
  overview: OverviewState;
  captureLinks: CaptureLinks;
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
  issues: null,
  issuesSource: null,
  issuesBusy: false,
  issuesError: false,
  indexError: false,
  captureError: null,
  notice: "",
  loginError: "",
  actionError: "",
  operations: {
    index: null,
    controller: undefined,
    detail: null,
    selectedId: null,
    scope: "operations",
    query: "",
    source: "",
    failureKey: "",
    offset: 0,
    eventOffset: 0,
    indexBusy: false,
    detailBusy: false,
    indexError: null,
    detailError: null,
  },
  overview: {
    captures: section(),
    failures: section(),
    deployments: section(),
    amp: section(),
    controller: undefined,
  },
  captureLinks: { id: null, index: null, busy: false, error: false },
});

function validIndex(value: unknown): OperationIndex {
  const index = value as OperationIndex | null;
  if (
    !index ||
    !Array.isArray(index.items) ||
    !Number.isSafeInteger(index.total)
  )
    throw new HttpError(0);
  return index;
}

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
  let operationsSequence = 0;
  let operationSequence = 0;
  let linksSequence = 0;
  const overviewSequence: Record<OverviewName, number> = {
    captures: 0,
    failures: 0,
    deployments: 0,
    amp: 0,
  };
  let issueSequence = 0;
  function patch(update: Partial<ArchiveState>) {
    state = { ...state, ...update };
    store.set(state);
  }
  function patchOperations(update: Partial<OperationsState>) {
    patch({ operations: { ...state.operations, ...update } });
  }
  function patchSection(
    name: OverviewName,
    value: Section<DiagnosticIndex | OperationIndex>,
    controller = state.overview.controller,
  ) {
    patch({
      overview: {
        ...state.overview,
        [name]: value,
        controller,
      } as OverviewState,
    });
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
  async function loadIssues(source = "") {
    const generation = epoch;
    const sequence = ++issueSequence;
    patch({
      issues: null,
      issuesSource: source,
      issuesBusy: true,
      issuesError: false,
    });
    try {
      const issues = (await (
        await request(
          `/api/issues${source ? `?${new URLSearchParams({ source })}` : ""}`,
          generation,
        )
      ).json()) as IssueIndex;
      if (
        !Array.isArray(issues.items) ||
        !Array.isArray(issues.pending) ||
        typeof issues.enabled !== "boolean"
      )
        throw new HttpError(0);
      if (generation === epoch && sequence === issueSequence)
        patch({ issues, issuesBusy: false });
    } catch {
      if (generation === epoch && sequence === issueSequence)
        patch({ issuesError: true, issuesBusy: false });
    }
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
  async function select(id: string) {
    const generation = epoch;
    const sequence = ++captureSequence;
    patch({
      selectedId: id,
      snapshot: state.selectedId === id ? state.snapshot : null,
      captureBusy: true,
      captureError: null,
      actionError: "",
    });
    try {
      const snapshot = (await (
        await request(`/api/snapshots/${encodeURIComponent(id)}`, generation)
      ).json()) as DebugSnapshot;
      if (
        snapshot?.id !== id ||
        !Array.isArray(snapshot.scope) ||
        !Array.isArray(snapshot.exclusions)
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
  async function searchOperations({
    scope = "operations",
    query = "",
    source = "",
    failureKey = "",
    offset = 0,
  }: Partial<OperationFilters> = {}) {
    const generation = epoch;
    const sequence = ++operationsSequence;
    const filters = { scope, query, source, failureKey, offset };
    patchOperations({
      ...filters,
      indexBusy: true,
      indexError: null,
      index: null,
    });
    try {
      const index = validIndex(
        await (await request(operationsPath(filters), generation)).json(),
      );
      if (generation === epoch && sequence === operationsSequence) {
        patchOperations({
          index,
          indexError: null,
          controller: index.controller ?? null,
          indexBusy: false,
        });
      }
    } catch {
      if (generation === epoch && sequence === operationsSequence)
        patchOperations({ indexError: "failed", indexBusy: false });
    }
  }
  async function loadOverviewSection(name: OverviewName) {
    const generation = epoch;
    const sequence = ++overviewSequence[name];
    const current = () =>
      generation === epoch && sequence === overviewSequence[name];
    patchSection(name, { data: null, busy: true, error: null });
    try {
      if (name === "captures") {
        const data = (await (
          await request("/api/snapshots?q=&offset=0", generation)
        ).json()) as DiagnosticIndex;
        if (!Array.isArray(data?.items) || !Number.isSafeInteger(data.total))
          throw new HttpError(0);
        if (current()) patchSection(name, { data, busy: false, error: null });
        return;
      }
      const filters = overviewReads[name];
      const index = validIndex(
        await (
          await request(operationsPath(filters, OVERVIEW_ROWS), generation)
        ).json(),
      );
      if (!current()) return;
      const previous = state.overview.controller;
      const controller =
        previous &&
        (!index.controller || previous.observedAt > index.controller.observedAt)
          ? previous
          : (index.controller ?? null);
      patchSection(name, { data: index, busy: false, error: null }, controller);
    } catch {
      if (current())
        patchSection(name, { data: null, busy: false, error: "failed" });
    }
  }
  /** Parallel, independently retryable reads; one expiry clears them all. */
  async function loadOverview(force = false, only?: OverviewName) {
    const names = (["captures", "failures", "deployments", "amp"] as const)
      .filter((name) => only === undefined || name === only)
      .filter(
        (name) =>
          force ||
          (state.overview[name].data === null && !state.overview[name].busy),
      );
    await Promise.all(names.map(loadOverviewSection));
  }
  async function loadCaptureLinks(id: string) {
    const generation = epoch;
    const sequence = ++linksSequence;
    patch({ captureLinks: { id, index: null, busy: true, error: false } });
    try {
      const params = new URLSearchParams({ q: id, offset: "0", limit: "20" });
      const index = validIndex(
        await (await request(`/api/operations?${params}`, generation)).json(),
      );
      if (generation === epoch && sequence === linksSequence)
        patch({ captureLinks: { id, index, busy: false, error: false } });
    } catch {
      if (generation === epoch && sequence === linksSequence)
        patch({ captureLinks: { id, index: null, busy: false, error: true } });
    }
  }
  /**
   * Loads what a route needs. Navigation between already-loaded states does
   * not refetch; `force` is the explicit read-only refresh.
   */
  async function open(route: Route, force = false) {
    const reads: Promise<void>[] = [];
    if (route.view === "issues" || route.view === "capture") {
      const source = route.view === "capture" ? `debug:${route.id}` : "";
      if (
        force ||
        state.issuesSource !== source ||
        (!state.issues && !state.issuesBusy)
      )
        reads.push(loadIssues(source));
    }
    if (route.view === "overview") reads.push(loadOverview(force));
    else if (route.view === "captures") {
      if (
        force ||
        state.query !== route.query ||
        state.offset !== route.offset ||
        (!state.index && !state.indexBusy)
      )
        reads.push(search(route.query, route.offset));
    } else if (route.view === "capture") {
      if (
        force ||
        state.selectedId !== route.id ||
        (!state.snapshot && !state.captureBusy)
      )
        reads.push(select(route.id));
      if (force || state.captureLinks.id !== route.id)
        reads.push(loadCaptureLinks(route.id));
    } else if (route.view === "operations") {
      const operations = state.operations;
      if (
        force ||
        !sameFilters(operations, route) ||
        (!operations.index && !operations.indexBusy)
      )
        reads.push(searchOperations(route));
      if (
        force ||
        operations.selectedId !== route.id ||
        (route.id !== null && !operations.detail && !operations.detailBusy)
      )
        reads.push(
          selectOperation(
            route.id,
            force && operations.selectedId === route.id
              ? operations.eventOffset
              : 0,
          ),
        );
    }
    await Promise.all(reads);
  }
  async function selectOperation(id: string | null, offset = 0) {
    const generation = epoch;
    const sequence = ++operationSequence;
    patchOperations({
      selectedId: id,
      detail: null,
      eventOffset: offset,
      detailBusy: id !== null,
      detailError: null,
    });
    if (id === null) return;
    try {
      const detail = (await (
        await request(
          `/api/operations/${encodeURIComponent(id)}?offset=${offset}`,
          generation,
        )
      ).json()) as OperationDetail;
      if (
        detail.operation?.latest.operationId !== id ||
        !Array.isArray(detail.events) ||
        !Array.isArray(detail.related) ||
        !Number.isSafeInteger(detail.totalEvents)
      )
        throw new HttpError(0);
      if (generation === epoch && sequence === operationSequence)
        patchOperations({ detail, detailBusy: false });
    } catch (error) {
      if (generation === epoch && sequence === operationSequence)
        patchOperations({
          detailError:
            error instanceof HttpError && error.status === 404
              ? "missing"
              : "failed",
          detailBusy: false,
        });
    }
  }
  async function enter(destination: Route) {
    patch({ phase: "ready", loginBusy: false, loginError: "", notice: "" });
    await open(destination);
  }
  async function start(destination: Route) {
    clear("checking");
    const generation = epoch;
    try {
      const session = (await (
        await request("/api/session", generation)
      ).json()) as { authenticated: boolean };
      if (generation !== epoch) return;
      if (session.authenticated === true) await enter(destination);
      else clear("login");
    } catch {
      if (generation === epoch) patch({ phase: "error" });
    }
  }
  async function login(token: string, destination: Route) {
    clear("login");
    const generation = epoch;
    patch({ loginBusy: true });
    try {
      await request("/api/session", generation, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (generation === epoch) await enter(destination);
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
          notice:
            "Signed out. Private archive data has been cleared from this page.",
        });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return;
      if (generation === epoch)
        patch({
          loginBusy: false,
          notice: "",
          actionError:
            "Private archive data is cleared, but sign-out could not be confirmed. Retry sign out.",
        });
    }
  }
  async function loginWithPasskey(destination: Route) {
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
      if (generation === epoch) await enter(destination);
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
    open,
    select,
    search,
    searchOperations,
    selectOperation,
    retryOverview: (name: OverviewName) => loadOverview(true, name),
    retryCaptureLinks: loadCaptureLinks,
    loadIssues,
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
