import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Evidence } from "../reflection/domain.js";

const id = z.string().min(1).max(2048);
const ids = z
  .array(id)
  .min(1)
  .max(1000)
  .refine((v) => new Set(v).size === v.length);
const timestamp = z.number().int().nonnegative().safe();
const correctionSchema = z.strictObject({
  trait: z.enum(["verbosity", "tone", "humor", "interests"]),
  value: z.string().min(1).max(2000),
});
const sourceSchema = z.strictObject({
  id,
  audiences: ids,
  platform: id,
  account: id,
  conversation: id,
  author: id,
  observedAt: timestamp,
  sourceUrl: z.url(),
  text: z.string().max(1_000_000),
  // Trusted, explicit owner correction only; never inferred from message text.
  correction: correctionSchema.optional(),
});
const citationSchema = z.strictObject({
  sourceId: id,
  quote: z.string().min(1).max(4000),
});
const proposalInputSchema = z
  .strictObject({
    subjectSourceId: id,
    text: z.string().min(1).max(4000),
    category: z.enum(["claim", "preference", "commitment", "pattern"]),
    citations: z.array(citationSchema).min(1).max(20),
    confidence: z.number().min(0).max(1),
    validFrom: timestamp.nullable(),
    validTo: timestamp.nullable(),
    contradicts: z.array(id).max(20),
    supersedes: z.array(id).max(20),
  })
  .refine(
    (v) =>
      v.validFrom === null || v.validTo === null || v.validFrom < v.validTo,
  );
const claimSchema = z.strictObject({
  id,
  entity: id,
  text: z.string().min(1).max(100_000),
  audiences: ids,
  kind: z.enum(["evidence", "dream"]),
  dependsOn: ids,
  contradicts: z.array(id).max(1000),
  supersedes: z.array(id).max(1000),
  // All host-supplied inputs: deletion dependencies, never corroboration.
  // Missing means legacy/untracked; claimIds: [] records known-empty context.
  extractionContext: z
    .strictObject({
      sourceIds: ids,
      claimIds: z.array(id).max(20),
    })
    .optional(),
  grounding: proposalInputSchema.optional(),
});
const proposalSchema = z.strictObject({
  id,
  audience: id,
  claim: claimSchema,
  status: z.enum(["pending", "accepted", "rejected"]),
});
const coverageSchema = z
  .strictObject({
    platform: id,
    account: id,
    conversations: ids,
    from: timestamp,
    to: timestamp,
    audiences: ids,
  })
  .refine((v) => v.from < v.to);
const cooldownReasonSchema = z.enum([
  "rate_limit",
  "provider_backoff",
  "pacing",
  "unknown",
]);
const progressSchema = z.strictObject({
  id,
  coverage: coverageSchema,
  cursor: id.nullable(),
  pages: timestamp,
  complete: z.boolean(),
  notBefore: timestamp,
  // Older snapshots have a deadline but no recorded reason.
  cooldownReason: cooldownReasonSchema.nullable().optional(),
  gaps: z.array(z.string().max(10000)),
  // Legacy pages have no provable per-selection membership; never infer it from
  // message text or today's Gmail labels. Only future persisted pages fill this.
  sourceIds: z.array(id).default([]),
  trackedPages: timestamp.default(0),
});
const importExtractionSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  importId: id,
  audience: id,
  sourceIds: ids.max(20),
  contextClaimIds: z.array(id).max(20),
  status: z.enum(["started", "staged", "uncertain", "cancelled"]),
  proposalIds: z.array(id).max(20),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  sources: z.array(sourceSchema),
  claims: z.array(claimSchema),
  tombstones: z.array(id),
  imports: z.array(progressSchema),
  proposals: z.array(proposalSchema).default([]),
  extractions: z
    .array(
      z.strictObject({
        audience: id,
        sourceIds: ids,
        proposalIds: z.array(id).max(20),
      }),
    )
    .default([]),
  // Live authentication is an attestation, not a change to canonical history.
  corrections: z
    .array(z.strictObject({ sourceId: id, correction: correctionSchema }))
    .default([]),
  importExtractions: z.array(importExtractionSchema).default([]),
});
const pageSchema = z.strictObject({
  sources: z.array(sourceSchema).max(1000),
  // Fetcher-verified selection membership, not immutable evidence identity.
  gmailLabel: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .optional(),
  nextCursor: id.nullable(),
  gaps: z.array(z.string().max(10000)).max(1000).optional(),
  retryAfterMs: timestamp.optional(),
  rateLimited: z.boolean().optional(),
  cooldownReason: cooldownReasonSchema.optional(),
});
export type Source = z.infer<typeof sourceSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type MemoryProposalInput = z.infer<typeof proposalInputSchema>;
export type MemoryProposal = z.infer<typeof proposalSchema>;
export interface ForgetPreview {
  sourceId: string;
  sources: 1;
  claims: number;
  proposals: { pending: number; accepted: number; rejected: number };
  physicalPurge: false;
  /** Host-only binding, never a deletion grant or a model-visible receipt. */
  fingerprint: string;
  /** Host-only: false when deletion would reach unpreviewed records. Do not
   * expose this bit or explain it using foreign graph existence. */
  confirmable: boolean;
}
export type MemoryRetrieval = {
  sources: Source[];
  claims: Claim[];
  // Present only when matching, authorized records were omitted by a bound.
  truncated?: true;
  omitted?: number;
  nextCursor?: string;
};
export type DependentClaims = {
  claims: {
    id: string;
    kind: Claim["kind"];
    dependency: "direct" | "derived";
  }[];
  direct: number;
  derived: number;
  omitted: number;
};
export type SupersessionInspection = {
  // Newer recorded updates precede older claims unless cyclic is true.
  claims: (Pick<Claim, "id" | "text" | "kind"> & {
    supersedes: string[];
    supersededBy: string[];
  })[];
  incomplete: boolean;
  cyclic: boolean;
};
export type ImportCoverage = z.infer<typeof coverageSchema>;
export type ImportProgress = z.infer<typeof progressSchema>;
export type ImportPage = z.infer<typeof pageSchema>;
export type LedgerOperationStatus = {
  status: "unknown" | "succeeded" | "failed";
  attemptedAt: number | null;
  lastSucceededAt: number | null;
};
export type ImportExtraction = z.infer<typeof importExtractionSchema>;
type State = z.infer<typeof stateSchema>;

export const DEFAULT_IMPORT_BUDGET = Object.freeze({
  sources: 1_000,
  claims: 1_000,
  serializedBytes: 4 * 1024 * 1024,
});
const importBudgetSchema = z.strictObject({
  sources: z.number().int().positive().safe(),
  claims: z.number().int().positive().safe(),
  serializedBytes: z.number().int().positive().safe(),
});
export type ImportBudget = z.infer<typeof importBudgetSchema>;
export class ImportBudgetExceeded extends Error {
  constructor(readonly dimension: keyof ImportBudget) {
    super(
      `Import page exceeds the ledger-wide ${dimension} budget; no page evidence or progress was committed. Reduce the import or ask the operator to review capacity.`,
    );
    this.name = "ImportBudgetExceeded";
  }
}

/** Content-free classification; never attach either version of the source. */
export class ImmutableSourceConflictError extends Error {
  constructor() {
    super("Source IDs are immutable");
    this.name = "ImmutableSourceConflictError";
  }
}

// Process-local cancellation only. Durable tombstones/admission remain the
// authority, including when another store instance performs the deletion.
const activeExtractions = new WeakMap<
  EvidenceStore,
  Map<AbortController, string[]>
>();

