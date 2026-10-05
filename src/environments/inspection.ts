import { createHash } from "node:crypto";
import type { EnvironmentService } from "./service.js";

export const workerFingerprint = (owner: string) =>
  createHash("sha256").update(owner).digest("hex").slice(0, 32);

export interface SandboxInfo {
  id: string;
  worker: string;
  state: string;
  running: boolean;
  image: string;
  cpus: number;
  memoryMib: number;
  createdAt: string;
  startedAt: string | null;
  outbound: "enabled" | "disabled" | "unknown";
}

export interface SandboxActivity {
  sequence: number;
  at: string;
  worker: string;
  kind:
    | "opening"
    | "command_completed"
    | "command_failed"
    | "stopped"
    | "cleanup_unknown"
    | "destroyed";
  exitCode?: number;
  code?: string;
}

export interface SandboxSnapshot {
  version: 1;
  observedAt: string;
  revision: string | null;
  status: "enabled" | "disabled" | "unavailable";
  provider: "boxlite";
  limits: {
    active: number;
    retained: number;
    commandSeconds: number;
    outputBytes: number;
  };
  boxes: SandboxInfo[];
  leases: {
    worker: string;
    state: "active" | "executing" | "stopping" | "needs_review";
  }[];
  activity: SandboxActivity[];
  activitySince: string;
}

export async function inspectSandboxes(
  service: EnvironmentService | undefined,
  revision?: string,
): Promise<SandboxSnapshot> {
  const base = {
    version: 1 as const,
    observedAt: new Date().toISOString(),
    revision: revision ?? null,
    provider: "boxlite" as const,
    limits: { active: 4, retained: 128, commandSeconds: 30, outputBytes: 8000 },
    boxes: [],
    leases: [],
    activity: [],
    activitySince: new Date().toISOString(),
  };
  if (!service) return { ...base, status: "disabled" };
  try {
    return { ...base, ...(await service.inspect()), status: "enabled" };
  } catch {
    return { ...base, status: "unavailable" };
  }
}

export const SANDBOX_INSPECTION_KNOWLEDGE = `The independent private sandbox dashboard at https://sandboxes.raygen.dev observes BoxLite without creating, waking, stopping or deleting VMs. Authorized owner-private execution workers can call inspection:"sandboxes" (empty text, no other action) for the same bounded metadata; interaction agents delegate that inspection. Automated turns without inspection grants cannot query it. Disabled means the provider is not active, not that retained disks do not exist. Unavailable means observations failed, never zero inventory. Allocations are not measured CPU/RAM usage. Activity is at most 200 metadata-only events since the current June process started, not durable logs or complete history; commands/output, files, host paths and secrets are excluded. Dashboard reads never use BoxLite metrics because that SDK method may start stopped compute. Browser refresh is read-only and sends no notifications; June must not duplicate polling, cleanup, retries or operator recovery. SDK state is an observation, not verified teardown. Existing worker grants, crash fences, approvals and lifecycle ownership remain unchanged. The dashboard has separate browser sign-in; never disclose credentials or infer activation/readiness from its URL.`;
