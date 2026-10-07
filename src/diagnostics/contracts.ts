import type { DebugSnapshot } from "../runtime/session-controls.js";

/** Metadata only. The private snapshot endpoint returns DebugSnapshot itself. */
export type DiagnosticSummary = Omit<DebugSnapshot, "data" | "exclusions"> & {
  bytes: number;
};

export interface DiagnosticIndex {
  items: DiagnosticSummary[];
  total: number;
  nextOffset: number | null;
}

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Upload and issue-metadata capability; never a viewer or automation credential. */
export interface DebugSitePublisher {
  url(id: string): string;
  publish(
    snapshot: DebugSnapshot,
    investigation?: {
      phase: "unavailable" | "queued" | "running" | "unknown" | "returned";
      threadId?: string;
    },
  ): Promise<void>;
  inspectIssues?(): Promise<unknown>;
}
