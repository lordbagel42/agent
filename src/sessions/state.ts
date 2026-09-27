import { createHash } from "node:crypto";

export type SessionInputKind = "message" | "notification";
interface ReceivedInput {
  id: string;
  kind: SessionInputKind;
  receivedAt: number;
}
export type SessionReceipt = ReceivedInput &
  (
    | { status: "pending" }
    | { status: "assigned" | "settled"; sessionId: string; sequence: number }
  );
type AssignedReceipt = Extract<SessionReceipt, { sessionId: string }>;

export interface ActivitySession {
  id: string;
  openedAt: number;
  lastHumanAt?: number;
  completedThrough: number;
  archivedThrough: number;
  status: "open" | "sealed";
}

/** Control metadata only: event bodies, approvals and privacy authority live
 * elsewhere. Retain receipts for as long as their events can be replayed. */
export interface SessionDirectory {
  scopeKey: string[];
  idleMs: number;
  receipts: Record<string, SessionReceipt>;
  sessions: Record<string, ActivitySession>;
  pending: string[];
  activeSessionId?: string;
  inFlight?: string;
  receivedThrough: number;
}

export type NextSessionInput =
  | { kind: "idle" }
  | { kind: "archive"; sessionId: string; through: number }
  | { kind: "dispatch"; receipt: AssignedReceipt };

const validId = (id: string) => /^[a-f0-9]{64}$/.test(id);
const validTime = (time: number) => Number.isSafeInteger(time) && time >= 0;

export function initialSessionDirectory(
  scopeKey: readonly string[],
  idleMs = 3 * 60 * 60 * 1000,
): SessionDirectory {
  if (
    !scopeKey.length ||
    !scopeKey.every((part) => typeof part === "string") ||
    !validTime(idleMs) ||
    idleMs === 0
  )
    throw new Error("Invalid session directory configuration");
  return {
    scopeKey: [...scopeKey],
    idleMs,
    receipts: {},
    sessions: {},
    pending: [],
    receivedThrough: 0,
  };
}

/** Safe native Rivet key segments. Never use this key as a memory audience. */
export function sessionActorKey(
  scopeKey: readonly string[],
  sessionId: string,
): string[] {
  if (!validId(sessionId)) throw new Error("Invalid session ID");
  return [
    createHash("sha256").update(JSON.stringify(scopeKey)).digest("hex"),
    sessionId,
  ];
}

/** Trusted ingress only. The host authenticates and stores the event body before
 * calling this, and persists the receipt before acknowledging ingress. Preserve
 * per-scope arrival order across asynchronous preparation and replay the saved
 * first-receipt time: this transition cannot reconstruct ingress order. */
export function receiveSessionInput(
  state: SessionDirectory,
  id: string,
  kind: SessionInputKind,
  now: number,
): SessionReceipt {
  if (
    !validId(id) ||
    !validTime(now) ||
    !["message", "notification"].includes(kind)
  )
    throw new Error("Invalid session input");
  const previous = state.receipts[id];
  if (previous) {
    if (previous.kind !== kind) throw new Error("Session receipt conflict");
    return { ...previous };
  }
  const receipt: SessionReceipt = {
    id,
    kind,
    receivedAt: Math.max(now, state.receivedThrough),
    status: "pending",
  };
  state.receipts[id] = receipt;
  state.pending.push(id);
  state.receivedThrough = receipt.receivedAt;
  return { ...receipt };
}

function canJoin(
  state: SessionDirectory,
  session: ActivitySession,
  receipt: SessionReceipt,
): boolean {
  return (
    receipt.receivedAt - (session.lastHumanAt ?? session.openedAt) <
      state.idleMs &&
    (session.lastHumanAt !== undefined ||
      receipt.kind === "message" ||
      // Drain preceding notifications without hiding a human already waiting
      // to join this period. Only the human's dispatch advances lastHumanAt.
      state.pending.some((id) => {
        const pending = state.receipts[id];
        return (
          pending?.kind === "message" &&
          pending.receivedAt - session.openedAt < state.idleMs
        );
      }))
  );
}

