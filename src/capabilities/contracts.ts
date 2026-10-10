import { z } from "zod";
import type { Address, MessageEvent, SendResult } from "../core/contracts.js";
import type { Source } from "../memory/store.js";
import type { CapabilityContext } from "../runtime/capabilities.js";
import type { ExecutionContext } from "../runtime/execution-context.js";
import type { Receipt, ToolAction } from "../tools/broker.js";

/** Internal wave-0 contracts, not a durable schema or a grant migration. */
export const CAPABILITY_CONTRACT_VERSION = 1;
const id = z.string().min(1).max(2048);
const timestamp = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeText = z.string().min(1).max(2000);
export const capabilityIdSchema = z
  .string()
  .regex(/^s(?:0[1-9]|1[0-9]|2[0-8])\.[a-z][a-z0-9-]{0,63}$/);
export const capabilityTurnSchema = z.enum([
  "interaction",
  "execution",
  "event-decision",
  "notification-only",
]);
export type CapabilityTurn = z.infer<typeof capabilityTurnSchema>;
/** Software activation only; it grants no account, effect or provider access. */
export const capabilityModuleConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
});

/** Safe metadata only. Freshness is a projection, never a persisted attestation.
 * Providers must downgrade absent, stale or future evidence to unknown. */
export const capabilityObservationSchema = z.strictObject({
  value: z.enum(["yes", "no", "unknown"]),
  observedAt: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  scope: safeText,
  source: safeText,
  reason: safeText.optional(),
});
export type CapabilityObservation = z.infer<typeof capabilityObservationSchema>;
export const capabilityPrerequisiteSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
  resolver: z.enum(["june", "owner", "operator"]),
  nextAction: z.strictObject({
    kind: z.enum(["inspect", "setup", "operator-review"]),
    instruction: safeText,
  }),
  observation: capabilityObservationSchema,
});
export type CapabilityPrerequisite = z.infer<
  typeof capabilityPrerequisiteSchema
>;
export const capabilityStatusSchema = z.strictObject({
  id,
  implemented: capabilityObservationSchema,
  hostIntegrated: capabilityObservationSchema,
  juneCallable: capabilityObservationSchema,
  enrolled: capabilityObservationSchema,
  enabled: capabilityObservationSchema,
  ready: capabilityObservationSchema,
  liveVerified: capabilityObservationSchema,
  prerequisites: z.array(capabilityPrerequisiteSchema).max(64),
});
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;
export const capabilityAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available") }),
  z.strictObject({
    status: z.literal("unavailable"),
    prerequisites: z.array(capabilityPrerequisiteSchema).min(1).max(64),
  }),
]);
export type CapabilityAvailability = z.infer<
  typeof capabilityAvailabilitySchema
>;

export const intentReferenceSchema = z.strictObject({ id, version: timestamp });
export type IntentReference = z.infer<typeof intentReferenceSchema>;
/** Optional host-only provenance for new descendants, frozen at owner admission.
 * Derive from the saved root/delegation admission, never model output, a resumed
 * job's new generation, deletionRevision, session UUID or legacy backfill. This
 * routes to the original owner; it does not grant authority or prove a root fence.
 * Existing source/audience/deletion bindings remain independently authoritative. */
export interface CapabilityIntentBinding {
  reference: IntentReference;
  origin: Pick<ExecutionContext, "conversationKey" | "originEventId"> & {
    delegation?: { agentId: string; requestId: string };
  };
}
export const effectOutcomeSchema = z.enum([
  "not_started",
  "succeeded",
  "failed",
  "unknown",
]);
export type EffectOutcome = z.infer<typeof effectOutcomeSchema>;
export const intentSnapshotSchema = z.strictObject({
  reference: intentReferenceSchema,
  state: z.enum(["current", "stopping", "stopped"]),
  effects: z.array(
    z.strictObject({ operationId: id, outcome: effectOutcomeSchema }),
  ),
});
export type IntentSnapshot = z.infer<typeof intentSnapshotSchema>;
export type IntentAdmission =
  | { status: "admitted" }
  | {
      status: "blocked";
      reason: "stale_intent" | "already_started" | "settled" | "unavailable";
    };
/** Constructed for one authenticated source/scope and ceiling. A reference ID
 * alone never authorizes inspection or stopping another scope's work. */
