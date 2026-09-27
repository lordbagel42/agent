/** Scope and provenance are supplied by trusted ingress/memory, never a model. */
export interface Evidence {
  id: string;
  scope: string;
  text: string;
  source: "episode" | "owner-correction" | "dream";
  observedAt: number;
  expiresAt: number;
  invalidated?: boolean;
  correction?: { trait: string; value: string };
}

export interface QuietHours {
  timeZone: string;
  startMinute: number;
  endMinute: number;
}

export interface Policy {
  totalCapacity: number;
  liveReserve: number;
  cooldownMs: number;
  maxNoNewEvidence: number;
  maxAttempts: number;
  evidenceMaxAgeMs: number;
  quiet: QuietHours;
}

export interface RequestInput {
  scope: string;
  evidenceIds: string[];
  kind: "curiosity" | "reflection";
}

export interface ReflectionRequest extends RequestInput {
  id: string;
  createdAt: number;
  attempts: number;
  status: "pending" | "running" | "cancelling" | "cancelled" | "stopped";
}

export interface ScopeProgress {
  scope: string;
  seenEvidenceIds: string[];
  noNewEvidence: number;
  nextEligibleAt: number;
}

export interface ReflectionState {
  version: 1;
  requests: ReflectionRequest[];
  scopes: ScopeProgress[];
}

export const initialState = (): ReflectionState => ({
  version: 1,
  requests: [],
  scopes: [],
});

function finite(value: number): void {
  if (!Number.isFinite(value)) throw new Error("Expected finite number");
}

function nonnegative(value: number): void {
  finite(value);
  if (value < 0) throw new Error("Expected nonnegative number");
}