/** Persist this transition before enqueueing. Dispatch replay returns the same
 * assignment until settlement; the receiving actor must also deduplicate it. */
export function nextSessionInput(state: SessionDirectory): NextSessionInput {
  if (state.inFlight) {
    const receipt = state.receipts[state.inFlight] as AssignedReceipt;
    return { kind: "dispatch", receipt: { ...receipt } };
  }
  const id = state.pending[0];
  if (!id) return { kind: "idle" };
  const receipt = state.receipts[id] as SessionReceipt;
  let session = state.activeSessionId
    ? state.sessions[state.activeSessionId]
    : undefined;
  if (session && !canJoin(state, session, receipt)) {
    if (session.archivedThrough !== session.completedThrough)
      return {
        kind: "archive",
        sessionId: session.id,
        through: session.completedThrough,
      };
    session.status = "sealed";
    delete state.activeSessionId;
    session = undefined;
  }
  if (!session) {
    const sessionId = createHash("sha256")
      .update(JSON.stringify([state.scopeKey, id]))
      .digest("hex");
    state.sessions[sessionId] = {
      id: sessionId,
      openedAt: receipt.receivedAt,
      completedThrough: 0,
      archivedThrough: 0,
      status: "open",
    };
    state.activeSessionId = sessionId;
    // Read through state so mutations also work with Rivet's state proxies.
    session = state.sessions[sessionId] as ActivitySession;
  }
  const assigned: AssignedReceipt = {
    id: receipt.id,
    kind: receipt.kind,
    receivedAt: receipt.receivedAt,
    status: "assigned",
    sessionId: session.id,
    sequence: session.completedThrough + 1,
  };
  state.receipts[id] = assigned;
  state.inFlight = id;
  state.pending.shift();
  if (receipt.kind === "message") session.lastHumanAt = receipt.receivedAt;
  return { kind: "dispatch", receipt: { ...assigned } };
}

/** Only the trusted runtime can attest settlement of the exact assigned turn.
 * Unknown provider/delivery outcomes must not call this to release admission. */
export function settleSessionInput(
  state: SessionDirectory,
  id: string,
  sessionId: string,
): void {
  const receipt = validId(id) ? state.receipts[id] : undefined;
  if (
    !receipt ||
    receipt.status === "pending" ||
    receipt.sessionId !== sessionId
  )
    throw new Error("Unassigned session input");
  if (receipt.status === "settled") return;
  if (state.inFlight !== id) throw new Error("Session input is not current");
  const session = state.sessions[sessionId] as ActivitySession;
  session.completedThrough = receipt.sequence;
  receipt.status = "settled";
  delete state.inFlight;
}

/** A host acknowledgment of durable, searchable transcript coverage, not a
 * model claim or summary result. Earlier acknowledgments cannot rewind it. */
export function acknowledgeSessionArchive(
  state: SessionDirectory,
  sessionId: string,
  through: number,
): void {
  const session = validId(sessionId) ? state.sessions[sessionId] : undefined;
  if (!session || !validTime(through) || through > session.completedThrough)
    throw new Error("Invalid session archive acknowledgment");
  session.archivedThrough = Math.max(session.archivedThrough, through);
}

/** Called from a durable idle wake, not used as a process-local expiry timer. */
export function sealIdleSession(state: SessionDirectory, now: number): boolean {
  if (!validTime(now)) throw new Error("Invalid session idle time");
  const session = state.activeSessionId
    ? state.sessions[state.activeSessionId]
    : undefined;
  if (!session || state.inFlight) return false;
  const pendingId = state.pending[0];
  const next = pendingId ? state.receipts[pendingId] : undefined;
  if (
    (next && canJoin(state, session, next)) ||
    session.archivedThrough !== session.completedThrough ||
    (session.lastHumanAt !== undefined &&
      now - session.lastHumanAt < state.idleMs)
  )
    return false;
  session.status = "sealed";
  delete state.activeSessionId;
  return true;
}
