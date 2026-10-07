import type { OperationEvent } from "./types.js";

export type OperationSource = OperationEvent["source"];
export type OperationScope = "operations" | "deployments" | "errors" | "amp";
export type CapturePage = "evidence" | "conversation";
export interface OperationFilters {
  scope: OperationScope;
  query: string;
  source: OperationSource | "";
  failureKey: string;
  offset: number;
}
export type OperationRoute = OperationFilters & {
  view: "operations";
  id: string | null;
};
/** The URL is the only navigation state; API state never writes it back. */
export type Route =
  | { view: "overview" }
  | { view: "issues" }
  | { view: "captures"; query: string; offset: number }
  | { view: "capture"; id: string; page: CapturePage }
  | OperationRoute;

const archived: OperationSource[] = [
  "deployment",
  "recovery",
  "debugshare",
  "amp-task",
  "coding",
];
/** Controller observations are never index rows; they arrive as `controller`. */
export const scopeSources: Record<OperationScope, OperationSource[]> = {
  operations: archived,
  deployments: ["deployment", "recovery"],
  errors: archived,
  amp: ["debugshare", "amp-task", "coding"],
};
const scopes = new Set<string>(["deployments", "errors", "amp"]);

function offset(value: string | null) {
  const parsed = value && /^\d{1,15}$/.test(value) ? Number(value) : 0;
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  if (pathname === "/issues" || pathname === "/issues/")
    return { view: "issues" };
  const capture = /^\/s\/([^/]+)(\/conversation)?\/?$/.exec(pathname);
  if (capture?.[1]) {
    let id: string;
    try {
      id = decodeURIComponent(capture[1]);
    } catch {
      id = "invalid-capture-id";
    }
    return {
      view: "capture",
      id,
      page: capture[2] ? "conversation" : "evidence",
    };
  }
  if (pathname === "/operations" || pathname === "/operations/") {
    const view = params.get("view") ?? "";
    const scope = (scopes.has(view) ? view : "operations") as OperationScope;
    const source = params.get("source") ?? "";
    return {
      view: "operations",
      scope,
      id: params.get("id")?.slice(0, 200) || null,
      query: (params.get("q") ?? "").slice(0, 512),
      source: scopeSources[scope].includes(source as OperationSource)
        ? (source as OperationSource)
        : "",
      failureKey: (params.get("signature") ?? "").slice(0, 250),
      offset: offset(params.get("offset")),
    };
  }
  if (params.get("view") === "captures")
    return {
      view: "captures",
      query: (params.get("q") ?? "").slice(0, 512),
      offset: offset(params.get("offset")),
    };
  return { view: "overview" };
}

export function routeHref(route: Route): string {
  if (route.view === "overview") return "/";
  if (route.view === "issues") return "/issues";
  if (route.view === "capture")
    return `/s/${encodeURIComponent(route.id)}${route.page === "conversation" ? "/conversation" : ""}`;
  const params = new URLSearchParams();
  if (route.view === "captures") {
    params.set("view", "captures");
    if (route.query) params.set("q", route.query);
    if (route.offset) params.set("offset", String(route.offset));
    return `/?${params}`;
  }
  if (route.scope !== "operations") params.set("view", route.scope);
  if (route.query) params.set("q", route.query);
  if (route.source) params.set("source", route.source);
  if (route.failureKey) params.set("signature", route.failureKey);
  if (route.offset) params.set("offset", String(route.offset));
  if (route.id) params.set("id", route.id);
  const query = params.toString();
  return query ? `/operations?${query}` : "/operations";
}

export function operationRoute(
  scope: OperationScope,
  update: Partial<Omit<OperationRoute, "view" | "scope">> = {},
): OperationRoute {
  return {
    id: null,
    query: "",
    source: "",
    failureKey: "",
    offset: 0,
    ...update,
    view: "operations",
    scope,
  };
}

/** Sources the server must apply for this list, or null for every source. */
export function requestedSources(filters: OperationFilters) {
  const allowed = scopeSources[filters.scope];
  if (filters.source && allowed.includes(filters.source))
    return [filters.source];
  return allowed === archived ? null : allowed;
}

/**
 * Workspace filters are applied by the server before pagination. A single
 * source uses the original `source` parameter; multi-source workspaces and
 * Errors need the `sources` and `failuresOnly` parameters.
 */
export function operationsPath(filters: OperationFilters, limit = 50) {
  const params = new URLSearchParams({ q: filters.query });
  const sources = requestedSources(filters);
  if (sources?.length === 1 && sources[0]) params.set("source", sources[0]);
  else if (sources) params.set("sources", sources.join(","));
  if (filters.scope === "errors") params.set("failuresOnly", "true");
  if (filters.failureKey) params.set("failureKey", filters.failureKey);
  params.set("offset", String(filters.offset));
  params.set("limit", String(limit));
  return `/api/operations?${params}`;
}

export function sameFilters(a: OperationFilters, b: OperationFilters) {
  return (
    a.scope === b.scope &&
    a.query === b.query &&
    a.source === b.source &&
    a.failureKey === b.failureKey &&
    a.offset === b.offset
  );
}