// Never include input data in validation errors (these may reach operator logs).
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Invalid memory input");
  return result.data;
}
function dependencies(claim: Claim): string[] {
  // Grounding can retain quoted evidence even when a trusted writer omitted it
  // from the top-level edges. Every explicit reference is a privacy dependency.
  const grounding = claim.grounding;
  return [
    ...claim.dependsOn,
    ...claim.contradicts,
    ...claim.supersedes,
    ...(claim.extractionContext?.sourceIds ?? []),
    ...(claim.extractionContext?.claimIds ?? []),
    ...(grounding
      ? [
          grounding.subjectSourceId,
          ...grounding.citations.map((citation) => citation.sourceId),
          ...grounding.contradicts,
          ...grounding.supersedes,
        ]
      : []),
  ];
}

function removeEvidence(state: State, sourceIds: string[]): Set<string> {
  // Old extracted outputs cannot prove independence from any forgotten input.
  // Keep their source-set receipts exhausted, never infer or refill provenance.
  const removed = new Set([
    ...sourceIds,
    ...state.proposals
      .filter((proposal) => proposal.claim.extractionContext === undefined)
      .map((proposal) => proposal.id),
  ]);
  // References only point backwards, but fixed point also handles rebuilding.
  let changed = true;
  while (changed) {
    changed = false;
    for (const claim of state.claims) {
      if (
        !removed.has(claim.id) &&
        dependencies(claim).some((ref) => removed.has(ref))
      ) {
        removed.add(claim.id);
        changed = true;
      }
    }
  }
  state.sources = state.sources.filter((s) => !removed.has(s.id));
  state.claims = state.claims.filter((c) => !removed.has(c.id));
  state.corrections = state.corrections.filter((c) => !removed.has(c.sourceId));
  state.proposals = state.proposals.filter((p) => {
    if (
      !removed.has(p.id) &&
      !dependencies(p.claim).some((ref) => removed.has(ref))
    )
      return true;
    removed.add(p.id);
    return false;
  });
  // Admission receipts survive forgetting, even when all results are removed.
  for (const entry of state.extractions)
    entry.proposalIds = entry.proposalIds.filter((id) => !removed.has(id));
  for (const extraction of state.importExtractions) {
    if (
      [...extraction.sourceIds, ...extraction.contextClaimIds].some((id) =>
        removed.has(id),
      )
    )
      extraction.status = "cancelled";
    extraction.proposalIds = extraction.proposalIds.filter(
      (id) => !removed.has(id),
    );
  }
  state.tombstones = [...new Set([...state.tombstones, ...removed])];
  return removed;
}

// Count records and measure the exact supplied object, including its metadata.
function measureCapacity(snapshot: { sources: Source[]; claims: Claim[] }) {
  return {
    sources: snapshot.sources.length,
    claims: snapshot.claims.length,
    serializedBytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
  };
}

/** Upgrade the old Gmail connector's label-valued conversation without changing
 * evidence IDs, audiences, claims, tombstones or authorized import selections.
 * Applied on every snapshot read; the next transaction persists the upgrade.
 */
function upgradeGmailConversation(source: Source): void {
  if (
    source.platform !== "gmail" ||
    !/^[A-Za-z0-9_]+$/.test(source.conversation)
  )
    return;
  try {
    const body = JSON.parse(source.text);
    if (
      body.kind === "historical-evidence" &&
      body.method === "gmail.users.messages.get" &&
      typeof body.message === "string" &&
      /^[a-f0-9]+$/i.test(body.message) &&
      typeof body.thread === "string" &&
      /^[a-f0-9]+$/i.test(body.thread) &&
      source.id === `gmail:${source.account}:${body.message}` &&
      source.sourceUrl ===
        `https://mail.google.com/mail/u/${encodeURIComponent(source.account)}/#all/${body.thread}`
    )
      source.conversation = `thread:${body.thread}`;
  } catch {
    // Other Gmail evidence formats are not this connector's legacy records.
  }
}

function insertSource(state: State, source: Source) {
  if (state.tombstones.includes(source.id))
    throw new Error("Tombstoned evidence cannot reappear");
  const previous = state.sources.find((s) => s.id === source.id);
  if (previous) {
    if (!isDeepStrictEqual(previous, source))
      throw new ImmutableSourceConflictError();
    return;
  }
  if (state.claims.some((c) => c.id === source.id))
    throw new Error("Evidence ID already exists");
  state.sources.push(source);
}

function insertClaim(state: State, claim: Claim): void {
  if (
    state.tombstones.includes(claim.id) ||
    state.sources.some((s) => s.id === claim.id)
  )
    throw new Error("Evidence ID unavailable");
  const previous = state.claims.find((c) => c.id === claim.id);
  if (previous) {
    if (!isDeepStrictEqual(previous, claim))
      throw new Error("Claim IDs are immutable");
    return;
  }
  for (const ref of dependencies(claim)) {
    const evidence =
      state.sources.find((s) => s.id === ref) ??
      state.claims.find((c) => c.id === ref);
    if (
      !evidence ||
      !claim.audiences.every((a) => evidence.audiences.includes(a))
    )
      throw new Error("Missing or unauthorized evidence");
  }
  for (const ref of [
    ...claim.contradicts,
    ...claim.supersedes,
    ...(claim.extractionContext?.claimIds ?? []),
  ]) {
    if (!state.claims.some((c) => c.id === ref))
      throw new Error("Relations require claims");
  }
  state.claims.push(claim);
}

/** Trusted operator boundary, NOT an authorization service. Audience strings must
 * come from authenticated routing/configuration, never model/imported text.
 * IDs must be stable platform/account-qualified IDs. Entity IDs are explicit;
 * display names are never resolved/merged. All stored fields are encrypted.
 * Keep the database outside Git in an owner-only directory. The key is supplied
 * by a secret manager and is never stored here. One encrypted snapshot is the
 * durable source ledger; the in-memory search index is rebuilt on each read.
 */