function validatePolicy(policy: Policy): void {
  for (const value of [
    policy.totalCapacity,
    policy.liveReserve,
    policy.maxNoNewEvidence,
    policy.maxAttempts,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid capacity or attempt bound");
  }
  if (
    policy.liveReserve > policy.totalCapacity ||
    policy.maxAttempts < 1 ||
    policy.maxNoNewEvidence < 1
  )
    throw new Error("Invalid reflection policy");
  nonnegative(policy.cooldownMs);
  nonnegative(policy.evidenceMaxAgeMs);
}

/** Half-open wall-clock range. Equal endpoints disable quiet hours. Invalid zones throw (fail closed). */
export function isQuiet(now: number, quiet: QuietHours): boolean {
  finite(now);
  for (const minute of [quiet.startMinute, quiet.endMinute]) {
    if (!Number.isInteger(minute) || minute < 0 || minute >= 1440)
      throw new Error("Invalid quiet-hour minute");
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: quiet.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const minute =
    Number(parts.find((p) => p.type === "hour")?.value) * 60 +
    Number(parts.find((p) => p.type === "minute")?.value);
  const { startMinute: start, endMinute: end } = quiet;
  return start < end
    ? minute >= start && minute < end
    : start > end && (minute >= start || minute < end);
}

export function freshEvidence(
  evidence: Evidence,
  scope: string,
  now: number,
  maxAgeMs: number,
): boolean {
  return (
    Number.isFinite(now) &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    !!evidence.id.trim() &&
    evidence.scope === scope &&
    !evidence.invalidated &&
    Number.isFinite(evidence.observedAt) &&
    Number.isFinite(evidence.expiresAt) &&
    evidence.observedAt <= now &&
    evidence.expiresAt > now &&
    now - evidence.observedAt <= maxAgeMs
  );
}

/** Collision-free identity; caller may hash this canonical string for an external queue key. */
export function requestKey(input: RequestInput): string {
  if (
    !input.scope.trim() ||
    !input.evidenceIds.length ||
    input.evidenceIds.some((id) => !id.trim())
  )
    throw new Error("Scope and evidence required");
  return JSON.stringify([input.scope, [...new Set(input.evidenceIds)].sort()]);
}

export function enqueue(
  state: ReflectionState,
  input: RequestInput,
  now: number,
): { state: ReflectionState; id: string; accepted: boolean } {
  finite(now);
  const id = requestKey(input);
  if (state.requests.some((request) => request.id === id))
    return { state, id, accepted: false };
  return {
    id,
    accepted: true,
    state: {
      ...state,
      requests: [
        ...state.requests,
        {
          ...input,
          evidenceIds: [...new Set(input.evidenceIds)].sort(),
          id,
          createdAt: now,
          attempts: 0,
          status: "pending",
        },
      ],
    },
  };
}

export type ClaimReason =
  | "missing"
  | "stopped"
  | "active"
  | "capacity"
  | "quiet-hours"
  | "cooldown"
  | "stale-evidence";
export interface ClaimResult {
  state: ReflectionState;
  attempt?: number;
  reason?: ClaimReason;
}

/** Serialize claims in one owning Rivet actor and persist before invoking a provider. */
export function claim(
  state: ReflectionState,
  id: string,
  now: number,
  policy: Policy,
  evidence: Evidence[],
  liveActive: number,
): ClaimResult {
  validatePolicy(policy);
  finite(now);
  if (!Number.isSafeInteger(liveActive) || liveActive < 0)
    throw new Error("Invalid live occupancy");
  const request = state.requests.find((r) => r.id === id);
  const deny = (reason: ClaimReason): ClaimResult => ({ state, reason });
  if (!request) return deny("missing");
  if (["cancelled", "cancelling", "stopped"].includes(request.status))
    return deny("stopped");
  if (request.status === "running") return deny("active");
  if (request.attempts >= policy.maxAttempts) return deny("stopped");
  if (isQuiet(now, policy.quiet)) return deny("quiet-hours");
  const scoped = evidence.filter((e) => e.scope === request.scope);
  if (
    !request.evidenceIds.every((eid) => {
      const matches = scoped.filter((e) => e.id === eid);
      const match = matches[0];
      return (
        matches.length === 1 &&
        match !== undefined &&
        freshEvidence(match, request.scope, now, policy.evidenceMaxAgeMs)
      );
    })
  )
    return deny("stale-evidence");
  const progress = state.scopes.find((s) => s.scope === request.scope) ?? {
    scope: request.scope,
    seenEvidenceIds: [],
    noNewEvidence: 0,
    nextEligibleAt: 0,
  };
  const independent = scoped
    .filter((e) => request.evidenceIds.includes(e.id) && e.source !== "dream")
    .map((e) => e.id);
  const newEvidence = independent.some(
    (eid) => !progress.seenEvidenceIds.includes(eid),
  );
  if (!newEvidence && progress.noNewEvidence >= policy.maxNoNewEvidence)
    return deny("stopped");
  if (now < progress.nextEligibleAt) return deny("cooldown");
  const active = state.requests.filter(
    (r) => r.status === "running" || r.status === "cancelling",
  );
  if (active.some((r) => r.scope === request.scope)) return deny("active");
  if (
    active.length >=
    Math.min(
      policy.totalCapacity - policy.liveReserve,
      policy.totalCapacity - liveActive,
    )
  )
    return deny("capacity");
  const nextProgress = {
    ...progress,
    seenEvidenceIds: [
      ...new Set([...progress.seenEvidenceIds, ...independent]),
    ],
    noNewEvidence: newEvidence ? 0 : progress.noNewEvidence,
  };
  return {
    attempt: request.attempts + 1,
    state: {
      ...state,
      requests: state.requests.map((r) =>
        r.id === id ? { ...r, attempts: r.attempts + 1, status: "running" } : r,
      ),
      scopes: [
        ...state.scopes.filter((s) => s.scope !== request.scope),
        nextProgress,
      ],
    },
  };
}

/** Does not pretend cancellation stopped an in-flight provider; caller must also abort its signal. */
export function cancel(state: ReflectionState, id: string): ReflectionState {
  return {
    ...state,
    requests: state.requests.map((r) =>
      r.id === id && r.status !== "cancelled"
        ? {
            ...r,
            status:
              r.status === "running" || r.status === "cancelling"
                ? "cancelling"
                : "cancelled",
          }
        : r,
    ),
  };
}

/** newEvidence must come from trusted memory ingestion, not generated/model-cited evidence IDs. */
export function finish(
  state: ReflectionState,
  id: string,
  attempt: number,
  now: number,
  newEvidence: Evidence[],
  policy: Policy,
): ReflectionState {
  validatePolicy(policy);
  finite(now);
  const request = state.requests.find((r) => r.id === id);
  if (
    !request ||
    request.attempts !== attempt ||
    !["running", "cancelling"].includes(request.status)
  )
    return state;
  const progress = state.scopes.find((s) => s.scope === request.scope);
  if (!progress) throw new Error("Missing scope progress");
  const freshIds = newEvidence
    .filter(
      (e) =>
        e.source !== "dream" &&
        freshEvidence(e, request.scope, now, policy.evidenceMaxAgeMs),
    )
    .map((e) => e.id);
  const gained = freshIds.some(
    (eid) => !progress.seenEvidenceIds.includes(eid),
  );
  const noNewEvidence = gained ? 0 : progress.noNewEvidence + 1;
  const status =
    request.status === "cancelling"
      ? "cancelled"
      : request.attempts >= policy.maxAttempts ||
          noNewEvidence >= policy.maxNoNewEvidence
        ? "stopped"
        : "pending";
  return {
    ...state,
    requests: state.requests.map((r) => (r.id === id ? { ...r, status } : r)),
    scopes: state.scopes.map((s) =>
      s.scope === request.scope
        ? {
            ...s,
            seenEvidenceIds: [...new Set([...s.seenEvidenceIds, ...freshIds])],
            noNewEvidence,
            nextEligibleAt: Math.max(s.nextEligibleAt, now + policy.cooldownMs),
          }
        : s,
    ),
  };
}

export interface Drive {
  value: number;
  updatedAt: number;
}
export function decayDrive(
  drive: Drive,
  now: number,
  halfLifeMs: number,
): Drive {
  finite(now);
  finite(drive.updatedAt);
  finite(drive.value);
  finite(halfLifeMs);
  if (halfLifeMs <= 0 || drive.value < 0 || drive.value > 1)
    throw new Error("Invalid drive");
  const updatedAt = Math.max(now, drive.updatedAt);
  return {
    value: drive.value * 2 ** (-(updatedAt - drive.updatedAt) / halfLifeMs),
    updatedAt,
  };
}

export const reflectionDriveHalfLifeMs = 3_600_000;

/** Enqueue stimulates once. Retries, duplicate requests and reads never refresh
 * the drive. This ranks eligible work only; it is not admission or authority.
 */
export function reflectionPriority(
  request: Pick<ReflectionRequest, "createdAt">,
  now: number,
): number {
  return decayDrive(
    { value: 1, updatedAt: request.createdAt },
    now,
    reflectionDriveHalfLifeMs,
  ).value;
}