export interface IntentPort {
  inspect(reference: IntentReference): Promise<IntentSnapshot | null>;
  current(reference: IntentReference): Promise<boolean>;
  /** Host operation ID only. The existing owner synchronously claims first use
   * and persists it before admission. A lost admission ACK or unknown receipt
   * never grants replay. Missing intent/source fences deny. After each preparation
   * await the owner must also assert its local synchronous fence immediately at
   * dispatch; this async method and current() are not that fence. */
  begin(
    reference: IntentReference,
    operationId: string,
  ): Promise<IntentAdmission>;
  /** Record the original operation's raw outcome even after intent becomes stale.
   * Terminal succeeded/failed/not_started receipts are immutable. Unknown remains
   * held until original-owner reconciliation, never a retry or release signal.
   * Publication independently requires current intent and canDeliver. */
  settle(
    reference: IntentReference,
    operationId: string,
    outcome: EffectOutcome,
  ): Promise<void>;
  /** Closes the owner's generation synchronously, then persists and signals abort.
   * Fenced stays false while an admitted descendant could dispatch; settled stays
   * false for unknown/unretired operations. Neither means effects were undone. */
  stop(
    reference: IntentReference,
  ): Promise<{ fenced: boolean; settled: boolean }>;
}
export const attentionDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("deliver"), reason: safeText }),
  z.strictObject({ decision: z.literal("suppress"), reason: safeText }),
  z.strictObject({
    decision: z.literal("defer"),
    reason: safeText,
    until: timestamp,
  }),
]);
export type AttentionDecision = z.infer<typeof attentionDecisionSchema>;
export interface AttentionPort {
  /** A delivery recommendation never authorizes the destination. */
  decide(
    context: CapabilityInvocationContext,
    destination: Address,
  ): Promise<AttentionDecision>;
}
export const timePreviewInputSchema = z.strictObject({
  expression: safeText,
  timezone: z.string().min(1).max(100),
  after: timestamp,
  limit: z.number().int().min(1).max(20),
});
export type TimePreviewInput = z.infer<typeof timePreviewInputSchema>;
export interface TimePort {
  /** Pure preview: does not create a timer or choose a catch-up policy. */
  preview(input: TimePreviewInput): { instants: number[]; explanation: string };
}

/** Host-created exact binding. Neither account permission nor this value creates
 * authority; old broker grants are not silently upgraded to scoped parity grants. */
export interface PolicyBinding {
  source: Address;
  audience: Address;
  operationId: string;
  action: Readonly<ToolAction>;
  artifactDigest: string;
  expiresAt: number;
  intent: IntentReference;
}
export type PolicyDecision =
  | { status: "denied"; prerequisites: CapabilityPrerequisite[] }
  | {
      status: "admitted";
      grantId: string;
      /** Host-only, one use; rechecks current intent/source fences, revocation
       * and exact binding on release. Missing fence support denies. No JSON secret. */
      withCredential(
        use: (credential: unknown) => Promise<void>,
      ): Promise<void>;
    };
/** Host-context-bound to authenticated source/audience/current ceiling. IDs alone
 * authorize neither inspect nor revoke. Metadata inspection does not admit effects. */
export interface PolicyPort {
  admit(
    authorityReference: string,
    binding: PolicyBinding,
    signal: AbortSignal,
  ): Promise<PolicyDecision>;
  recheck(
    grantId: string,
    binding: PolicyBinding,
    signal: AbortSignal,
  ): Promise<PolicyDecision>;
  revoke(grantId: string): Promise<{ fenced: boolean; settled: false }>;
  inspect(grantId: string): Promise<{
    grantId: string;
    status: "active" | "revoked" | "expired" | "consumed" | "unknown";
    receipt?: Receipt;
  } | null>;
}

