import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const id = z.string().min(1).max(2048);
const ids = z
  .array(id)
  .min(1)
  .max(1000)
  .refine((v) => new Set(v).size === v.length);
const timestamp = z.number().int().nonnegative().safe();
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
});
const claimSchema = z.strictObject({
  id,
  entity: id,
  text: z.string().min(1).max(100_000),
  audiences: ids,
  kind: z.enum(["evidence", "dream"]),
  dependsOn: ids,
  contradicts: z.array(id).max(1000),
  supersedes: z.array(id).max(1000),
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
const progressSchema = z.strictObject({
  id,
  coverage: coverageSchema,
  cursor: id.nullable(),
  pages: timestamp,
  complete: z.boolean(),
  notBefore: timestamp,
  gaps: z.array(z.string().max(10000)),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  sources: z.array(sourceSchema),
  claims: z.array(claimSchema),
  tombstones: z.array(id),
  imports: z.array(progressSchema),
});
const pageSchema = z.strictObject({
  sources: z.array(sourceSchema).max(1000),
  nextCursor: id.nullable(),
  gaps: z.array(z.string().max(10000)).max(1000).optional(),
  retryAfterMs: timestamp.optional(),
  rateLimited: z.boolean().optional(),
});
export type Source = z.infer<typeof sourceSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type ImportCoverage = z.infer<typeof coverageSchema>;
export type ImportProgress = z.infer<typeof progressSchema>;
export type ImportPage = z.infer<typeof pageSchema>;
type State = z.infer<typeof stateSchema>;

// Never include input data in validation errors (these may reach operator logs).
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Invalid memory input");
  return result.data;
}
function dependencies(claim: Claim): string[] {
  return [...claim.dependsOn, ...claim.contradicts, ...claim.supersedes];
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
  private closed = false;
  private readonly index = new Map<
    string,
    { sources: Source[]; claims: Claim[] }
  >();

  constructor(path: string, key: Uint8Array) {
    parse(id, path);
    if (!(key instanceof Uint8Array) || key.byteLength !== 32)
      throw new Error("Memory key must be 32 bytes");
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
      return parse(
        stateSchema,
        JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(28)),
            decipher.final(),
          ]).toString("utf8"),
        ),
      );
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

  appendClaim(input: Claim): void {
    const claim = parse(claimSchema, input);
    this.transaction((state) => {
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
    });
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

  deleteSource(sourceId: string): void {
    parse(id, sourceId);
    this.transaction((state) => {
      if (state.claims.some((c) => c.id === sourceId))
        throw new Error("Expected source ID");
      const removed = new Set([sourceId]);
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
      state.tombstones = [...new Set([...state.tombstones, ...removed])];
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
        return;
      }
      if (page.nextCursor !== null && page.nextCursor === progress.cursor)
        throw new Error("Import cursor did not advance");
      const c = progress.coverage;
      for (const source of page.sources) {
        if (
          source.platform !== c.platform ||
          source.account !== c.account ||
          !c.conversations.includes(source.conversation) ||
          source.observedAt < c.from ||
          source.observedAt >= c.to ||
          !source.audiences.every((a) => c.audiences.includes(a))
        )
          throw new Error("Source outside authorized import coverage");
        insertSource(state, source);
      }
      progress.cursor = page.nextCursor;
      progress.complete = page.nextCursor === null;
      progress.pages++;
      progress.notBefore = parse(timestamp, now + (page.retryAfterMs ?? 0));
      progress.gaps.push(...(page.gaps ?? []));
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
