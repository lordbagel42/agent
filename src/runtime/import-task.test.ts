import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type TestContext, test } from "vitest";
import { ImportedMemoryExtraction } from "../imports/extraction.js";
import { HistoryImports } from "../imports/index.js";
import {
  EvidenceStore,
  type ImportCoverage,
  type PageFetcher,
  type Source,
} from "../memory/store.js";
import {
  createImportTask,
  type ImportTaskCommand,
  importTaskSchema,
} from "./import-task.js";

const audience = '["private","owner"]';
const coverage: ImportCoverage = {
  platform: "gmail",
  account: "fixture@example.invalid",
  conversations: ["INBOX"],
  from: 1000,
  to: 5000,
  audiences: [audience, "configured-secondary"],
};
const source = (id: string): Source => ({
  id,
  audiences: [audience],
  platform: "gmail",
  account: coverage.account,
  conversation: "thread:abc",
  author: "sender",
  observedAt: 2000,
  text: "PRIVATE_SOURCE_BODY I prefer tea.",
  sourceUrl: "https://example.invalid/message",
});

function fixture(
  t: TestContext,
  options: {
    coverage?: ImportCoverage;
    fetchPage?: PageFetcher;
    extract?: ConstructorParameters<typeof ImportedMemoryExtraction>[4];
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "june-import-task-"));
  const path = join(directory, "bindings.sqlite");
  const evidencePath = join(directory, "evidence.sqlite");
  const key = randomBytes(32);
  let store = new EvidenceStore(evidencePath, key);
  let now = 100_000;
  const selected = options.coverage ?? coverage;
  const selections = { mail: selected, overlap: selected };
  const fetches: Parameters<PageFetcher>[0][] = [];
  const batches: string[][] = [];
  const fetchPage: PageFetcher = async (request) => {
    fetches.push(request);
    return options.fetchPage
      ? options.fetchPage(request)
      : {
          sources: [source(`source-${fetches.length}`)],
          gmailLabel: "INBOX",
          nextCursor: `PRIVATE_CURSOR_${fetches.length}`,
          gaps: ["PRIVATE_GAP_BODY"],
        };
  };
  const makeImports = (credentialAccount = "PRIVATE_CREDENTIAL_REFERENCE") =>
    new HistoryImports(
      store,
      Object.fromEntries(
        Object.entries(selections).map(([id, coverage]) => [
          id,
          { coverage, credentialAccount, fetchPage },
        ]),
      ),
      () => now,
    );
  const makeExtraction = () =>
    new ImportedMemoryExtraction(
      store,
      selections,
      audience,
      { model: "fake", privateConfig: "PRIVATE_MODEL_CONFIG" },
      async (sources, claims, signal) => {
        batches.push(sources.map((s) => s.id));
        return options.extract?.(sources, claims, signal) ?? [];
      },
    );
  let imports = makeImports();
  let extraction = makeExtraction();
  const service = (configured = selections) =>
    createImportTask({
      owner: "owner",
      path,
      selections: configured,
      imports,
      extraction,
    });
  t.onTestFinished(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    service,
    fetches,
    batches,
    store: () => store,
    imports: () => imports,
    extraction: () => extraction,
    advance: (ms: number) => {
      now += ms;
    },
    restart: (credentialAccount?: string) => {
      store.close();
      store = new EvidenceStore(evidencePath, key);
      imports = makeImports(credentialAccount);
      extraction = makeExtraction();
    },
  };
}

function report(text: string) {
  expect(text.length).toBeLessThanOrEqual(3500);
  expect(text).not.toMatch(/PRIVATE_(SOURCE|CURSOR|GAP|CREDENTIAL|MODEL)/);
  return JSON.parse(text);
}

async function review(run: ReturnType<typeof createImportTask>) {
  return report(
    await run({ action: "review", selection: "mail" }, "review", () => true),
  );
}