export const budgetReservationSchema = z.strictObject({
  operationId: id,
  taskId: id,
  pricePolicyRef: id,
  currency: z.string().regex(/^[A-Z]{3}$/),
  maximumMicros: timestamp,
  category: id,
  period: z
    .strictObject({ from: timestamp, to: timestamp })
    .refine((p) => p.from < p.to),
});
export type BudgetReservation = z.infer<typeof budgetReservationSchema>;
export const budgetSettlementSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("charged"), actualMicros: timestamp }),
  z.strictObject({ status: z.literal("no_charge") }),
  z.strictObject({ status: z.literal("unknown") }),
]);
export type BudgetSettlement = z.infer<typeof budgetSettlementSchema>;
export const budgetSnapshotSchema = z.strictObject({
  reservation: budgetReservationSchema,
  outcome: budgetSettlementSchema.nullable(),
  held: z.boolean(),
});
export type BudgetSnapshot = z.infer<typeof budgetSnapshotSchema>;
export const budgetAdmissionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("reserved"),
    reservation: budgetReservationSchema,
  }),
  z.strictObject({
    status: z.literal("existing"),
    snapshot: budgetSnapshotSchema,
  }),
  z.strictObject({
    status: z.literal("denied"),
    prerequisites: z.array(capabilityPrerequisiteSchema).min(1).max(64),
  }),
]);
export type BudgetAdmission = z.infer<typeof budgetAdmissionSchema>;
/** Future financial transactions only, never admission for configured inference
 * or built-in tools. Those need no funding classification/no-charge attestation.
 * Autonomous purchases, orders, transfers and new financial commitments remain
 * prohibited; a reservation is not transaction authorization. This contract is
 * inert and no production reservation store is approved. */
export interface BudgetPort {
  /** Only a first reserved result can support one independently authorized
   * dispatch. Repeated/held/settled operations return existing, never a new attempt.
   * input.operationId must equal
   * context.operationId; source/task/category/currency/period/maximum/price policy
   * bind immutably. Owner caps are host policy, not the caller's maximumMicros.
   * Missing cap, ceiling or intent denies. No timeout-based reservation release. */
  reserve(
    context: CapabilityInvocationContext,
    input: BudgetReservation,
  ): Promise<BudgetAdmission>;
  settle(
    context: CapabilityInvocationContext,
    outcome: BudgetSettlement,
  ): Promise<void>;
  inspect(
    context: CapabilityInvocationContext,
    operationId: string,
  ): Promise<BudgetSnapshot | null>;
}

export const evidenceReferenceSchema = z.strictObject({
  id,
  sourceIds: z.array(id).min(1).max(1000),
  deletionRevision: timestamp,
});
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export interface EvidencePort {
  /** Scope filtering precedes retrieval; null must not reveal foreign existence. */
  read(
    context: CapabilityInvocationContext,
    sourceId: string,
  ): Promise<Source | null>;
  register(
    context: CapabilityInvocationContext,
    derivative: EvidenceReference,
  ): Promise<void>;
  current(
    context: CapabilityInvocationContext,
    reference: EvidenceReference,
  ): Promise<boolean>;
}
export const deletionPreviewSchema = z.strictObject({
  id,
  fingerprint: digest,
  sourceIds: z.array(id).min(1).max(1000),
  deletionRevision: timestamp,
  derivatives: timestamp,
});
export type DeletionPreview = z.infer<typeof deletionPreviewSchema>;
export const deletionStatusSchema = z.strictObject({
  id,
  state: z.enum(["pending", "complete", "unknown"]),
  limitations: z.array(safeText).max(64),
});
export type DeletionStatus = z.infer<typeof deletionStatusSchema>;
export interface DeletionParticipant {
  preview(
    context: CapabilityInvocationContext,
    sourceIds: readonly string[],
  ): Promise<DeletionPreview>;
  apply(
    context: CapabilityInvocationContext,
    preview: DeletionPreview,
  ): Promise<DeletionStatus>;
  status(
    context: CapabilityInvocationContext,
    id: string,
  ): Promise<DeletionStatus | null>;
}

