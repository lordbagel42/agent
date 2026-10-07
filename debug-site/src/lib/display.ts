import { type Route, routeHref } from "./route.js";
import type { OperationEvent } from "./types.js";

export const sourceLabel: Record<OperationEvent["source"], string> = {
  controller: "Controller",
  deployment: "Deployment",
  recovery: "Recovery",
  debugshare: "DEBUGSHARE",
  "amp-task": "Owner Amp task",
  coding: "Coding",
};
export const ampSources: ReadonlySet<string> = new Set([
  "debugshare",
  "amp-task",
  "coding",
]);
export const statusLabel = (status: string) => status.replaceAll("_", " ");

const attention = new Set([
  "unknown",
  "blocked",
  "needs_review",
  "awaiting_approval",
  "fetch_failed",
  "deferred",
]);
/** Recorded state only. No status is ever presented as current health. */
export function tone(event: Pick<OperationEvent, "failure" | "status">) {
  return event.failure
    ? "danger"
    : attention.has(event.status)
      ? "warn"
      : "neutral";
}
const terminal = new Set([
  "completed",
  "reconciled",
  "failed",
  "rolled_back",
  "superseded",
]);
export const outcomeLabel = (event: OperationEvent) =>
  terminal.has(event.status) ? "Recorded outcome" : "Latest recorded state";

export const threadHref = (id: string) =>
  `https://ampcode.com/threads/${encodeURIComponent(id)}`;
/** Only a full 40-character revision becomes a June repository commit link. */
export const commitHref = (revision: string | null | undefined) =>
  revision && /^[a-f0-9]{40}$/.test(revision)
    ? `https://github.com/lordbagel42/agent/commit/${revision}`
    : null;

export function age(now: number, at: number) {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 0) return "ahead of this browser’s clock";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const kilobytes = (bytes: number) =>
  `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;

/** Modified and non-primary clicks keep native browser behavior. */
export function link(route: Route, navigate: (route: Route) => void) {
  return {
    href: routeHref(route),
    onclick: (event: MouseEvent) => {
      if (
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      navigate(route);
    },
  };
}
