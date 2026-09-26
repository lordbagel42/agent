import { randomUUID } from "node:crypto";

const stages = [
  "arrival",
  "body_too_large",
  "adapter_received",
  "body_read_failed",
  "signature_rejected",
  "signature_verified",
  "payload_invalid",
  "workspace_rejected",
  "challenge_invalid",
  "challenge_answered",
  "callback_ignored",
  "normalization_ignored",
  "normalized",
  "owner_filtered",
  "owner_accepted",
  "submission_started",
  "submission_succeeded",
  "submission_failed",
] as const;

export type SlackIngressStage = (typeof stages)[number];

interface Observation {
  requestId: string;
  at: number;
  stage: SlackIngressStage;
}

export interface SlackIngressDiagnostics {
  record(request: Request, stage: SlackIngressStage): void;
  snapshot(): {
    startedAt: number;
    counts: Partial<Record<SlackIngressStage, number>>;
    recent: Observation[];
  };
}

/**
 * Process-local diagnostics, not an audit log or proof of model processing.
 * Keep the same Request object through HTTP and adapter hooks for correlation.
 * Never read its URL, headers or body: even provider IDs can carry private data.
 * Only expose snapshots through the authenticated operator API.
 */
export function createSlackIngressDiagnostics(): SlackIngressDiagnostics {
  const startedAt = Date.now();
  const requests = new WeakMap<Request, string>();
  const counts: Partial<Record<SlackIngressStage, number>> = {};
  const recent: Observation[] = [];
  return {
    record(request, stage) {
      // Enforce the allowlist at runtime too; never retain caller-provided text.
      if (!stages.includes(stage)) return;
      let requestId = requests.get(request);
      if (requestId === undefined) {
        requestId = randomUUID();
        requests.set(request, requestId);
      }
      counts[stage] = Math.min(
        Number.MAX_SAFE_INTEGER,
        (counts[stage] ?? 0) + 1,
      );
      recent.push({ requestId, at: Date.now(), stage });
      if (recent.length > 256) recent.shift();
    },
    snapshot() {
      return {
        startedAt,
        counts: { ...counts },
        recent: recent.map((entry) => ({ ...entry })),
      };
    },
  };
}