export const fileMetadataSchema = z.strictObject({
  id,
  sha256: digest,
  bytes: timestamp,
  mediaType: z.string().min(1).max(256),
  expiresAt: timestamp,
  provenance: evidenceReferenceSchema,
});
export type FileReference = z.infer<typeof fileMetadataSchema> & {
  source: Address;
  audience: Address;
};
export interface FilePort {
  /** Host-bound stream; no model-selected path, bearer URL or arbitrary fetch. */
  ingress(
    context: CapabilityInvocationContext,
    reference: FileReference,
    bytes: AsyncIterable<Uint8Array>,
  ): Promise<FileReference>;
  read(
    context: CapabilityInvocationContext,
    id: string,
    maximumBytes: number,
  ): Promise<AsyncIterable<Uint8Array> | null>;
  deliver(
    context: CapabilityInvocationContext,
    id: string,
    destination: Address,
  ): Promise<SendResult>;
  forget(
    context: CapabilityInvocationContext,
    id: string,
  ): Promise<DeletionStatus>;
}
export const taskViewSchema = z.strictObject({
  id,
  owner: id,
  scope: id,
  state: z.enum([
    "queued",
    "running",
    "waiting",
    "blocked",
    "unknown",
    "complete",
    "failed",
    "cancelled",
  ]),
  delivery: z.enum(["not_requested", "pending", "sent", "failed", "unknown"]),
  operationIds: z.array(id).max(1000),
  observation: capabilityObservationSchema,
});
export type TaskView = z.infer<typeof taskViewSchema>;
export interface TaskViewPort {
  /** Projection of existing owners and receipts, never a second job store.
   * Register the final schema-parsed fresh object immediately before a non-null
   * return. Pin exact cache entry, original source reader/incarnation/publication,
   * current authorization/deletion and original TTL, without reinspection or wakes.
   * Missing outputGuards or failed registration cannot yield a non-null result.
   * Null needs no registration. Preserve the original context and signal. */
  inspect(
    context: CapabilityInvocationContext,
    id: string,
  ): Promise<TaskView | null>;
}

/** Producer-only facet of one worker-owned invocation-local collector. Supply a
 * separate object containing only register, never a narrowed controller object.
 * The host claims each exact non-null result once before its post-reader await;
 * empty/prior registrations, duplicate registration and reused objects deny it.
 * Keep claimed guards through delivery/dispatch awaits and the final synchronous
 * check immediately before first worker history insertion, without an intervening
 * await. Failure latches only this invocation and substitutes bounded unavailable
 * output. Worker finally clears the collector after publication/abandonment and
 * before persistence; never serialize guards or graft them onto worker validity.
 * Admitted minimized text is ordinary historical evidence with original times,
 * not continuing freshness or later model/provider-dispatch authorization.
 * Source-only invalidation does not erase it; existing forgetting/deletion/
 * revocation still cancels the worker and clears history. Raw snapshots, source
 * readers and caches are not retained as history. */
export interface CapabilityOutputGuards {
  /** Bind the final returned object once. current is synchronous and side-effect
   * free; only literal true passes. Throws, Promises and other values fail closed.
   * Registration grants no authority or lifetime beyond first publication. */
  register(result: object, current: () => boolean): void;
}

/** K1 is assembled by the runtime from authenticated context, never reply JSON. */
export type CapabilityInvocationContext = Pick<
  CapabilityContext,
  | "event"
  | "scope"
  | "audience"
  | "eventId"
  | "deletionRevision"
  | "signal"
  | "valid"
> & {
  operationId: string;
  turn: CapabilityTurn;
  execution?: ExecutionContext;
  intent?: IntentReference;
  /** Host-only producer facet; absence never certifies a non-null TaskView.
   * Null results and unrelated inspection capabilities need no registration. */
  readonly outputGuards?: CapabilityOutputGuards;
  canStartAction(): boolean;
  canDeliver(): Promise<boolean>;
};
/** Absent means unavailable. Do not fill these with permissive fallback ports. */
export interface CapabilityHostPorts {
  intent?: IntentPort;
  attention?: AttentionPort;
  time?: TimePort;
  policy?: PolicyPort;
  budget?: BudgetPort;
  evidence?: EvidencePort;
  files?: FilePort;
  tasks?: TaskViewPort;
  inspection?: {
    capabilityMatrix(event: MessageEvent, signal: AbortSignal): Promise<string>;
  };
}
export interface CapabilityHandler {
  execute(
    command: unknown,
    context: CapabilityInvocationContext,
  ): Promise<string>;
}
export interface CapabilityDefinition {
  readonly id: string;
  readonly commandSchema: z.ZodType;
  readonly effect: "metadata" | "read" | "write" | "paid";
  readonly allowedTurns: readonly ("execution" | "event-decision")[];
  readonly requiredPorts: readonly (keyof CapabilityHostPorts)[];
  readonly knowledge: string;
  readonly help: string;
  /** Synchronous local metadata only: no probing, enrollment or factory calls. */
  inspectAvailability(ports: CapabilityHostPorts): CapabilityAvailability;
  create(ports: CapabilityHostPorts): CapabilityHandler | undefined;
}

