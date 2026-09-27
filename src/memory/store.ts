import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
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
export type MemoryRetrieval = {
  sources: Source[];
  claims: Claim[];
  // Present only when matching, authorized records were omitted by a bound.
  truncated?: true;
  omitted?: number;
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
export type ImportCoverage = z.infer<typeof coverageSchema>;
export type ImportProgress = z.infer<typeof progressSchema>;
export type ImportPage = z.infer<typeof pageSchema>;
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

function removeEvidence(state: State, sourceIds: string[]): void {
  const removed = new Set(sourceIds);
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
  state.extractions = state.extractions.filter(
    (entry) => !entry.sourceIds.some((id) => removed.has(id)),
  );
  for (const entry of state.extractions)
    entry.proposalIds = entry.proposalIds.filter((id) => !removed.has(id));
  state.tombstones = [...new Set([...state.tombstones, ...removed])];
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
      throw new Error("Source IDs are immutable");
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
  for (const ref of [...claim.contradicts, ...claim.supersedes]) {
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
          });
          this.db.exec("COMMIT");
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

  private read(): State {
    if (this.closed) throw new Error("Memory store closed");
    try {
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
      return state;
    } catch {
      throw new Error("Memory store authentication failed");
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      change(state);
      this.write(state);
      this.db.exec("COMMIT");
      this.index.clear();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
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
  ): MemoryProposal[] {
    const inputs = parse(z.array(proposalInputSchema).max(20), output);
    const sources = this.extractionContext(audience, sourceIds);
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
        .update(JSON.stringify([audience, grounding]))
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
          grounding,
        },
      });
    });
    const selected = sources.map((source) => source.id).sort();
    let admitted: string[] = [];
    this.transaction((state) => {
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
      const previous = state.extractions.find(
        (entry) =>
          entry.audience === audience &&
          isDeepStrictEqual(entry.sourceIds, selected),
      );
      if (previous) {
        admitted = previous.proposalIds;
        return;
      }
      for (const proposal of proposals) {
        // Validate against today's state within the write transaction, including
        // deletion while extraction was in flight. Do not publish pending claims.
        insertClaim({ ...state, claims: [...state.claims] }, proposal.claim);
        if (!state.proposals.some((p) => p.id === proposal.id))
          state.proposals.push(proposal);
      }
      admitted = proposals.map((proposal) => proposal.id);
      state.extractions.push({
        audience,
        sourceIds: selected,
        proposalIds: admitted,
      });
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
    } = {},
  ): MemoryRetrieval {
    parse(z.string().max(10000), query);
    const limit = parse(z.number().int().min(1).max(100), options.limit ?? 12);
    const budget = parse(
      z.number().int().min(100).max(100000),
      options.maxCharacters ?? 16000,
    );
    const visible = this.search(audience, "");
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
    const words = [
      ...new Set(query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)),
    ];
    const candidates = [
      ...visible.sources
        .filter((item) => !options.claimsOnly && !ignored.has(item.id))
        .map((item) => ({ type: "source" as const, item })),
      ...visible.claims
        .filter(
          (item) =>
            ignored.size === 0 ||
            !this.independentEvidence(item.id, audience).some((id) =>
              ignored.has(id),
            ),
        )
        .map((item) => ({ type: "claim" as const, item })),
    ]
      .map((entry) => ({
        ...entry,
        score: words.filter((word) =>
          entry.item.text.toLocaleLowerCase().includes(word),
        ).length,
      }))
      .filter((entry) => !words.length || entry.score > 0)
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
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

  /** Unique original source IDs, never a count of dream/claim repetitions. */
  independentEvidence(claimId: string, audience: string): string[] {
    parse(id, claimId);
    const visible = this.search(audience, "");
    const found = new Set<string>();
    const visit = (ref: string) => {
      if (visible.sources.some((s) => s.id === ref)) found.add(ref);
      else
        for (const parent of visible.claims.find((c) => c.id === ref)
          ?.dependsOn ?? [])
          visit(parent);
    };
    visit(claimId);
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
    this.transaction((state) => {
      if (state.claims.some((c) => c.id === sourceId))
        throw new Error("Expected source ID");
      removeEvidence(state, [sourceId]);
    });
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
  const output = await extract(sources, claims, signal);
  signal?.throwIfAborted();
  // Even an unreferenced context claim may have influenced the proposal text.
  if (store.deletionRevision() !== revision)
    throw new Error("Memory changed during extraction");
  return store.stageProposals(audience, selected, output);
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