function pageCommand(value: { digest: string; expectedPages: number }) {
  return {
    action: "start-page" as const,
    selection: "mail",
    digest: value.digest,
    expectedPages: value.expectedPages,
  };
}

test("strict commands expose only configured discovery and complete content-free review", async (t) => {
  const f = fixture(t);
  const run = f.service();
  expect(
    report(await run({ action: "review", selection: null }, "list", () => true))
      .selections,
  ).toEqual(["mail", "overlap"]);
  const value = await review(run);
  expect(value).toMatchObject({
    coverage,
    digest: f.imports().review("mail").digest,
    expectedPages: 0,
    maxPages: 1,
    page: { canStart: true, started: false, pages: 0 },
    extraction: { digest: null, batch: 0 },
  });
  const valid = pageCommand(value);
  for (const invalid of [
    { ...valid, audience: "channel" },
    { ...valid, coverage },
    { ...valid, operationId: "model-selected" },
    { ...valid, expectedPages: -1 },
    { ...valid, expectedPages: 0.5 },
    { ...valid, expectedPages: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, digest: "invalid" },
    { action: "extract", selection: "mail" },
    {
      action: "extract",
      selection: "mail",
      digest: valid.digest,
      confirmed: true,
    },
    { action: "review", selection: null, expectedPages: 0 },
  ])
    expect(importTaskSchema.safeParse(invalid).success).toBe(false);
  await expect(
    run({ action: "review", selection: "unconfigured" }, "unknown", () => true),
  ).rejects.toThrow("import_task_selection_unavailable");
  expect(f.fetches).toEqual([]);
  expect(f.batches).toEqual([]);
});

test("requires exact digest, page count, immutable coverage and live host admission", async (t) => {
  const f = fixture(t);
  const run = f.service();
  const command = pageCommand(await review(run));
  for (const input of [
    { ...command, digest: "0".repeat(64) },
    { ...command, expectedPages: 1 },
  ])
    await expect(run(input, "stale", () => true)).rejects.toThrow(
      "import_task_review_changed",
    );
  await expect(run(command, "stopped", () => false)).rejects.toThrow(
    "import_task_not_current",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    run(command, "aborted", () => true, controller.signal),
  ).rejects.toThrow("import_task_not_current");
  const mismatched = f.service({
    mail: { ...coverage, audiences: ["channel"] },
    overlap: coverage,
  });
  await expect(review(mismatched)).rejects.toThrow(
    "import_task_coverage_changed",
  );
  f.restart("REPLACED_CREDENTIAL_REFERENCE");
  await expect(f.service()(command, "old-review", () => true)).rejects.toThrow(
    "import_task_review_changed",
  );
  expect(f.fetches).toEqual([]);
  expect(f.store().importProgress("mail")).toBeUndefined();
});

test("refuses unseen oversized coverage even with a valid service digest", async (t) => {
  const f = fixture(t, {
    coverage: {
      ...coverage,
      conversations: Array.from(
        { length: 200 },
        (_, i) => `label-${i}-${"x".repeat(30)}`,
      ),
    },
  });
  await expect(review(f.service())).rejects.toThrow(
    "import_task_review_too_large",
  );
  await expect(
    f.service()(
      pageCommand({
        digest: f.imports().review("mail").digest,
        expectedPages: 0,
      }),
      "unseen",
      () => true,
    ),
  ).rejects.toThrow("import_task_review_too_large");
  expect(f.fetches).toEqual([]);
});