/** Validate the input contract, not Zod's output (which can hide stripped keys).
 * Registration is trusted source code, but accidental non-strict objects must
 * fail at startup rather than silently accepting model-selected authority. */
function requireStrictObjects(value: unknown): void {
  if (value === false) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Capability commands require constrained schemas");
  const object = value as Record<string, unknown>;
  if (
    !["type", "const", "enum", "$ref", "anyOf", "oneOf", "allOf"].some(
      (key) => key in object,
    )
  )
    throw new Error("Capability commands reject unconstrained input");
  const types = Array.isArray(object.type) ? object.type : [object.type];
  if (types.includes("object") && object.additionalProperties !== false)
    throw new Error("Capability commands require strict object schemas");
  // Visit schema positions, not annotation values or the properties map itself.
  for (const key of ["properties", "$defs", "definitions"]) {
    const children = object[key];
    if (children && typeof children === "object")
      for (const child of Object.values(children)) requireStrictObjects(child);
  }
  for (const key of [
    "items",
    "contains",
    "additionalProperties",
    "anyOf",
    "oneOf",
    "allOf",
    "prefixItems",
  ]) {
    const child = object[key];
    if (child === undefined) continue;
    if (Array.isArray(child))
      for (const item of child) requireStrictObjects(item);
    else requireStrictObjects(child);
  }
}

/** Trusted source helper. The runtime still owns role, ceiling and effect fences.
 * Factories receive only named ports, never the full dependency container. */
export function defineCapability<
  S extends z.ZodType,
  const P extends readonly (keyof CapabilityHostPorts)[],
>(definition: {
  id: string;
  commandSchema: S;
  effect: CapabilityDefinition["effect"];
  allowedTurns: CapabilityDefinition["allowedTurns"];
  requiredPorts: P;
  knowledge: string;
  help: string;
  availability(
    ports: Readonly<Pick<CapabilityHostPorts, P[number]>>,
  ): CapabilityAvailability;
  create(ports: Readonly<Required<Pick<CapabilityHostPorts, P[number]>>>): {
    execute(
      command: z.infer<S>,
      context: CapabilityInvocationContext,
    ): Promise<string>;
  };
}): CapabilityDefinition {
  capabilityIdSchema.parse(definition.id);
  requireStrictObjects(
    z.toJSONSchema(definition.commandSchema, { io: "input" }),
  );
  const selected = (ports: CapabilityHostPorts) =>
    Object.fromEntries(
      definition.requiredPorts.map((name) => [name, ports[name]]),
    ) as Pick<CapabilityHostPorts, P[number]>;
  const inspectAvailability = (
    ports: CapabilityHostPorts,
  ): CapabilityAvailability => {
    const missing = definition.requiredPorts.filter((name) => !ports[name]);
    if (missing.length)
      return {
        status: "unavailable",
        prerequisites: missing.map((name) => ({
          code: `host_port.${name}`,
          resolver: "operator",
          nextAction: {
            kind: "operator-review",
            instruction: `The ${name} host service is not integrated. Ask its operator to inspect the prerequisite; do not substitute a fallback.`,
          },
          observation: {
            value: "no",
            observedAt: null,
            expiresAt: null,
            revision: null,
            freshness: "unknown",
            scope: definition.id,
            source: "host registration",
          },
        })),
      };
    return capabilityAvailabilitySchema.parse(
      definition.availability(selected(ports)),
    );
  };
  return {
    id: definition.id,
    commandSchema: definition.commandSchema,
    effect: definition.effect,
    allowedTurns: definition.allowedTurns,
    requiredPorts: definition.requiredPorts,
    knowledge: definition.knowledge,
    help: definition.help,
    inspectAvailability,
    create(ports) {
      if (inspectAvailability(ports).status !== "available") return undefined;
      const handler = definition.create(
        selected(ports) as Required<Pick<CapabilityHostPorts, P[number]>>,
      );
      return {
        execute: (command, context) =>
          handler.execute(definition.commandSchema.parse(command), context),
      };
    },
  };
}