export class EvidenceStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  readonly importBudget: Readonly<ImportBudget>;
  private closed = false;
  private readonly sinceOpenedAt = Date.now();
  private readStatus: LedgerOperationStatus = {
    status: "unknown",
    attemptedAt: null,
    lastSucceededAt: null,
  };
  private transactionStatus: LedgerOperationStatus = {
    status: "unknown",
    attemptedAt: null,
    lastSucceededAt: null,
  };
  private readonly persistence = {
    calls: 0,
    completed: 0,
    failed: 0,
    totalDurationMs: 0,
    maxDurationMs: null as number | null,
  };
  private readonly retrieval = {
    calls: 0,
    completed: 0,
    failed: 0,
    totalDurationMs: 0,
    maxDurationMs: null as number | null,
  };
  private readonly index = new Map<
    string,
    { sources: Source[]; claims: Claim[] }
  >();

  constructor(
    path: string,
    key: Uint8Array,
    importBudget: Partial<ImportBudget> = {},
  ) {
    parse(id, path);
    if (!(key instanceof Uint8Array) || key.byteLength !== 32)
      throw new Error("Memory key must be 32 bytes");
    this.importBudget = Object.freeze(
      parse(importBudgetSchema, { ...DEFAULT_IMPORT_BUDGET, ...importBudget }),
    );
    this.key = Buffer.from(key);
    this.db = new DatabaseSync(path);
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;",
      );
      const exists = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='records'",
        )
        .get();
      if (!exists) {
        const attemptedAt = Date.now();
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(
            "CREATE TABLE records (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL)",
          );
          this.write({
            version: 1,
            sources: [],
            claims: [],
            tombstones: [],
            imports: [],
            proposals: [],
            extractions: [],
            corrections: [],
            importExtractions: [],
          });
          this.db.exec("COMMIT");
          this.transactionStatus = {
            status: "succeeded",
            attemptedAt,
            lastSucceededAt: Date.now(),
          };
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
      this.rebuildIndex();
    } catch {
      this.db.close();
      this.key.fill(0);
      throw new Error("Memory store could not be authenticated or opened");
    }
  }

  /** Content-free, ledger-wide observations for this instance only. No I/O;
   * an open handle or historical success does not establish current health. */
  operationStatus() {
    return {
      connection: this.closed ? ("closed" as const) : ("open" as const),
      sinceOpenedAt: this.sinceOpenedAt,
      read: { ...this.readStatus },
      transaction: { ...this.transactionStatus },
      persistence: { ...this.persistence },
      retrieval: { ...this.retrieval },
    };
  }

  private read(): State {
    const attemptedAt = Date.now();
    try {
      if (this.closed) throw new Error("Memory store closed");
      const row = this.db
        .prepare("SELECT payload FROM records WHERE id=1")
        .get();
      if (!row || !(row.payload instanceof Uint8Array)) throw new Error();
      const bytes = Buffer.from(row.payload);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from("june-evidence-v1"));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const state = parse(
        stateSchema,
        JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(28)),
            decipher.final(),
          ]).toString("utf8"),
        ),
      );
      for (const source of state.sources) upgradeGmailConversation(source);
      // Older snapshots may still contain grounding-only derivatives of a
      // tombstoned source. Hide them on every read; the next write persists this.
      if (state.tombstones.length) removeEvidence(state, state.tombstones);
      this.readStatus = {
        status: "succeeded",
        attemptedAt,
        lastSucceededAt: Date.now(),
      };
      return state;
    } catch {
      this.readStatus = { ...this.readStatus, status: "failed", attemptedAt };
      throw new Error(
        this.closed
          ? "Memory store closed"
          : "Memory store authentication failed",
      );
    }
  }

  private write(state: State) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from("june-evidence-v1"));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(state), "utf8"),
      cipher.final(),
    ]);
    this.db
      .prepare(
        "INSERT INTO records(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(Buffer.concat([nonce, cipher.getAuthTag(), encrypted]));
  }

  private transaction(change: (state: State) => void) {
    const started = performance.now();
    const attemptedAt = Date.now();
    let began = false;
    let completed = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const state = this.read();
      change(state);
      this.write(state);
      this.db.exec("COMMIT");
      completed = true;
      this.transactionStatus = {
        status: "succeeded",
        attemptedAt,
        lastSucceededAt: Date.now(),
      };
      this.index.clear();
    } catch (error) {
      this.transactionStatus = {
        ...this.transactionStatus,
        status: "failed",
        attemptedAt,
      };
      if (began) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      // Count settled attempts, not records. BEGIN/COMMIT/rollback failures are
      // included; pre-transaction validation and initial empty-store setup are not.
      const timing = this.persistence;
      if (timing.calls < Number.MAX_SAFE_INTEGER) {
        const duration = Math.max(0, performance.now() - started);
        timing.calls++;
        timing[completed ? "completed" : "failed"]++;
        timing.totalDurationMs = Math.min(
          Number.MAX_SAFE_INTEGER,
          timing.totalDurationMs + duration,
        );
        timing.maxDurationMs = Math.max(timing.maxDurationMs ?? 0, duration);
      }
    }
  }

  appendSource(input: Source): void {
    const source = parse(sourceSchema, input);
    this.transaction((state) => insertSource(state, source));
  }

  /** Trusted live owner command only, never imports, context, or model output.
   * Bind to one private source without altering its canonical representation.
   * Retrying the same source is safe; changing its attestation is forbidden. */
  recordOwnerCorrection(
    audience: string,
    sourceId: string,
    input: NonNullable<Source["correction"]>,
  ): void {
    const correction = parse(correctionSchema, input);
    this.transaction((state) => {
      const source = state.sources.find((s) => s.id === sourceId);
      if (
        !source ||
        state.tombstones.includes(sourceId) ||
        !isDeepStrictEqual(source.audiences, [audience])
      )
        throw new Error("Missing or unauthorized correction source");
      const previous =
        source.correction ??
        state.corrections.find((c) => c.sourceId === sourceId)?.correction;
      if (previous) {
        if (!isDeepStrictEqual(previous, correction))
          throw new Error("Owner corrections are immutable");
        return;
      }
      state.corrections.push({ sourceId, correction });
    });
  }

  /** Trusted ingestion/deletion path only; not a model-visible existence oracle. */
  isDeleted(sourceId: string): boolean {
    parse(id, sourceId);
    return this.read().tombstones.includes(sourceId);
  }

  /** Monotonic privacy revision, including deletions completed before restart. */
  deletionRevision(): number {
    return this.read().tombstones.length;
  }

  source(audience: string, sourceId: string): Source | undefined {
    parse(id, sourceId);
    return this.search(audience, "").sources.find((s) => s.id === sourceId);
  }

  /** Exact model-facing source projection. Never expose foreign/deleted IDs or
   * clip an original into a purported complete quotation. Same opt-out as recall. */
  retrieveSource(
    audience: string,
    sourceId: string,
    options: { maxCharacters?: number } = {},
  ): MemoryRetrieval {
    const budget = parse(
      z.number().int().min(100).max(100000),
      options.maxCharacters ?? 16000,
    );
    const source = this.source(audience, sourceId);
    if (
      !source ||
      (source.platform === "slack" && source.text.startsWith("##"))
    )
      return { sources: [], claims: [] };
    const result = { sources: [source], claims: [] };
    return JSON.stringify(result).length <= budget
      ? result
      : { sources: [], claims: [], truncated: true, omitted: 1 };
  }

  /** Read-only exact-target preview. Counts and fingerprint include authorized
   * records only; accepted proposals also appear among claims. Never serialize
   * the whole result into model context/history: binding fields are host-only. */
  previewForget(audience: string, sourceId: string): ForgetPreview | undefined {
    const claims = this.sourceDependents(audience, sourceId);
    if (!claims) return undefined;
    const affected = new Set([sourceId, ...claims.map((claim) => claim.id)]);
    const state = this.read();
    const proposals = state.proposals.filter(
      (proposal) =>
        proposal.audience === audience &&
        proposal.claim.audiences.includes(audience) &&
        (affected.has(proposal.id) ||
          dependencies(proposal.claim).some((ref) => affected.has(ref))),
    );
    const counts = { pending: 0, accepted: 0, rejected: 0 };
    for (const proposal of proposals) counts[proposal.status]++;
    // Every path to a hidden target first crosses this authorized closure.
    // Test that boundary without exposing hidden IDs/counts in the fingerprint.
    const proposalIds = new Set(proposals.map((proposal) => proposal.id));
    const confirmable =
      !state.claims.some(
        (claim) =>
          !affected.has(claim.id) &&
          dependencies(claim).some((ref) => affected.has(ref)),
      ) &&
      !state.proposals.some(
        (proposal) =>
          !proposalIds.has(proposal.id) &&
          (affected.has(proposal.id) ||
            dependencies(proposal.claim).some((ref) => affected.has(ref))),
      );
    const identity = (claim: Claim) => [
      claim.id,
      [...new Set(dependencies(claim))].sort(),
    ];
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          audience,
          sourceId,
          claims.sort((a, b) => a.id.localeCompare(b.id)).map(identity),
          proposals
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((p) => [p.status, identity(p.claim)]),
        ]),
      )
      .digest("hex");
    return {
      sourceId,
      sources: 1,
      claims: claims.length,
      proposals: counts,
      fingerprint,
      confirmable,
      physicalPurge: false,
    };
  }

  appendClaim(input: Claim): void {
    const claim = parse(claimSchema, input);
    this.transaction((state) => insertClaim(state, claim));
  }

  /** Exact scoped input for extraction, never an unfiltered model context. Reject
   * rather than truncate oversized batches so citations refer to the actual input. */
  extractionContext(audience: string, sourceIds: string[]): Source[] {
    parse(ids, sourceIds);
    const visible = this.search(audience, "").sources.filter(
      (source) =>
        !(source.platform === "slack" && source.text.startsWith("##")),
    );
    const sources = sourceIds.map((sourceId) => {
      const source = visible.find((s) => s.id === sourceId);
      if (!source) throw new Error("Missing or unauthorized source");
      return source;
    });
    if (sources.length > 20 || JSON.stringify(sources).length > 64000)
      throw new Error("Extraction batch too large");
    return sources;
  }

  /** Untrusted extractor output is an array of MemoryProposalInput. Quotes prove
   * provenance, NOT truth/entailment; only authenticated review accepts a claim.
   * subjectSourceId names a cited Source; its platform/account/author identifies
   * the subject, never a display name supplied by the extractor. */
  stageProposals(
    audience: string,
    sourceIds: string[],
    output: unknown,
    importExtractionId?: string,
    contextClaimIds: string[] = [],
  ): MemoryProposal[] {
    const inputs = parse(z.array(proposalInputSchema).max(20), output);
    const sources = this.extractionContext(audience, sourceIds);
    const selected = sources.map((source) => source.id).sort();
    const context = {
      sourceIds: selected,
      claimIds: [
        ...new Set(parse(z.array(id).max(20), contextClaimIds)),
      ].sort(),
    };
    const proposals = inputs.map((input): MemoryProposal => {
      const subject = sources.find((s) => s.id === input.subjectSourceId);
      if (!subject || !input.citations.some((c) => c.sourceId === subject.id))
        throw new Error("Subject requires cited source");
      for (const citation of input.citations) {
        const source = sources.find((s) => s.id === citation.sourceId);
        if (
          !source ||
          !citation.quote.trim() ||
          !source.text.includes(citation.quote)
        )
          throw new Error("Unsupported source quotation");
      }
      const grounding = {
        ...input,
        citations: [...input.citations].sort(
          (a, b) =>
            a.sourceId.localeCompare(b.sourceId) ||
            a.quote.localeCompare(b.quote),
        ),
        contradicts: [...new Set(input.contradicts)].sort(),
        supersedes: [...new Set(input.supersedes)].sort(),
      };
      const proposalId = `proposal:${createHash("sha256")
        .update(JSON.stringify([audience, grounding, context]))
        .digest("hex")}`;
      return parse(proposalSchema, {
        id: proposalId,
        audience,
        status: "pending",
        claim: {
          id: proposalId,
          entity: JSON.stringify([
            subject.platform,
            subject.account,
            subject.author,
          ]),
          text: input.text,
          audiences: [audience],
          kind: "evidence",
          dependsOn: [
            ...new Set(input.citations.map((c) => c.sourceId)),
          ].sort(),
          contradicts: grounding.contradicts,
          supersedes: grounding.supersedes,
          extractionContext: context,
          grounding,
        },
      });
    });
    let admitted: string[] = [];
    this.transaction((state) => {
      const extraction = importExtractionId
        ? state.importExtractions.find((e) => e.id === importExtractionId)
        : undefined;
      if (
        importExtractionId &&
        (extraction?.status !== "started" ||
          extraction.audience !== audience ||
          !isDeepStrictEqual(extraction.sourceIds, sourceIds) ||
          !isDeepStrictEqual(
            [...extraction.contextClaimIds].sort(),
            context.claimIds,
          ) ||
          !extraction.contextClaimIds.every((id) =>
            state.claims.some(
              (c) => c.id === id && c.audiences.includes(audience),
            ),
          ))
      )
        throw new Error("Import extraction no longer authorized");
      // Source IDs are immutable revision identities. Admission belongs to the
      // exact scoped input set, not model wording, confidence or input order.
      // Recheck even empty outputs so deletion in flight cannot leave a receipt.
      for (const source of sources) {
        if (
          !isDeepStrictEqual(
            state.sources.find((s) => s.id === source.id),
            source,
          )
        )
          throw new Error("Missing or unauthorized source");
      }
      // Recheck even empty outputs inside the same admission transaction.
      for (const ref of context.claimIds)
        if (
          !state.claims.some(
            (claim) => claim.id === ref && claim.audiences.includes(audience),
          )
        )
          throw new Error("Missing or unauthorized comparison claim");
      const previous = state.extractions.find(
        (entry) =>
          entry.audience === audience &&
          isDeepStrictEqual(entry.sourceIds, selected),
      );
      if (previous) {
        admitted = previous.proposalIds;
      } else {
        const fresh = proposals.filter((proposal) => {
          // Pre-receipt snapshots used grounding-only identities. Never launder
          // their unknown context (or tombstones) into a newly tracked identity.
          const legacyId = `proposal:${createHash("sha256")
            .update(JSON.stringify([audience, proposal.claim.grounding]))
            .digest("hex")}`;
          return (
            !state.tombstones.includes(legacyId) &&
            !state.proposals.some(
              (p) =>
                p.id === legacyId && p.claim.extractionContext === undefined,
            )
          );
        });
        for (const proposal of fresh) {
          // Validate against today's state within the write transaction, including
          // deletion while extraction was in flight. Do not publish pending claims.
          insertClaim({ ...state, claims: [...state.claims] }, proposal.claim);
          if (!state.proposals.some((p) => p.id === proposal.id))
            state.proposals.push(proposal);
        }
        admitted = fresh.map((proposal) => proposal.id);
        state.extractions.push({
          audience,
          sourceIds: selected,
          proposalIds: admitted,
        });
      }
      // Completion and proposals commit together, including an empty result.
      if (extraction) {
        extraction.status = "staged";
        extraction.proposalIds = admitted;
      }
    });
    const saved = this.proposals(audience);
    return admitted.flatMap((id) => saved.find((s) => s.id === id) ?? []);
  }

  proposals(audience: string): MemoryProposal[] {
    parse(id, audience);
    return this.read().proposals.filter((p) => p.audience === audience);
  }

  proposal(audience: string, proposalId: string): MemoryProposal | undefined {
    parse(id, proposalId);
    return this.proposals(audience).find((p) => p.id === proposalId);
  }

  /** Trusted operator action, not a model tool. Repeated identical decisions are
   * idempotent; rejected proposals cannot silently become accepted on retry. */
  reviewProposal(
    audience: string,
    proposalId: string,
    decision: "accepted" | "rejected",
  ): void {
    parse(id, audience);
    parse(id, proposalId);
    parse(z.enum(["accepted", "rejected"]), decision);
    this.transaction((state) => {
      const proposal = state.proposals.find(
        (p) => p.id === proposalId && p.audience === audience,
      );
      if (!proposal) throw new Error("Missing or unauthorized proposal");
      if (proposal.status !== "pending" && proposal.status !== decision)
        throw new Error("Proposal already reviewed");
      if (decision === "accepted") insertClaim(state, proposal.claim);
      proposal.status = decision;
    });
  }

  /** Reviewed patterns are context even without a lexical match. Keep complete
   * grounding and source links, not raw episodes or unreviewed reflection output.
   * Re-read every turn; forgetting removes proposals and their derived claims. */
  reviewedPatterns(audience: string): {
    claim: Claim;
    sources: Pick<Source, "id" | "sourceUrl" | "observedAt">[];
  }[] {
    parse(id, audience);
    const state = this.read();
    const sources = new Map(
      state.sources
        .filter(
          (source) =>
            source.audiences.includes(audience) &&
            !(source.platform === "slack" && source.text.startsWith("##")),
        )
        .map((source) => [source.id, source]),
    );
    const result: ReturnType<EvidenceStore["reviewedPatterns"]> = [];
    // Newest staged first, not confidence-ranked or a claim of review recency.
    for (const proposal of state.proposals.toReversed()) {
      const { claim } = proposal;
      if (
        proposal.audience !== audience ||
        proposal.status !== "accepted" ||
        claim.grounding?.category !== "pattern" ||
        !claim.dependsOn.every((id) => sources.has(id))
      )
        continue;
      result.push({
        claim,
        sources: claim.dependsOn.map((id) => {
          const source = sources.get(id) as Source;
          return {
            id,
            sourceUrl: source.sourceUrl,
            observedAt: source.observedAt,
          };
        }),
      });
      // Omit an oversized record whole; never truncate its citations or edges.
      if (JSON.stringify(result).length > 8000) result.pop();
      if (result.length === 6) break;
    }
    return result;
  }

  /** Original episodes only: a dream/claim repetition never becomes independent
   * reflection evidence. Freshness is measured from source observation time. */
  reflectionEvidence(
    audience: string,
    sourceIds: string[],
    maxAgeMs: number,
  ): Evidence[] {
    parse(timestamp, maxAgeMs);
    const corrections = this.read().corrections;
    return this.extractionContext(audience, sourceIds).map((s) => {
      const correction =
        s.correction ??
        corrections.find((c) => c.sourceId === s.id)?.correction;
      return {
        id: s.id,
        scope: audience,
        text: s.text,
        source: correction ? "owner-correction" : "episode",
        observedAt: s.observedAt,
        expiresAt: parse(timestamp, s.observedAt + maxAgeMs),
        ...(correction ? { correction } : {}),
      };
    });
  }

  /** Scope filtering precedes lexical ranking. Bounded JSON data, not executable
   * instructions; callers must label this untrusted evidence in model context.
   * Keep contradictory and superseded hypotheses, with their explicit edges.
   * Omit whole records, never clip evidence; omission metadata shares the budget. */
  retrieve(
    audience: string,
    query: string,
    options: {
      limit?: number;
      maxCharacters?: number;
      claimsOnly?: boolean;
      category?: MemoryProposalInput["category"];
      /** Exact claim plus one-hop explicit contradiction neighbors; no text query. */
      contradictionsOf?: string;
      paginate?: boolean;
      cursor?: string;
      // Trusted host presentation measurement; never supplied by the model.
      measureCharacters?: (json: string) => number;
      entity?: string;
      observedFrom?: number;
      observedTo?: number;
      validAt?: number;
    } = {},
  ): MemoryRetrieval {
    const started = performance.now();
    let completed = true;
    try {
      parse(z.string().max(10000), query);
      const entity = parse(id.optional(), options.entity);
      const category = proposalInputSchema.shape.category
        .optional()
        .safeParse(options.category);
      if (!category.success)
        throw new Error(
          "Invalid memory category; expected claim, preference, commitment, or pattern",
        );
      const contradictionsOf =
        options.contradictionsOf === undefined
          ? undefined
          : parse(id, options.contradictionsOf);
      if (contradictionsOf !== undefined && query !== "")
        throw new Error("Invalid memory input");
      const limit = parse(
        z.number().int().min(1).max(100),
        options.limit ?? 12,
      );
      const paginate = options.paginate || options.cursor !== undefined;
      const budget = parse(
        z
          .number()
          .int()
          .min(paginate ? 200 : 100)
          .max(100000),
        options.maxCharacters ?? 16000,
      );
      const observedFrom = parse(timestamp.optional(), options.observedFrom);
      const observedTo = parse(timestamp.optional(), options.observedTo);
      const validAt = parse(timestamp.optional(), options.validAt);
      if (
        observedFrom !== undefined &&
        observedTo !== undefined &&
        observedFrom >= observedTo
      )
        throw new Error("Invalid memory observation window");
      const visible = this.search(audience, "");
      // Original observation time, never ingestion time or a claim repetition.
      const observed =
        observedFrom !== undefined || observedTo !== undefined
          ? new Set(
              visible.sources
                .filter(
                  (source) =>
                    (observedFrom === undefined ||
                      source.observedAt >= observedFrom) &&
                    (observedTo === undefined ||
                      source.observedAt < observedTo),
                )
                .map((source) => source.id),
            )
          : undefined;
      // Legacy imports may predate Slack's opt-out. Automatic context must not
      // include those originals or claims derived from them; explicit search stays available.
      const ignored = new Set(
        visible.sources
          .filter(
            (source) =>
              source.platform === "slack" && source.text.startsWith("##"),
          )
          .map((source) => source.id),
      );
      const parents = new Map(
        visible.claims.map((claim) => [
          claim.id,
          [
            ...claim.dependsOn,
            ...(claim.grounding
              ? [
                  claim.grounding.subjectSourceId,
                  ...claim.grounding.citations.map(
                    (citation) => citation.sourceId,
                  ),
                ]
              : []),
          ],
        ]),
      );
      const words = [
        ...new Set(query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)),
      ];
      const eligible = [
        ...visible.sources
          .filter(
            (item) =>
              !options.claimsOnly &&
              category.data === undefined &&
              validAt === undefined &&
              !ignored.has(item.id) &&
              (!observed || observed.has(item.id)) &&
              (entity === undefined ||
                JSON.stringify([item.platform, item.account, item.author]) ===
                  entity),
          )
          .map((item) => ({ type: "source" as const, item })),
        ...visible.claims
          .filter(
            (item) =>
              category.data === undefined ||
              item.grounding?.category === category.data,
          )
          .filter((item) => {
            if (entity !== undefined && item.entity !== entity) return false;
            // Unknown bounds are not infinite bounds; no validity is invented.
            if (
              validAt !== undefined &&
              (item.grounding?.validFrom == null ||
                item.grounding.validTo == null ||
                validAt < item.grounding.validFrom ||
                validAt >= item.grounding.validTo)
            )
              return false;
            if (!observed && ignored.size === 0) return true;
            // Walk this authorized snapshot once per ancestor, even for a shared
            // dependency DAG. Check opt-outs outside the observation window too.
            const pending = [item.id];
            const visited = new Set<string>();
            let matchesObservation = !observed;
            while (pending.length) {
              const ref = pending.pop();
              if (ref === undefined || visited.has(ref)) continue;
              visited.add(ref);
              if (ignored.has(ref)) return false;
              if (observed?.has(ref)) matchesObservation = true;
              pending.push(...(parents.get(ref) ?? []));
            }
            return matchesObservation;
          })
          .map((item) => ({ type: "claim" as const, item })),
      ];
      // Resolve the root only after scope/opt-out filtering. Missing and hidden
      // roots have identical empty results; never synthesize an edge endpoint.
      const root = eligible.find(
        (entry) => entry.type === "claim" && entry.item.id === contradictionsOf,
      );
      const candidates = eligible
        .filter(
          (entry) =>
            contradictionsOf === undefined ||
            (root?.type === "claim" &&
              entry.type === "claim" &&
              (entry.item.id === root.item.id ||
                root.item.contradicts.includes(entry.item.id) ||
                entry.item.contradicts.includes(root.item.id))),
        )
        .map((entry) => ({
          ...entry,
          score:
            entry.item.id === contradictionsOf
              ? 1
              : words.filter((word) =>
                  entry.item.text.toLocaleLowerCase().includes(word),
                ).length,
        }))
        .filter((entry) => !words.length || entry.score > 0)
        .sort(
          (a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id),
        );
      if (paginate) {
        // Immutable records make this a scoped dataset revision. Bind all effective
        // filters/bounds, not only matching IDs: even equivalent searches are not
        // interchangeable. Invisible records never enter the fingerprint.
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify([
              audience,
              query,
              Object.entries({ ...options, limit, maxCharacters: budget })
                .filter(
                  ([key, value]) =>
                    key !== "cursor" &&
                    key !== "paginate" &&
                    value !== undefined,
                )
                .sort(([a], [b]) => a.localeCompare(b)),
              candidates.map(({ item, score }) => [item.id, score]),
            ]),
          )
          .digest("hex");
        const cursorFor = (recordId: string) =>
          createHmac("sha256", this.key)
            .update(
              JSON.stringify(["june-recall-page-v1", fingerprint, recordId]),
            )
            .digest("base64url");
        let start = 0;
        if (options.cursor !== undefined) {
          const cursor = options.cursor;
          const boundary = /^[A-Za-z0-9_-]{43}$/.test(cursor)
            ? candidates.findIndex(({ item }) =>
                timingSafeEqual(
                  Buffer.from(cursorFor(item.id)),
                  Buffer.from(cursor),
                ),
              )
            : -1;
          if (boundary < 0)
            throw new Error("Invalid recall cursor; restart the search");
          start = boundary + 1;
        }
        const result: MemoryRetrieval = { sources: [], claims: [] };
        let count = 0;
        let scanned = start;
        const page = (): MemoryRetrieval => {
          const omitted = candidates.length - start - count;
          const boundary = candidates[scanned - 1];
          return {
            ...result,
            ...(omitted ? { truncated: true, omitted } : {}),
            ...(boundary && scanned > start && scanned < candidates.length
              ? { nextCursor: cursorFor(boundary.item.id) }
              : {}),
          };
        };
        const fits = (value: MemoryRetrieval) => {
          const json = JSON.stringify(value);
          return (
            json.length <= budget &&
            (options.measureCharacters?.(json) ?? json.length) <= budget
          );
        };
        for (const candidate of candidates.slice(start)) {
          if (count >= limit) break;
          if (candidate.type === "source") result.sources.push(candidate.item);
          else result.claims.push(candidate.item);
          count++;
          scanned++;
          if (fits(page())) continue;
          if (candidate.type === "source") result.sources.pop();
          else result.claims.pop();
          count--;
          if (scanned > start + 1) {
            // Even previous omissions can consume this page's budget. Retry the
            // whole record on a fresh page before deciding it cannot fit alone.
            scanned--;
            break;
          }
          // A record that cannot fit alone is omitted; advance to avoid a loop.
        }
        const resultPage = page();
        if (!fits(resultPage))
          throw new Error("Recall presentation exceeds character budget");
        return resultPage;
      }
      const result: MemoryRetrieval = { sources: [], claims: [] };
      let count = 0;
      for (const candidate of candidates) {
        if (count >= limit) break;
        if (candidate.type === "source") result.sources.push(candidate.item);
        else result.claims.push(candidate.item);
        const omitted = candidates.length - count - 1;
        if (
          JSON.stringify({
            ...result,
            ...(omitted ? { truncated: true, omitted } : {}),
          }).length > budget
        ) {
          if (candidate.type === "source") result.sources.pop();
          else result.claims.pop();
        } else count++;
      }
      const omitted = candidates.length - count;
      return { ...result, ...(omitted ? { truncated: true, omitted } : {}) };
    } catch (error) {
      completed = false;
      throw error;
    } finally {
      // Fixed scalar aggregates only: never retain query, audience, evidence,
      // or error details. Failed attempts contribute to duration too.
      const cap = Number.MAX_SAFE_INTEGER;
      const duration = Math.min(cap, Math.max(0, performance.now() - started));
      const timing = this.retrieval;
      timing.calls = Math.min(cap, timing.calls + 1);
      const outcome = completed ? "completed" : "failed";
      timing[outcome] = Math.min(cap, timing[outcome] + 1);
      timing.totalDurationMs = Math.min(cap, timing.totalDurationMs + duration);
      timing.maxDurationMs = Math.max(timing.maxDurationMs ?? 0, duration);
    }
  }

  /** Aggregate-only owner report; authorization belongs to the host caller. */
  operationReport(): string {
    const status = this.operationStatus();
    return [
      `Memory operation snapshot at ${new Date().toISOString()}: ${JSON.stringify(status)}.`,
      `Process-local since store opened at ${new Date(status.sinceOpenedAt).toISOString()}; resets on reopen/restart, not the selected usage day window. Past success is not proof of current health or complete recall.`,
      "Retrieval covers all retrieve() attempts across audiences (including validation/read failures); excludes separate search() and reflection-evidence reads. Durations are milliseconds for the whole synchronous operation, not model or end-to-end latency. Total and max include failures; null max means unobserved, not zero. Counters saturate at Number.MAX_SAFE_INTEGER. No queries, evidence, identities, errors or per-call records retained.",
      "Persistence timing, when present, counts settled evidence transaction attempts (including no-op commits), not records: completion requires COMMIT; durations include BEGIN, read/change/encrypt/write, COMMIT and any rollback. Initial empty-ledger creation, pre-transaction validation, curated Git saves and historical writes are excluded.",
    ].join("\n");
  }

  search(
    audience: string,
    query: string,
  ): { sources: Source[]; claims: Claim[] } {
    parse(id, audience);
    parse(z.string().max(10000), query);
    this.rebuildIndex();
    // Authorization precedes content matching; no unauthorized items are ranked,
    // summarized, or returned. Returning parsed copies cannot mutate the store.
    const { sources, claims } = this.index.get(audience) ?? {
      sources: [],
      claims: [],
    };
    const needle = query.toLocaleLowerCase();
    return {
      sources: sources.filter((s) =>
        s.text.toLocaleLowerCase().includes(needle),
      ),
      claims: claims.filter((c) => c.text.toLocaleLowerCase().includes(needle)),
    };
  }

  /** Content-free usage for one host-authorized audience, not total disk usage.
   * Bytes measure UTF-8 JSON of {sources,claims}, including record metadata.
   * No audience quota; importBudget separately bounds global page admission. */
  capacity(audience: string) {
    const visible = this.search(audience, "");
    return {
      ...measureCapacity(visible),
      limits: { sources: null, claims: null, serializedBytes: null },
    };
  }

  /** Explicit updates only, in both directions from an accepted claim. Scope
   * filtering precedes expansion; no inferred relation, date ordering or truth
   * winner. Missing/foreign roots are indistinguishable. Bounds omit whole nodes
   * and their edges, never leave dangling endpoints or expose hidden IDs. */
  inspectSupersession(
    audience: string,
    claimId: string,
    options: { limit?: number; maxCharacters?: number } = {},
  ): SupersessionInspection {
    parse(id, claimId);
    const limit = parse(z.number().int().min(1).max(100), options.limit ?? 6);
    const budget = parse(
      z.number().int().min(100).max(100000),
      options.maxCharacters ?? 3000,
    );
    const visible = this.search(audience, "");
    const ignored = new Set(
      visible.sources
        .filter((s) => s.platform === "slack" && s.text.startsWith("##"))
        .map((s) => s.id),
    );
    // Opt-outs cannot be recovered via a relation or a derived claim.
    let changed = true;
    while (changed) {
      changed = false;
      for (const claim of visible.claims) {
        if (
          !ignored.has(claim.id) &&
          dependencies(claim).some((ref) => ignored.has(ref))
        ) {
          ignored.add(claim.id);
          changed = true;
        }
      }
    }
    const claims = new Map(
      visible.claims.filter((c) => !ignored.has(c.id)).map((c) => [c.id, c]),
    );
    const result: SupersessionInspection = {
      claims: [],
      incomplete: false,
      cyclic: false,
    };
    if (!claims.has(claimId)) return result;
    const newer = new Map<string, string[]>();
    const older = new Map<string, string[]>();
    for (const claim of claims.values()) {
      const refs = [...new Set(claim.supersedes)].filter((ref) =>
        claims.has(ref),
      );
      older.set(claim.id, refs.sort());
      for (const ref of refs) {
        const incoming = newer.get(ref) ?? [];
        incoming.push(claim.id);
        newer.set(ref, incoming);
      }
    }
    const selected = new Set([claimId]);
    for (const ref of selected) {
      if (claims.get(ref)?.supersedes.some((target) => !claims.has(target)))
        result.incomplete = true;
      for (const neighbor of [
        ...(newer.get(ref) ?? []),
        ...(older.get(ref) ?? []),
      ].sort()) {
        if (selected.has(neighbor)) continue;
        if (selected.size < limit) selected.add(neighbor);
        else result.incomplete = true;
      }
    }
    // Topological order preserves branching updates; visited sets also keep a
    // malformed authenticated snapshot from looping on a supersession cycle.
    const remaining = new Set(selected);
    const ordered: string[] = [];
    while (remaining.size) {
      const heads = [...remaining]
        .filter((ref) => !(newer.get(ref) ?? []).some((n) => remaining.has(n)))
        .sort();
      if (!heads.length) {
        result.cyclic = true;
        ordered.push(...[...remaining].sort());
        break;
      }
      for (const ref of heads) {
        remaining.delete(ref);
        ordered.push(ref);
      }
    }
    const project = () =>
      ordered
        .filter((ref) => selected.has(ref))
        .map((ref) => {
          const claim = claims.get(ref) as Claim;
          return {
            id: claim.id,
            text: claim.text,
            kind: claim.kind,
            supersedes: (older.get(ref) ?? []).filter((n) => selected.has(n)),
            supersededBy: (newer.get(ref) ?? [])
              .filter((n) => selected.has(n))
              .sort(),
          };
        });
    result.claims = project();
    while (JSON.stringify(result).length > budget) {
      // Prefer retaining the requested anchor; do not clip claim text.
      const removed =
        [...selected].reverse().find((ref) => ref !== claimId) ?? claimId;
      selected.delete(removed);
      result.incomplete = true;
      result.claims = project();
    }
    return result;
  }

  /** Unique original source IDs, never a count of dream/claim repetitions. */
  independentEvidence(claimId: string, audience: string): string[] {
    parse(id, claimId);
    const visible = this.search(audience, "");
    const found = new Set<string>();
    const sources = new Set(visible.sources.map((s) => s.id));
    const claims = new Map(visible.claims.map((c) => [c.id, c]));
    const visited = new Set([claimId]);
    for (const ref of visited) {
      if (sources.has(ref)) found.add(ref);
      else
        for (const parent of claims.get(ref)?.dependsOn ?? [])
          visited.add(parent);
    }
    return [...found].sort();
  }

  /** Scope before traversal. Shared by bounded inspection projections. */
  private sourceDependents(
    audience: string,
    sourceId: string,
  ): Claim[] | undefined {
    parse(id, sourceId);
    const visible = this.search(audience, "");
    // Missing, deleted and foreign sources have indistinguishable absence.
    if (!visible.sources.some((source) => source.id === sourceId))
      return undefined;
    const reached = new Set([sourceId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const claim of visible.claims) {
        if (
          !reached.has(claim.id) &&
          dependencies(claim).some((ref) => reached.has(ref))
        ) {
          reached.add(claim.id);
          changed = true;
        }
      }
    }
    return visible.claims.filter((claim) => reached.has(claim.id));
  }

  /** Read-only reverse dependency view of stored claims, not pending proposals.
   * Match deletion's dependency edges, but authorize before traversal/counts.
   * Return whole ID/kind records only; claim/source content is separate recall. */
  dependentClaims(
    audience: string,
    sourceId: string,
    options: { limit?: number; maxCharacters?: number } = {},
  ): DependentClaims | undefined {
    const limit = parse(z.number().int().min(1).max(100), options.limit ?? 12);
    const budget = parse(
      z.number().int().min(100).max(100000),
      options.maxCharacters ?? 3000,
    );
    const claims = this.sourceDependents(audience, sourceId);
    if (!claims) return undefined;
    const candidates = claims
      .map((claim) => ({
        id: claim.id,
        kind: claim.kind,
        dependency: dependencies(claim).includes(sourceId)
          ? ("direct" as const)
          : ("derived" as const),
      }))
      .sort(
        (a, b) =>
          Number(b.dependency === "direct") -
            Number(a.dependency === "direct") || a.id.localeCompare(b.id),
      );
    const direct = candidates.filter((c) => c.dependency === "direct").length;
    const result: DependentClaims = {
      claims: [],
      direct,
      derived: candidates.length - direct,
      omitted: candidates.length,
    };
    for (const candidate of candidates) {
      if (result.claims.length >= limit) break;
      result.claims.push(candidate);
      result.omitted--;
      if (JSON.stringify(result).length > budget) {
        result.claims.pop();
        result.omitted++;
      }
    }
    return result;
  }

  deleteSource(sourceId: string): void {
    parse(id, sourceId);
    let removed = new Set<string>();
    this.transaction((state) => {
      if (state.claims.some((c) => c.id === sourceId))
        throw new Error("Expected source ID");
      removed = removeEvidence(state, [sourceId]);
    });
    // Tombstone first: abort listeners must observe the committed deletion.
    // Do not release admission here; the provider may ignore cancellation.
    for (const [controller, evidenceIds] of activeExtractions.get(this) ?? [])
      if (evidenceIds.some((id) => removed.has(id)))
        controller.abort(new Error("Memory changed during extraction"));
  }

  rebuildIndex(): void {
    this.index.clear();
    const state = this.read();
    for (const source of state.sources) {
      for (const audience of source.audiences) {
        const bucket = this.index.get(audience) ?? { sources: [], claims: [] };
        bucket.sources.push(source);
        this.index.set(audience, bucket);
      }
    }
    for (const claim of state.claims) {
      for (const audience of claim.audiences) {
        const bucket = this.index.get(audience) ?? { sources: [], claims: [] };
        bucket.claims.push(claim);
        this.index.set(audience, bucket);
      }
    }
  }

  importProgress(jobId: string): ImportProgress | undefined {
    parse(id, jobId);
    return this.read().imports.find((p) => p.id === jobId);
  }

  /** Includes jobs no longer configured, so reauthorization cannot reset pacing. */
  importCooldown(platform: string, account: string) {
    let cooldown: Pick<ImportProgress, "notBefore" | "cooldownReason"> = {
      notBefore: 0,
    };
    for (const progress of this.read().imports) {
      if (
        progress.coverage.platform === platform &&
        progress.coverage.account === account &&
        progress.notBefore > cooldown.notBefore
      )
        cooldown = {
          notBefore: progress.notBefore,
          cooldownReason: progress.cooldownReason,
        };
    }
    return cooldown;
  }

  importExtractions(audience: string): ImportExtraction[] {
    parse(id, audience);
    return this.read().importExtractions.filter((e) => e.audience === audience);
  }

  /** Persist intent before a paid call. Overlapping jobs/batches cannot repeat
   * any previously attempted input, even after cancellation or uncertain exit. */
  beginImportExtraction(input: ImportExtraction): void {
    const extraction = parse(importExtractionSchema, input);
    if (extraction.status !== "started" || extraction.proposalIds.length)
      throw new Error("Invalid extraction intent");
    this.transaction((state) => {
      const progress = state.imports.find((p) => p.id === extraction.importId);
      if (
        !progress?.coverage.audiences.includes(extraction.audience) ||
        !extraction.sourceIds.every((id) => progress.sourceIds.includes(id)) ||
        state.importExtractions.some(
          (e) =>
            e.id === extraction.id ||
            (e.audience === extraction.audience &&
              (e.status === "started" ||
                e.sourceIds.some((id) => extraction.sourceIds.includes(id)))),
        )
      )
        throw new Error("Import extraction already attempted or unauthorized");
      this.extractionContext(extraction.audience, extraction.sourceIds);
      state.importExtractions.push(extraction);
    });
  }

  stopImportExtraction(
    extractionId: string,
    status: "uncertain" | "cancelled",
  ): void {
    parse(id, extractionId);
    parse(z.enum(["uncertain", "cancelled"]), status);
    this.transaction((state) => {
      const extraction = state.importExtractions.find(
        (e) => e.id === extractionId,
      );
      if (!extraction) throw new Error("Missing import extraction");
      if (extraction.status === "started") extraction.status = status;
    });
  }

  beginImport(jobId: string, input: ImportCoverage): void {
    parse(id, jobId);
    const coverage = parse(coverageSchema, input);
    this.transaction((state) => {
      const previous = state.imports.find((p) => p.id === jobId);
      if (previous) {
        if (!isDeepStrictEqual(previous.coverage, coverage))
          throw new Error(
            "Import coverage is immutable; reauthorize a new job",
          );
      } else
        state.imports.push({
          id: jobId,
          coverage,
          cursor: null,
          pages: 0,
          complete: false,
          notBefore: 0,
          gaps: [],
          sourceIds: [],
          trackedPages: 0,
        });
    });
  }

  private checkImportBudget(state: State): void {
    // The entire candidate snapshot counts, not only newly fetched sources or
    // audience-visible evidence. Check under the write lock, after deduplication.
    const usage = measureCapacity(state);
    for (const dimension of ["sources", "claims", "serializedBytes"] as const)
      if (usage[dimension] > this.importBudget[dimension])
        throw new ImportBudgetExceeded(dimension);
  }

  /** Atomic compare-and-swap prevents concurrent fetches advancing stale pages. */
  persistPage(expected: ImportProgress, input: ImportPage, now: number): void {
    const page = parse(pageSchema, input);
    parse(timestamp, now);
    this.transaction((state) => {
      const progress = state.imports.find((p) => p.id === expected.id);
      if (
        !progress ||
        !isDeepStrictEqual(progress, expected) ||
        progress.complete ||
        now < progress.notBefore
      )
        throw new Error("Stale import page");
      if (page.rateLimited) {
        if (page.sources.length || !page.retryAfterMs)
          throw new Error("Invalid rate limit boundary");
        progress.notBefore = parse(timestamp, now + page.retryAfterMs);
        progress.cooldownReason = page.cooldownReason ?? "rate_limit";
        this.checkImportBudget(state);
        return;
      }
      if (page.nextCursor !== null && page.nextCursor === progress.cursor)
        throw new Error("Import cursor did not advance");
      const c = progress.coverage;
      if (
        page.gmailLabel !== undefined &&
        (c.platform !== "gmail" || !c.conversations.includes(page.gmailLabel))
      )
        throw new Error("Source outside authorized import coverage");
      for (const source of page.sources) {
        // Slack roots and replies share a canonical channel/root-ts conversation
        // across live/history ingestion. A channel grant includes its threads;
        // a thread grant must never widen to sibling threads or the channel.
        const slackChannel =
          c.platform === "slack"
            ? /^([CGD][A-Z0-9]+)\/\d+\.\d{6}$/.exec(source.conversation)?.[1]
            : undefined;
        if (
          source.correction !== undefined ||
          source.platform !== c.platform ||
          source.account !== c.account ||
          (!c.conversations.includes(source.conversation) &&
            !(slackChannel && c.conversations.includes(slackChannel)) &&
            !(
              page.gmailLabel && /^thread:[a-f0-9]+$/i.test(source.conversation)
            )) ||
          source.observedAt < c.from ||
          source.observedAt >= c.to ||
          !source.audiences.every((a) => c.audiences.includes(a))
        )
          throw new Error("Source outside authorized import coverage");
        // Check within the page transaction so deletion during fetch cannot
        // resurrect content. Other records still undergo immutable-ID checks.
        if (state.tombstones.includes(source.id)) {
          progress.gaps.push("Tombstoned evidence omitted");
          continue;
        }
        insertSource(state, source);
      }
      progress.sourceIds = [
        ...new Set([
          ...progress.sourceIds,
          ...page.sources
            .filter((s) => !state.tombstones.includes(s.id))
            .map((s) => s.id),
        ]),
      ];
      progress.trackedPages++;
      progress.cursor = page.nextCursor;
      progress.complete = page.nextCursor === null;
      progress.pages++;
      progress.notBefore = parse(timestamp, now + (page.retryAfterMs ?? 0));
      progress.cooldownReason = page.retryAfterMs ? "pacing" : null;
      progress.gaps.push(...(page.gaps ?? []));
      this.checkImportBudget(state);
    });
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.key.fill(0);
      this.index.clear();
      this.closed = true;
    }
  }
}