test("one host operation fetches only one page across concurrent replay and restart", async (t) => {
  const f = fixture(t);
  const run = f.service();
  const command = pageCommand(await review(run));
  const [first, concurrent] = await Promise.all([
    run(command, "page-one", () => true),
    f.service()(command, "page-one", () => true),
  ]);
  expect(report(first).operation).toEqual({
    state: "returned",
    replayed: false,
  });
  expect(report(concurrent).operation).toEqual({
    state: "unknown",
    replayed: true,
  });
  expect(f.fetches).toHaveLength(1);
  expect(f.store().importProgress("mail")?.pages).toBe(1);
  expect(f.fetches[0]?.coverage.audiences).toEqual([
    audience,
    "configured-secondary",
  ]);
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
  f.restart();
  expect(
    report(await f.service()(command, "page-one", () => false)).operation,
  ).toEqual({ state: "returned", replayed: true });
  const next = pageCommand(await review(f.service()));
  await expect(f.service()(next, "page-one", () => true)).rejects.toThrow(
    "import_task_operation_mismatch",
  );
  await f.service()(next, "page-two", () => true);
  await expect(f.service()(next, "stale-page", () => true)).rejects.toThrow(
    "import_task_review_changed",
  );
  expect(f.fetches).toHaveLength(2);
  expect(f.store().importProgress("mail")?.pages).toBe(2);
  expect(f.store().search("channel", "").sources).toEqual([]);
});

test("rechecks host admission immediately before dispatch and consumes a stopped operation", async (t) => {
  const f = fixture(t);
  const command = pageCommand(await review(f.service()));
  let checks = 0;
  const result = report(
    await f.service()(command, "interrupted", () => ++checks === 1),
  );
  expect(result.operation).toEqual({ state: "not-started", replayed: false });
  f.restart();
  expect(
    report(await f.service()(command, "interrupted", () => true)).operation,
  ).toEqual({ state: "not-started", replayed: true });
  expect(f.fetches).toEqual([]);
  expect(f.store().importProgress("mail")).toBeUndefined();
  expect((await review(f.service())).page.canStart).toBe(true);
});

test("a lost dispatch before service intent remains unknown rather than starting on replay", async (t) => {
  const f = fixture(t);
  const command = pageCommand(await review(f.service()));
  let checks = 0;
  report(
    await f.service()(command, "reserved", () => {
      if (++checks === 2)
        throw new Error("Simulated loss after durable binding");
      return true;
    }),
  );
  f.restart();
  expect(
    report(await f.service()(command, "reserved", () => true)).operation,
  ).toEqual({ state: "unknown", replayed: true });
  expect((await review(f.service())).page).toMatchObject({
    canStart: false,
    unsettled: true,
  });
  expect(f.fetches).toEqual([]);
  expect(f.store().importProgress("mail")).toBeUndefined();
});

test("saved cooldown survives restart and replay never becomes a delayed retry", async (t) => {
  const f = fixture(t, {
    fetchPage: async ({ cursor }) => ({
      sources: [],
      nextCursor: cursor,
      rateLimited: true,
      retryAfterMs: 60_000,
      cooldownReason: "provider_backoff",
    }),
  });
  const command = pageCommand(await review(f.service()));
  await f.service()(command, "limited", () => true);
  f.restart();
  const cooled = await review(f.service());
  expect(cooled.page).toMatchObject({
    canStart: false,
    pages: 0,
    notBefore: 160_000,
    coolingDown: true,
    cooldownReason: "provider_backoff",
  });
  await expect(
    f.service()(pageCommand(cooled), "too-early", () => true),
  ).rejects.toThrow("import_task_page_unavailable");
  f.advance(60_000);
  await f.service()(command, "limited", () => true);
  expect(f.fetches).toHaveLength(1);
  await f.service()(
    pageCommand(await review(f.service())),
    "fresh-decision",
    () => true,
  );
  expect(f.fetches).toHaveLength(2);
  expect(f.store().importProgress("mail")?.pages).toBe(0);
});

