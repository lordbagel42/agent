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
/** Constructed for one authenticated source/scope and ceiling. A reference ID
 * alone never authorizes inspection or stopping another scope's work. */
export interface IntentPort {
  inspect(reference: IntentReference): Promise<IntentSnapshot | null>;
  current(reference: IntentReference): Promise<boolean>;
  /** Fenced is not proof that an already-started effect has settled. */
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
/** Monetary effects only, never token quotas for authorized included inference.
 * Owner-funded spending is currently prohibited, even through Stripe Link;
 * reservations cannot authorize it. Future payment needs Link plus fresh explicit
 * authorization. The host classifies funding; metered/ambiguous billing cannot be
 * relabeled included inference. No production reservation store is approved. */
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
  ]),
  delivery: z.enum(["not_requested", "pending", "sent", "failed", "unknown"]),
  operationIds: z.array(id).max(1000),
  observation: capabilityObservationSchema,
});
export type TaskView = z.infer<typeof taskViewSchema>;
export interface TaskViewPort {
  /** Projection of existing owners and receipts, never a second job store. */
  inspect(
    context: CapabilityInvocationContext,
    id: string,
  ): Promise<TaskView | null>;
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