export type PageFetcher = (request: {
  coverage: ImportCoverage;
  cursor: string | null;
  signal?: AbortSignal;
}) => Promise<ImportPage>;

/** Inject a read-only model adapter: this module never supplies tools, permission
 * grants, or live accounts. Treat sources as quoted data, not instructions.
 * Aborted or deleted inputs cannot publish proposals after provider completion. */
export async function extractMemory(
  store: EvidenceStore,
  audience: string,
  sourceIds: string[],
  extract: (
    sources: Source[],
    existingClaims: Claim[],
    signal?: AbortSignal,
  ) => Promise<unknown>,
  signal?: AbortSignal,
  importExtractionId?: string,
): Promise<MemoryProposal[]> {
  signal?.throwIfAborted();
  const selected = [...sourceIds];
  const revision = store.deletionRevision();
  const sources = store.extractionContext(audience, selected);
  const { claims } = store.retrieve(audience, "", {
    claimsOnly: true,
    limit: 20,
    maxCharacters: 16000,
  });
  const contextClaimIds = claims.map((claim) => claim.id);
  if (importExtractionId) {
    const intent = store
      .importExtractions(audience)
      .find((e) => e.id === importExtractionId);
    if (
      intent?.status !== "started" ||
      !isDeepStrictEqual(intent.sourceIds, selected) ||
      !isDeepStrictEqual(intent.contextClaimIds, contextClaimIds)
    )
      throw new Error("Import extraction context changed");
  }
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let active = activeExtractions.get(store);
  if (!active) {
    active = new Map();
    activeExtractions.set(store, active);
  }
  active.set(controller, [...selected, ...contextClaimIds]);
  try {
    // Await the provider itself, not an abort race that could free admission
    // while an uncooperative provider is still running.
    const output = await extract(sources, claims, combined);
    combined.throwIfAborted();
    // Even an unreferenced context claim may have influenced the proposal text.
    if (store.deletionRevision() !== revision)
      throw new Error("Memory changed during extraction");
    return store.stageProposals(
      audience,
      selected,
      output,
      importExtractionId,
      contextClaimIds,
    );
  } finally {
    active.delete(controller);
    if (!active.size) activeExtractions.delete(store);
  }
}