test("unknown page dispatch is fenced across restart, new operation IDs and overlapping selections", async (t) => {
  const f = fixture(t, {
    fetchPage: async () => {
      throw new Error("PRIVATE_SOURCE_BODY provider failure");
    },
  });
  const command = pageCommand(await review(f.service()));
  expect(
    report(await f.service()(command, "lost", () => true)).operation.state,
  ).toBe("unknown");
  f.restart();
  expect(
    report(await f.service()(command, "lost", () => true)).operation,
  ).toEqual({ state: "unknown", replayed: true });
  const value = await review(f.service());
  expect(value.page).toMatchObject({ unsettled: true, canStart: false });
  await expect(
    f.service()(pageCommand(value), "replacement", () => true),
  ).rejects.toThrow("import_task_page_unavailable");
  const other = report(
    await f.service()(
      { action: "review", selection: "overlap" },
      "other",
      () => true,
    ),
  );
  await expect(
    f.service()(
      { ...pageCommand(other), selection: "overlap" },
      "overlap",
      () => true,
    ),
  ).rejects.toThrow("import_task_page_unavailable");
  expect(f.fetches).toHaveLength(1);
});

test("extracts only the reviewed bounded batch, deduplicates the host decision and never accepts proposals", async (t) => {
  const f = fixture(t, {
    fetchPage: async () => ({
      sources: Array.from({ length: 21 }, (_, i) =>
        source(`s${String(i).padStart(2, "0")}`),
      ),
      gmailLabel: "INBOX",
      nextCursor: null,
    }),
    extract: async (sources) => [
      {
        subjectSourceId: sources[0]?.id,
        text: "PRIVATE_SOURCE_BODY preference proposal",
        category: "preference",
        citations: [{ sourceId: sources[0]?.id, quote: "I prefer tea." }],
        confidence: 0.7,
        validFrom: null,
        validTo: null,
        contradicts: [],
        supersedes: [],
      },
    ],
  });
  await f.service()(pageCommand(await review(f.service())), "page", () => true);
  const value = await review(f.service());
  expect(value.page).toMatchObject({ complete: true, canStart: false });
  expect(value.extraction).toMatchObject({
    batch: 20,
    eligible: 21,
    overflow: 1,
  });
  const command: ImportTaskCommand = {
    action: "extract",
    selection: "mail",
    digest: value.extraction.digest,
  };
  await expect(
    f.service()({ ...command, digest: "0".repeat(64) }, "stale", () => true),
  ).rejects.toThrow("import_task_review_changed");
  report(await f.service()(command, "batch", () => true));
  expect(f.batches).toHaveLength(1);
  expect(f.batches[0]).toHaveLength(20);
  expect(f.store().proposals(audience)).toHaveLength(1);
  expect(f.store().proposals(audience)[0]?.status).toBe("pending");
  expect(f.store().search(audience, "").claims).toEqual([]);
  f.restart();
  report(await f.service()(command, "batch", () => true));
  const next = {
    ...command,
    digest: (await review(f.service())).extraction.digest,
  };
  await expect(f.service()(next, "batch", () => true)).rejects.toThrow(
    "import_task_operation_mismatch",
  );
  expect(f.batches).toHaveLength(1);
  report(await f.service()(next, "next-batch", () => true));
  expect(f.batches[1]).toEqual(["s20"]);
  expect(
    f
      .store()
      .proposals(audience)
      .every((p) => p.status === "pending"),
  ).toBe(true);
});

test("existing durable unknown extraction intent blocks new model decisions without a replacement call", async (t) => {
  const f = fixture(t);
  await f.service()(pageCommand(await review(f.service())), "page", () => true);
  const value = f.extraction().review("mail");
  const digest = value.digest ?? "missing";
  f.store().beginImportExtraction({
    id: digest,
    importId: "mail",
    audience,
    sourceIds: value.sourceIds,
    contextClaimIds: value.contextClaimIds,
    status: "started",
    proposalIds: [],
  });
  f.restart();
  expect((await review(f.service())).extraction).toMatchObject({
    digest: null,
    blocked: true,
    admission: { state: "unknown", unknown: 1 },
  });
  await expect(
    f.service()(
      { action: "extract", selection: "mail", digest },
      "replacement",
      () => true,
    ),
  ).rejects.toThrow("import_task_review_changed");
  expect(f.batches).toEqual([]);
  expect(f.store().importExtractions(audience)[0]?.status).toBe("started");
});