/** Read-only ingestion: no tools, actions, instruction replay, or model calls.
 * Rate limits return durable progress instead of sleeping. Call again after
 * notBefore. Coverage [from,to) records requested coverage, not a completeness
 * guarantee: fetchers must report platform retention/permission gaps.
 */
export async function importHistory(
  store: EvidenceStore,
  jobId: string,
  coverage: ImportCoverage,
  fetchPage: PageFetcher,
  options: { signal?: AbortSignal; now?: () => number; maxPages?: number } = {},
): Promise<ImportProgress> {
  const maxPages = parse(
    z.number().int().min(1).max(10000),
    options.maxPages ?? 100,
  );
  if (typeof fetchPage !== "function") throw new Error("Page fetcher required");
  store.beginImport(jobId, coverage);
  const now = options.now ?? Date.now;
  for (let page = 0; page < maxPages; page++) {
    const progress = store.importProgress(jobId);
    if (!progress) throw new Error("Missing import");
    if (
      progress.complete ||
      options.signal?.aborted ||
      parse(timestamp, now()) < progress.notBefore
    )
      return progress;
    let result: ImportPage;
    try {
      result = await fetchPage({
        coverage: structuredClone(progress.coverage),
        cursor: progress.cursor,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) return progress;
      throw error;
    }
    if (options.signal?.aborted) return progress;
    store.persistPage(progress, result, now());
    if (result.rateLimited || result.retryAfterMs) break;
  }
  const progress = store.importProgress(jobId);
  if (!progress) throw new Error("Missing import");
  return progress;
}
