import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "rivetkit/client";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createAppsClient } from "../apps/client.js";
import { nativeCodingPreflight } from "../coding/preflight.js";
import { parseConfig } from "../config.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { createBitwardenCredentialResolver } from "../credentials/bitwarden.js";
import { ImportedMemoryExtraction } from "../imports/extraction.js";
import { HistoryImports } from "../imports/index.js";
import { CuratedPersonalityStore } from "../memory/curated.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { type CapabilityContext, runCapability } from "./capabilities.js";
import {
  capabilitySnapshot,
  createInspectionReader,
  inspectForgetCleanup,
  inspectInterruptedInference,
  outstandingOperationMetadata,
} from "./inspection.js";
import {
  type ConversationState,
  createJuneRegistry,
  type JuneClientRegistry,
} from "./registry.js";

it("exposes read-only issue metadata to the existing authorized inspection workflow", async () => {
  const parsed = parseReply(
    JSON.stringify({ text: "", inspection: "debug-issues" }),
    [],
    { inspectionAvailable: true },
  );
  expect(parsed.inspection).toBe("debug-issues");
  expect(
    JSON.stringify(replyJsonSchema([], { inspectionAvailable: true })),
  ).toContain('"debug-issues"');
  const read = createInspectionReader({
    audience: "private",
    selections: {},
    debugIssues: async () => ({
      enabled: true,
      credentials: { state: "waiting" },
      items: [{ number: 37, state: "open", job: { phase: "unknown" } }],
    }),
  });
  expect(await read("debug-issues")).toContain('"phase":"unknown"');
  expect(await read("debug-issues")).toContain(
    '"credentials":{"state":"waiting"}',
  );
  expect(await read("debug-issues")).toContain(
    "credential receipt is not proof of GitHub access",
  );
  for (const target of ["debug-issues", "debug-shares"] as const) {
    const report = await read(target);
    expect(report).toContain("Judge disclosure");
    expect(report).toContain("current audience");
    expect(report).not.toContain("details remain owner-private");
    expect(report).not.toContain("receipts owner-private");
  }
  expect(
    await createInspectionReader({ audience: "private", selections: {} })(
      "debug-issues",
    ),
  ).toContain("unavailable");
});

it("advertises import cancellation only when mounted outside setup mode", () => {
  const config = parseConfig({
    setupMode: true,
    owner: { id: "owner", identities: [] },
    model: {
      protocol: "openai",
      model: "fixture",
      apiKeyEnv: "FIXTURE_KEY",
    },
  });
  const integration = {
    importCancel: () => {
      throw new Error("Inspection must not cancel");
    },
  };
  for (const [setupMode, mounted, expected] of [
    [false, true, "yes"],
    [false, false, "no"],
    [true, true, "no"],
  ] as const) {
    const row = capabilitySnapshot(
      { ...config, setupMode },
      mounted ? integration : {},
      true,
      {},
    ).capabilities.find((row) => row.capability === "history-imports");
    expect(row?.juneCallable).toBe(expected);
    expect(row?.liveVerified).toBe("unknown");
  }
});

it("does not dispatch inspection or cancellation without grants, integrations or current lifecycle admission", async () => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const event: MessageEvent = {
    id: "guest-inspection",
    type: "message",
    messageId: "1.1",
    occurredAt: 1,
    address: { channel: "slack", accountId: "T1", conversationId: "D2" },
    senderId: "U2",
    direct: true,
    metadata: { channelType: "im" },
    text: "Inspect your status",
  };
  const scope = routeEvent(event, owner);
  if (!scope) throw new Error("Missing guest fixture scope");
  const inspection = vi.fn(async () => "SECRET inspection result");
  const importCancel = vi.fn(() => "SECRET cancellation result");
  const context: CapabilityContext = {
    event,
    scope,
    audience: JSON.stringify(scope.key),
    eventId: event.id,
    origin: "event",
    phase: "reply",
    ownerTurn: false,
    deletionRevision: 0,
    personalityVersion: undefined,
    workspaces: [],
    signal: new AbortController().signal,
    valid: () => true,
    model: { reply: async () => ({ text: "" }) },
    deps: { owner, inspection, importCancel },
    ports: {} as CapabilityContext["ports"],
  };
  const request: ModelRequest = {
    system: "",
    messages: [],
    workspaces: [],
    inspectionAvailable: true,
    importCancelAvailable: true,
  };
  const noGrants = {
    inspectionAvailable: false,
    importCancelAvailable: false,
  };
  const cases: [string, Partial<ModelRequest>, Partial<CapabilityContext>][] = [
    ["disabled grants", noGrants, {}],
    ["missing integrations", {}, { deps: { owner } }],
    ["synthesis", noGrants, { phase: "synthesis" }],
    ["report-only completion", noGrants, { origin: "execution_result" }],
    ["aborted", {}, { signal: AbortSignal.abort() }],
    ["invalidated", {}, { valid: () => false }],
    ["superseded", {}, { canStartAction: () => false }],
  ];
  for (const [name, grants, lifecycle] of cases) {
    const input = { ...request, ...grants };
    if (grants === noGrants) {
      expect(replyJsonSchema([], input).properties).not.toHaveProperty(
        "inspection",
      );
      expect(replyJsonSchema([], input).properties).not.toHaveProperty(
        "importCancel",
      );
    }
    for (const action of [
      { text: "", inspection: "memory" },
      { text: "", importCancel: "selection-0" },
    ] as const) {
      const result = await runCapability(action, input, {
        ...context,
        ...lifecycle,
      });
      expect(result.inspection, name).toBeUndefined();
      expect(result.importCancel, name).toBeUndefined();
      expect(result.text, name).not.toContain("SECRET");
      expect(inspection, name).not.toHaveBeenCalled();
      expect(importCancel, name).not.toHaveBeenCalled();
    }
  }
});

it("distinguishes implemented Apps from activation and callability without contacting the host", () => {
  const config = parseConfig({
    setupMode: true,
    owner: { id: "owner", identities: [] },
    model: { protocol: "openai", model: "fixture", apiKeyEnv: "FIXTURE_KEY" },
  });
  const forbidden = () => {
    throw new Error("Inspection must not read jobs or contact the app host");
  };
  const dynamicApps = {
    endpoint: "https://private-app-host.example.invalid",
    workspace: "private-app-workspace",
    tokenEnv: "PRIVATE_APPS_TOKEN",
  };
  const apps = createAppsClient({
    ...dynamicApps,
    token: "private-control-token",
    readJob: forbidden,
    fetch: forbidden,
  });
  for (const [
    configured,
    activated,
    mounted,
    setupMode,
    integrated,
    callable,
    enabled,
  ] of [
    [false, false, false, false, "no", "no", "no"],
    [true, false, false, false, "no", "no", "no"],
    [true, true, false, false, "no", "no", "yes"],
    [true, true, true, false, "yes", "yes", "yes"],
    [true, true, true, true, "yes", "no", "yes"],
  ] as const) {
    const snapshot = capabilitySnapshot(
      {
        ...config,
        setupMode,
        coding: { ...config.coding, enabled: configured },
        ...(configured ? { dynamicApps } : {}),
      },
      { apps: mounted ? apps : undefined },
      false,
      { JUNE_ALLOW_NATIVE_CODING: activated ? "1" : "0" },
    );
    const row = snapshot.capabilities.find(
      (entry) => entry.capability === "dynamic-apps",
    );
    expect(row).toMatchObject({
      implemented: "yes",
      hostIntegrated: integrated,
      juneCallable: callable,
      enabled,
      liveVerified: "unknown",
    });
    expect(JSON.stringify(row)).not.toMatch(
      /private-app-host|private-app-workspace|PRIVATE_APPS_TOKEN|private-control-token/,
    );
  }
});

it("reports retained-copy boundaries without accessing retained data", async () => {
  const forbidden = () => {
    throw new Error("Retention inspection must not access stored data");
  };
  for (const configured of [true, false]) {
    const read = createInspectionReader({
      audience: "SECRET AUDIENCE",
      memory: configured
        ? {
            store: new Proxy({} as EvidenceStore, { get: forbidden }),
            personality: new Proxy({} as CuratedPersonalityStore, {
              get: forbidden,
            }),
          }
        : undefined,
      get imports() {
        return forbidden();
      },
      get selections() {
        return forbidden();
      },
      nativeCoding: forbidden,
      reflection: forbidden,
    });
    const report = await read("retention");
    expect(report).toContain(
      `Ledger: ${configured ? "configured" : "not configured in this runtime"}`,
    );
    expect(report).toContain(
      `curated encrypted snapshot storage is ${configured ? "configured" : "not configured in this runtime"}`,
    );
    expect(report).toContain(
      "Physical erasure is unverified for every category",
    );
    expect(report).toContain("Per-source deletion status is unknown");
    expect(report).toContain("Unknown does not mean absent");
    expect(report).not.toContain("SECRET");
    expect(report.length).toBeLessThan(4000);
  }
});

it("reads bounded cleanup metadata after ledger reopen without restoring bodies or mutating receipts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-cleanup-inspection-"));
  const key = randomBytes(32);
  const path = join(directory, "evidence.db");
  let store = new EvidenceStore(path, key);
  t.onTestFinished(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const state = {
    forgetConfirmations: {} as NonNullable<
      ConversationState["forgetConfirmations"]
    >,
    forgetCleanups: {} as NonNullable<ConversationState["forgetCleanups"]>,
  };
  for (let i = 0; i < 14; i++) {
    const sourceId = `SECRET-source-${i}`;
    store.appendSource({
      id: sourceId,
      audiences: ["private"],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      observedAt: 1,
      sourceUrl: "https://example.invalid/private",
      text: "SECRET SOURCE BODY",
    });
    if (i !== 1) store.deleteSource(sourceId);
    const token = i.toString(16).padStart(32, "0");
    state.forgetConfirmations[token] = {
      sourceId,
      fingerprint: "SECRET fingerprint",
      previewEventId: "SECRET preview",
      commandEventId: "SECRET command",
      expiresAt: 1,
      status: i === 12 ? "pending" : i === 13 ? "completed" : "started",
    };
    if (i !== 2)
      state.forgetCleanups[JSON.stringify(sourceId)] = { completed: true };
  }
  store.close();
  store = new EvidenceStore(path, key);
  const sourceRead = vi.spyOn(store, "source");
  const before = JSON.stringify(state);
  const memory = {
    store,
    source: () => undefined,
    forget: vi.fn(async () => {}),
  };
  const restored = JSON.parse(before);
  const report = inspectForgetCleanup(restored, memory);
  expect(report).toContain('"pending":1,"started":12,"completed":1');
  expect(report).toContain("showing 10; omitted 2");
  const rows = JSON.parse(
    report.slice(report.indexOf("[{"), report.indexOf("\n")),
  );
  expect(rows).toHaveLength(10);
  expect(rows[9].token).toBe(`${"0".repeat(31)}9`);
  expect(rows.slice(0, 3)).toEqual([
    {
      token: "0".repeat(32),
      logicalDeletion: "confirmed",
      recovery: "repeat-confirmation",
    },
    {
      token: `${"0".repeat(31)}1`,
      logicalDeletion: "unconfirmed",
      recovery: "fresh-preview",
    },
    {
      token: `${"0".repeat(31)}2`,
      logicalDeletion: "confirmed",
      recovery: "operator-review",
    },
  ]);
  expect(report).not.toContain("SECRET");
  expect(report.length).toBeLessThan(4000);
  expect(report).toContain("physicalPurge:false");
  expect(sourceRead).not.toHaveBeenCalled();
  expect(memory.forget).not.toHaveBeenCalled();
  expect(JSON.stringify(restored)).toBe(before);
  expect(store.source("private", "SECRET-source-0")).toBeUndefined();
  expect(store.source("private", "SECRET-source-1")?.text).toBe(
    "SECRET SOURCE BODY",
  );
  expect(inspectForgetCleanup(state, undefined)).toContain(
    '"logicalDeletion":"unknown","recovery":"operator-review"',
  );
  const failedRead = vi.spyOn(store, "isDeleted").mockImplementation(() => {
    throw new Error("SECRET storage failure");
  });
  const unavailable = inspectForgetCleanup(state, memory);
  expect(unavailable).toContain(
    '"logicalDeletion":"unknown","recovery":"operator-review"',
  );
  expect(unavailable).not.toContain("SECRET");
  failedRead.mockRestore();
  expect(inspectForgetCleanup({}, undefined)).toContain(
    '"pending":0,"started":0,"completed":0',
  );
  expect(() =>
    parseReply('{"text":"","inspection":"forgetting"}', []),
  ).toThrow();
});

it("bounds interruption metadata without exposing or mutating private and forgotten records", () => {
  const events = Object.fromEntries(
    [4, 11, 1, 7, 0, 12, 6, 3, 10, 5, 9, 2, 8].map((i) => [
      `SECRET-event-${i}`,
      {
        event: { occurredAt: i, text: "SECRET BODY" },
        done: i % 2 === 0,
        inference: {
          status: "unknown" as const,
          code: "interrupted_inference" as const,
          invocation: JSON.stringify([
            "SECRET-audience",
            `SECRET-event-${i}`,
            "reply",
            0,
          ]),
        },
      },
    ]),
  );
  const input = {
    ...events,
    legacy: { event: { occurredAt: 999 }, done: true },
  };
  const before = structuredClone(input);
  const report = inspectInterruptedInference(input, ["SECRET-event-12"]);
  const rows = JSON.parse(
    report.slice(report.indexOf("[{"), report.indexOf("\n")),
  ) as {
    id: string;
    inboundOccurredAt: number;
    status: string;
    code: string;
  }[];
  expect(report).toContain("Recorded recovery receipts: 12; showing latest 10");
  expect(rows.map((row) => row.inboundOccurredAt)).toEqual([
    11, 10, 9, 8, 7, 6, 5, 4, 3, 2,
  ]);
  expect(new Set(rows.map((row) => row.id)).size).toBe(10);
  for (const row of rows) {
    expect(row.id).toMatch(/^[a-f0-9]{64}$/);
    expect(row.status).toBe("unknown");
    expect(row.code).toBe("interrupted_inference");
  }
  expect(report).not.toContain("SECRET");
  expect(report.length).toBeLessThan(4000);
  expect(report).toContain("not an inference or interruption timestamp");
  expect(report).toContain(
    "absence does not prove success or intentional silence",
  );
  expect(input).toEqual(before);
  expect(inspectInterruptedInference({ legacy: input.legacy })).toContain(
    "Recorded recovery receipts: 0; showing latest 0",
  );
});

it("hides tombstoned interruption receipts before conversation cleanup, including context dependencies", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const event = (id: string, occurredAt: number): MessageEvent => ({
    id,
    occurredAt,
    type: "message",
    messageId: id,
    direct: true,
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    text: "SECRET BODY",
  });
  const source = (message: MessageEvent) => ({
    id: message.id,
    audiences: [audience],
    platform: "slack",
    account: "T1",
    conversation: "D1",
    author: "U1",
    observedAt: message.occurredAt,
    sourceUrl: "https://example.invalid/private",
    text: message.text,
  });
  for (const id of ["direct", "supporting", "context-source"])
    store.appendSource(source(event(id, 1)));
  const events = Object.fromEntries(
    ["direct", "dependency", "context", "kept", "legacy"].map((id, i) => [
      id,
      {
        event: event(id, (i + 1) * 11),
        done: true,
        inference: {
          status: "unknown" as const,
          code: "interrupted_inference" as const,
          invocation: `SECRET-${id}`,
        },
      },
    ]),
  );
  const sent: OutboundMessage[] = [];
  let calls = 0;
  const registry = createJuneRegistry({
    owner,
    memory: { store, source },
    model: {
      async reply() {
        calls++;
        return { text: "", inspection: "inference" };
      },
    },
    inspection: async () => {
      throw new Error("Must inspect conversation state locally");
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
  });
  // Seed previously recovered records, without changing production accounting.
  const config = registry.config.use.conversation.config;
  const initial = "state" in config ? config.state : undefined;
  if (!initial || typeof initial !== "object")
    throw new Error("Missing fixture state");
  const personality = createHash("sha256").update("{}").digest("hex");
  Object.assign(initial, {
    events,
    memoryContexts: {
      dependency: {
        sourceIds: ["supporting"],
        personality,
        deletionTracked: true,
      },
      context: {
        sourceIds: [],
        contextSourceIds: ["context-source"],
        personality,
        deletionTracked: true,
      },
      // Source-only legacy provenance remains hidden even before deletion.
      legacy: { sourceIds: ["supporting"], personality },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", owner.id]);
  let completed = 5;
  const inspect = async (id: string) => {
    completed++;
    await june.send("inbox", { type: "event", event: event(id, 100) });
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).filter(
            (record) => record.done,
          ).length,
        { timeout: 5000 },
      )
      .toBe(completed);
    const content = sent.at(-1)?.content;
    return content?.type === "text" ? content.text : "";
  };
  const before = await inspect("before");
  expect(before).toContain("Recorded recovery receipts: 4; showing latest 4");
  for (const timestamp of [11, 22, 33, 44])
    expect(before).toContain(`"inboundOccurredAt":${timestamp}`);
  expect(before).not.toContain('"inboundOccurredAt":55');
  // The ledger commits first; deliberately omit june.forget to model a crash
  // before actor cleanup and its forgottenEvents cache can catch up.
  for (const id of ["direct", "supporting", "context-source"])
    store.deleteSource(id);
  const report = await inspect("after");
  expect(report).toContain("Recorded recovery receipts: 1; showing latest 1");
  expect(report).toContain('"inboundOccurredAt":44');
  for (const timestamp of [11, 22, 33, 55])
    expect(report).not.toContain(`"inboundOccurredAt":${timestamp}`);
  expect(JSON.stringify(sent)).not.toContain("SECRET");
  const state = await june.snapshot();
  expect(state.forgottenEvents).toBeUndefined();
  for (const [id, record] of Object.entries(events))
    expect(state.events[id]).toEqual(record);
  expect(calls).toBe(2);
});

// Expanded inspection/cancellation turns exceed 60s; each deliver retains its 5s bound.
it("inspects bounded metadata for admitted conversations while preserving synthesis, privacy and read-only boundaries", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  // The same historical source exercises import coverage and permitted reflection.
  const evidenceMaxAgeMs = Date.now() + 60000;
  const retainedSource = {
    id: "secret-source",
    audiences: [audience],
    platform: "slack",
    account: "private-account",
    conversation: "private-channel",
    author: "U1",
    observedAt: 1,
    sourceUrl: "https://example.com/private",
    text: "SECRET CONTENT",
  };
  store.appendSource(retainedSource);
  store.appendSource({
    ...retainedSource,
    id: "other-secret-source",
    audiences: ["SECRET OTHER AUDIENCE"],
    text: "SECRET OTHER CONTENT".repeat(10),
  });
  const root = mkdtempSync(join(tmpdir(), "june-inspection-retention-"));
  const personality = new CuratedPersonalityStore(
    join(root, "curated"),
    randomBytes(32),
    store,
    { initialize: true },
  );
  t.onTestFinished(() => {
    personality.close();
    rmSync(root, { recursive: true, force: true });
  });
  personality.ownerRevise(
    {
      id: "SECRET REVISION",
      scope: audience,
      trait: "tone",
      value: "SECRET TONE",
      basis: "inferred",
      evidenceIds: ["secret-source"],
      explanation: "SECRET EXPLANATION",
      confidence: 1,
    },
    store.reflectionEvidence(audience, ["secret-source"], 1000),
    2,
    1000,
  );
  store.stageProposals(
    audience,
    ["secret-source"],
    [
      {
        subjectSourceId: "secret-source",
        text: "SECRET PROPOSAL",
        category: "claim",
        citations: [{ sourceId: "secret-source", quote: "SECRET CONTENT" }],
        confidence: 0.5,
        validFrom: null,
        validTo: null,
        contradicts: [],
        supersedes: [],
      },
    ],
  );
  const coverage = {
    platform: "slack",
    account: "private-account",
    conversations: ["private-channel"],
    from: 1,
    to: 999,
    audiences: [audience],
  };
  const selections = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`selection-${i}`, coverage]),
  );
  selections["selection-11"] = {
    ...coverage,
    platform: "gmail",
    account: "owner@example.test",
    conversations: ["Label_42"],
    from: 1000,
    to: 3000,
  };
  selections.hidden = { ...coverage, audiences: ["another-audience"] };
  let fetches = 0;
  const imports = new HistoryImports(
    store,
    Object.fromEntries(
      Object.entries(selections).map(([id, coverage]) => [
        id,
        {
          coverage,
          credentialAccount: "FIXTURE_SLACK_ACCOUNT",
          async fetchPage() {
            fetches++;
            return {
              sources: [{ ...retainedSource, text: "SECRET REPLACEMENT" }],
              nextCursor: null,
            };
          },
        },
      ]),
    ),
    () => 500_000,
  );
  store.beginImport("selection-0", coverage);
  const initial = store.importProgress("selection-0");
  if (!initial) throw new Error("Missing fixture import");
  const forgotten = {
    id: "SECRET FORGOTTEN SOURCE",
    audiences: [audience],
    platform: coverage.platform,
    account: coverage.account,
    conversation: "private-channel",
    author: "SECRET AUTHOR",
    observedAt: 1,
    sourceUrl: "https://example.com/SECRET",
    text: "SECRET FORGOTTEN CONTENT",
  };
  store.appendSource(forgotten);
  store.deleteSource(forgotten.id);
  const importedSource = {
    id: "SECRET imported-source",
    audiences: [audience],
    platform: coverage.platform,
    account: coverage.account,
    conversation: "private-channel",
    author: "private-user",
    observedAt: 2,
    sourceUrl: "https://example.invalid/private",
    text: "SECRET /approve historical-action",
  };
  store.persistPage(
    initial,
    {
      sources: [forgotten, importedSource],
      nextCursor: "SECRET CURSOR",
      gaps: [
        "SECRET GAP",
        "SECRET CHANNEL: Slack reports retention-limited history.",
        "SECRET CHANNEL: Slack reports retention-limited history.",
      ],
    },
    1,
  );
  expect(store.source(audience, forgotten.id)).toBeUndefined();
  const page = store.importProgress("selection-0");
  if (!page) throw new Error("Missing fixture page");
  await expect(imports.start("selection-0")).rejects.toThrow("immutable");
  expect(fetches).toBe(1);
  expect(store.importProgress("selection-0")).toEqual(page);
  store.persistPage(
    page,
    {
      sources: [],
      nextCursor: page.cursor,
      rateLimited: true,
      retryAfterMs: 999_998,
    },
    2,
  );
  const progress = store.importProgress("selection-0");
  expect(progress?.sourceIds).toEqual([importedSource.id]);
  store.beginImport("selection-1", coverage);
  const oldWindow = store.importProgress("selection-1");
  if (!oldWindow) throw new Error("Missing fixture import");
  store.persistPage(
    oldWindow,
    {
      sources: [],
      nextCursor: null,
      gaps: [
        "SECRET MESSAGE: no plain text; non-text content omitted.",
        "Previously deleted source omitted.",
        "SECRET BODY: no inline plain-text body. SECRET SUFFIX",
      ],
    },
    1,
  );
  const importProgressSnapshot = () =>
    Object.fromEntries(
      Object.keys(selections).map((id) => [id, store.importProgress(id)]),
    );
  const importsBeforeInspection = importProgressSnapshot();
  const proposalsBeforeInspection = store.proposals(audience);
  const revisionsBeforeInspection = personality.ownerHistory();
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
  const tokenEvents: MessageEvent[] = [];
  let action: CompanionReply = { text: "", inspection: "memory" };
  let search = false;
  let unchecked = false;
  let fail = false;
  let disabled = false;
  let extractionEnabled = false;
  let reads = 0;
  let guestCase = 0;
  let extractions = 0;
  let reflections = 0;
  let sessions = 0;
  let vaultReads = 0;
  const credentials = createBitwardenCredentialResolver(
    {
      executable: "/SECRET/bw",
      appDataDir: "/SECRET/profile",
      bindings: [
        {
          account: "SECRET-account",
          item: "SECRET-item",
          origin: "https://secret.example",
          vaultItemId: "12345678-1234-1234-1234-123456789abc",
          field: "login",
        },
      ],
      session: async () => {
        sessions++;
        throw new Error("SECRET-session");
      },
    },
    async () => {
      vaultReads++;
      throw new Error("SECRET-vault-item");
    },
  );
  let cancellations = 0;
  const registry = createJuneRegistry({
    owner,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return { status: "sent", messageId: `out${sent.length}` };
        },
      },
    },
    model: {
      async reply(request) {
        requests.push(request);
        if (search && request.webSearchAvailable)
          return { text: "", webSearch: "public query" };
        // Exercise provider parsing for valid actions, and host guards against
        // providers that return forbidden or mixed directives without parsing.
        if (request.inspectionAvailable && !unchecked)
          return parseReply(JSON.stringify(action), [], request);
        return action;
      },
    },
    webSearch: {
      available: true,
      description: "fixture",
      async search() {
        return {
          status: "ready",
          results: [
            {
              title: "public",
              url: "https://example.com",
              snippet: "public evidence",
            },
          ],
        };
      },
    },
    inspection: async (target, event, capacity) => {
      reads++;
      if (fail) throw new Error("SECRET ERROR PATH");
      return (
        disabled
          ? createInspectionReader({ audience, selections: {} })
          : extractionEnabled
            ? extractionRead
            : read
      )(target, event, capacity);
    },
    importCancel: (id) => {
      cancellations++;
      imports.cancel(id, audience);
      return "Import cancellation recorded durably; external read settlement is unknown.";
    },
    reflection: {
      ownerId: owner.id,
      policy: {
        totalCapacity: 2,
        liveReserve: 1,
        cooldownMs: 1,
        maxAttempts: 1,
        maxNoNewEvidence: 1,
        evidenceMaxAgeMs,
        quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
      },
      idleMs: 86400000,
      deepMs: 86400000,
      pollMs: 10000,
      timeoutMs: 1000,
      async retrieve({ scope, evidenceIds }) {
        return {
          authorized: scope === audience,
          evidence: store.reflectionEvidence(
            scope,
            evidenceIds,
            evidenceMaxAgeMs,
          ),
        };
      },
      async decide() {
        reflections++;
        throw new Error("must not reflect");
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate([owner.id]);
  await reflection.enqueue({
    scope: audience,
    evidenceIds: ["secret-source"],
    kind: "curiosity",
    mode: "idle",
  });
  const read = createInspectionReader({
    audience,
    memory: { store, personality },
    imports,
    selections,
    capabilities: () =>
      "Generic capability routes are mounted. Registered tools: 0.",
    credentials,
    capabilityMatrix: () =>
      capabilitySnapshot(
        parseConfig({
          setupMode: true,
          owner: { id: "owner", identities: [] },
          model: {
            protocol: "openai",
            model: "SECRET MODEL",
            apiKeyEnv: "SECRET_ENV",
          },
          memory: { directory: "/SECRET-PATH", keyEnv: "SECRET_ENV" },
        }),
        { memory: { store, source: () => undefined }, inspection: read },
        true,
        { JUNE_ALLOW_MEMORY: "1", SECRET_ENV: "SECRET CREDENTIAL" },
      ),
    nativeCoding: () =>
      nativeCodingPreflight(
        { enabled: false, workspaces: {}, isolation: {}, timeoutMs: 1000 },
        false,
        {},
      ),
    slackSearch: {
      enabled: true,
      hasActionToken: (event) => {
        tokenEvents.push(event);
        return true;
      },
    },
    operations: () =>
      client.conversation
        .getOrCreate(["private", owner.id])
        .outstandingOperations(),
    reflection: () => reflection.status(),
    curiosity: (scope) => reflection.curiosityProgress(scope),
  });
  const extractionRead = createInspectionReader({
    audience,
    memory: { store },
    imports,
    selections: { "selection-0": coverage },
    importExtraction: new ImportedMemoryExtraction(
      store,
      { "selection-0": coverage },
      audience,
      {},
      async () => {
        extractions++;
        throw new Error("Inspection must not invoke extraction");
      },
    ),
  });
  const deliver = async (extra: Partial<MessageEvent> = {}) => {
    const requestStart = requests.length;
    const sentStart = sent.length;
    const tokenStart = tokenEvents.length;
    const event: MessageEvent = {
      id: `in${requests.length}`,
      type: "message",
      messageId: `ts${requests.length}`,
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      text: "Inspect your status",
      ...extra,
    };
    const scope = routeEvent(event, owner, true);
    if (!scope) throw new Error("Missing fixture scope");
    const actor = client.conversation.getOrCreate(scope.key);
    const done = Object.values((await actor.snapshot()).events).filter(
      (e) => e.done,
    ).length;
    await actor.send("inbox", { type: "event", event });
    // Real-engine synthesis includes two model phases, a web lookup and six
    // reflection occupancy calls. This checks completion/privacy, not a 1s SLA.
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).filter((e) => e.done)
            .length,
        { timeout: 5000 },
      )
      .toBe(done + 1);
    // Assert outside model.reply so failures cannot become model-unreachable
    // receipts and obscure the actual prompt/schema regression.
    for (const request of requests.slice(requestStart)) {
      expect(
        Object.hasOwn(replyJsonSchema([], request).properties, "inspection"),
      ).toBe(request.inspectionAvailable);
      expect(
        Object.hasOwn(replyJsonSchema([], request).properties, "importCancel"),
      ).toBe(request.importCancelAvailable);
      if (request.importCancelAvailable)
        expect(request.system).toContain('importCancel:{action:"review"');
      if (request.inspectionAvailable) {
        expect(request.system).toContain(
          'Read-only subsystem inspection uses inspection:"memory"|"imports"|"reflection"|"native-coding"',
        );
        expect(request.system).toContain('set inspection to "inference"');
        expect(request.system).toContain('set inspection to "credentials"');
        expect(request.system).toContain('Set inspection to "retention"');
        expect(request.system).toContain("bounded scoped counts/bytes/limits");
        expect(request.system).toContain(
          "Memory usage is authorized evidence, not total disk or model context; null quotas are unknown, not unlimited",
        );
        expect(request.system).toContain(
          "Never retry unknown reflection, assert settlement, or reconcile it yourself",
        );
        expect(request.system).toContain(
          'inspection {target:"imports",selection:null,offset:0}',
        );
        if (action.inspection === "snapshot-retention") {
          expect(request.system).toContain(
            'set inspection to "snapshot-retention"',
          );
          expect(JSON.stringify(replyJsonSchema([], request))).toContain(
            '"snapshot-retention"',
          );
        }
      }
    }
    for (const tokenEvent of tokenEvents.slice(tokenStart))
      expect(tokenEvent).toEqual(event);
    expect(sent.length).toBeGreaterThan(sentStart);
    const content = sent.at(-1)?.content;
    return content?.type === "text" ? content.text : "";
  };
  const memoryReport = await deliver();
  expect(memoryReport).toContain('"pending":1,"accepted":0,"rejected":0');
  expect(memoryReport).toContain(
    JSON.stringify({
      sources: 2,
      claims: 0,
      serializedBytes: new TextEncoder().encode(
        JSON.stringify({
          sources: [retainedSource, importedSource],
          claims: [],
        }),
      ).byteLength,
      limits: { sources: null, claims: null, serializedBytes: null },
    }),
  );
  expect(memoryReport).toContain("not total ledger/disk size");
  expect(memoryReport).toContain("remaining capacity is unknown");
  expect(memoryReport).toContain('"read":{"status":"succeeded"');
  expect(memoryReport).toContain('"transaction":{"status":"succeeded"');
  expect(memoryReport).toMatch(
    /"persistence":\{"calls":\d+,"completed":\d+,"failed":\d+,"totalDurationMs":[\d.]+,"maxDurationMs":[\d.]+\}/,
  );
  expect(memoryReport).toContain(
    '"retrieval":{"calls":0,"completed":0,"failed":0,"totalDurationMs":0,"maxDurationMs":null}',
  );
  expect(memoryReport).toContain("duration totals/max are elapsed ms");
  expect(memoryReport).toContain("Open is not a health check");
  expect(memoryReport.length).toBeLessThan(4000);
  action = { text: "", inspection: "imports" };
  const importReport = await deliver();
  const shown = importReport.match(/"selection":/g)?.length ?? 0;
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThanOrEqual(10);
  expect(importReport).toContain(`Configured selections: 12; showing ${shown}`);
  expect(importReport).toContain('"pages":1,"complete":false');
  expect(importReport.match(/"notBefore":1000000/g)).toHaveLength(shown);
  expect(importReport.match(/"cooldownReason":"rate_limit"/g)).toHaveLength(
    shown,
  );
  expect(importReport.match(/"coolingDown":true/g)).toHaveLength(shown);
  expect(importReport).toContain("not provider readiness");
  expect(importReport).toContain("no polling or automatic retry");
  expect(importReport).toContain('"lastConflict":"immutable_source"');
  expect(importReport).toContain("Please arrange explicit reconciliation");
  expect(importReport).toContain("not a queued or completed repair");
  expect(importReport).toContain('"pages":1,"complete":true');
  expect(importReport).toContain('"started":false,"pages":0');
  expect(importReport).toContain('"gapCount":4');
  expect(importReport).toContain('"gapCount":3');
  expect(importReport).toContain(
    '"gapKinds":{"previously deleted source omitted":1,"unclassified (details withheld)":1,"retention-limited history":2}',
  );
  expect(importReport).toContain(
    '"gapKinds":{"plain-text body unavailable":1,"previously deleted source omitted":1,"unclassified (details withheld)":1}',
  );
  expect(importReport).toContain(
    "not gap-free coverage or complete account history",
  );
  expect(importReport).toContain("not counts of missing messages");
  expect(importReport).toContain(
    "Zero recorded gaps is not proof of completeness",
  );
  expect(importReport.length).toBeLessThanOrEqual(4000);
  expect(importReport).not.toContain("private-account");
  action = { text: "", inspection: "reflection" };
  const curiosityReport = await deliver();
  expect(curiosityReport).toContain('"pending":1,"running":0');
  expect(curiosityReport).toContain("Reconciliation is operator-only");
  expect(curiosityReport).toContain(
    "Live occupancy may include this inspection turn",
  );
  expect(curiosityReport).toContain('"progress":"pending"');
  expect(curiosityReport).toContain(
    '"currentInputs":{"episodes":1,"ownerCorrections":0,"dreamHypotheses":0}',
  );
  expect(curiosityReport).toContain('"recordedOutcome":"not-recorded"');
  expect(curiosityReport).toContain("Public search: not performed");
  expect(requests.at(-1)?.system).toContain(
    'For curiosity progress/provenance, use inspection:"reflection"',
  );
  expect(reads).toBe(3);
  expect(requests).toHaveLength(3);
  action = { text: "", inspection: "native-coding" };
  expect(await deliver()).toContain(
    "coding.enabled is false (activation gate closed)",
  );
  action = { text: "", inspection: "retention" };
  const retentionReport = await deliver();
  for (const category of [
    "Ledger:",
    "Rivet journals:",
    "Snapshots:",
    "Backups:",
    "Delivered messages:",
  ])
    expect(retentionReport).toContain(category);
  expect(retentionReport).toContain("Physical erasure is unverified");
  expect(retentionReport.length).toBeLessThan(4000);
  expect(reads).toBe(5);
  expect(requests).toHaveLength(5);
  action = { text: "", inspection: "capabilities" };
  expect(await deliver()).toContain(
    "Generic capability routes are mounted. Registered tools: 0.",
  );
  expect(requests.at(-1)?.system).toContain('set inspection to "capabilities"');
  expect(reads).toBe(6);
  expect(requests).toHaveLength(6);
  action = { text: "", inspection: "inference" };
  expect(await deliver()).toContain(
    "Recorded recovery receipts: 0; showing latest 0",
  );
  expect(requests).toHaveLength(7);
  expect(reads).toBe(6);
  action = { text: "", inspection: "credentials" };
  const credentialReport = await deliver();
  expect(credentialReport).toContain("Credential resolver: configured");
  expect(credentialReport).toContain("Configured bindings: 1; showing 1");
  expect(credentialReport).toContain('[{"binding":1,"field":"login"}]');
  expect(credentialReport).toContain(
    "Vault authentication and item availability: unverified",
  );
  expect(credentialReport.length).toBeLessThan(1500);
  expect(reads).toBe(7);
  expect(requests).toHaveLength(8);
  action = { text: "", inspection: "operations" };
  const operations = await deliver();
  expect(operations).toContain('"model":{"started":1,"uncertain":0}');
  expect(operations).toContain('"status":"unresolved"');
  expect(operations).toContain(
    "Process health, idle state and restart do not prove settlement",
  );
  expect(operations).toContain('"migration":{"phase":"legacy"');
  expect(operations).toContain("modelSettlementUnproven");
  expect(operations).toContain("barrierNotObserved");
  expect(operations).toContain(
    "confirmedStopped alone does not resolve message delivery or permit replay",
  );
  expect(requests.at(-1)?.system).toContain('set inspection to "operations"');
  expect(requests).toHaveLength(9);
  expect(reads).toBe(8);
  const privateActor = client.conversation.getOrCreate(["private", owner.id]);
  const beforeInspection = await privateActor.snapshot();
  await privateActor.outstandingOperations();
  expect(await privateActor.snapshot()).toEqual(beforeInspection);
  await expect(
    client.conversation
      .getOrCreate(["private", "other-owner"])
      .outstandingOperations(),
  ).rejects.toThrow();
  action = { text: "", inspection: "mcp-connections" };
  expect(await deliver()).toContain(
    "MCP is disconnected: integration disabled",
  );
  expect(requests.at(-1)?.system).toContain(
    'set inspection to "mcp-connections"',
  );
  expect(requests.at(-1)?.mcpAvailable).toBe(false);
  expect(reads).toBe(9);
  expect(requests).toHaveLength(10);
  action = {
    text: "",
    inspection: { target: "imports", selection: null, offset: 0 },
  };
  const catalog = JSON.parse((await deliver()).split("\n")[1] ?? "");
  expect(JSON.parse(catalog.selectionsJson)).toEqual(
    Array.from({ length: 12 }, (_, i) => `selection-${i}`),
  );
  for (const id of ["selection-0", "selection-11"]) {
    action = {
      text: "",
      inspection: { target: "imports", selection: id, offset: 0 },
    };
    const report = await deliver();
    const data = JSON.parse(report.split("\n")[1] ?? "");
    const { audiences: _audiences, ...expected } = selections[id] ?? coverage;
    expect(JSON.parse(data.coverageJson)).toEqual({
      selection: id,
      ...expected,
    });
    expect(data.nextOffset).toBeNull();
    expect(data.digest).toBe(imports.review(id).digest);
    expect(data.pages).toBe(id === "selection-0" ? 1 : 0);
    expect(report).toContain(
      id === "selection-0" ? "timeline only" : "label IDs, not threads",
    );
    expect(report).toContain("no account data was read");
    expect(report.length).toBeLessThan(3500);
  }
  expect(reads).toBe(12);
  expect(requests).toHaveLength(13);
  action = { text: "", inspection: "capability-matrix" };
  const matrix = await deliver();
  expect(matrix).toContain('"liveVerified":"unknown"');
  expect(matrix).toContain(
    '"capability":"retained-memory","implemented":"yes","hostIntegrated":"yes","juneCallable":"no","enabled":"yes"',
  );
  expect(matrix.length).toBeLessThan(6000);
  expect(reads).toBe(13);
  expect(requests).toHaveLength(14);
  expect(requests.at(-1)?.system).toContain(
    'use inspection:"capability-matrix"',
  );
  action = { text: "", inspection: "capacity" };
  const capacityReport = await deliver();
  expect(capacityReport).toContain(
    '"limits":{"total":3,"guests":1,"background":2,"nonOwner":2,"waitingBackground":32}',
  );
  expect(capacityReport).toContain(
    '"active":1,"owners":1,"guests":0,"background":0',
  );
  expect(capacityReport).toContain('"pending":0,"queued":0');
  expect(capacityReport).toContain('"durableUnknownHolds":null');
  expect(capacityReport).toContain('"externalActive":null');
  expect(capacityReport.length).toBeLessThan(3500);
  expect(reads).toBe(14);
  expect(requests).toHaveLength(15);
  const inspectionCases = [
    ["tombstones", '"watermark":1'],
    ["capability-matrix", '"liveVerified":"unknown"'],
    ["native-coding", "coding.enabled is false (activation gate closed)"],
    ["memory", '"sources":2,"claims":0'],
    ["imports", "Configured selections: 12"],
    ["reflection", '"pending":1,"running":0'],
    ["retention", "Physical erasure is unverified"],
    ["capabilities", "Registered tools: 0"],
    ["inference", "Recorded recovery receipts: 0; showing latest 0"],
    ["forgetting", '"pending":0,"started":0,"completed":0'],
    ["credentials", "Configured bindings: 1; showing 1"],
    ["slack-search", "present and unconsumed in the local cache"],
    ["snapshot-retention", '"dryRun":true,"automaticDeletion":false'],
    [
      "operations",
      "Process health, idle state and restart do not prove settlement",
    ],
    ["mcp-connections", "MCP is disconnected: integration disabled"],
    ["mcp-enrollment", "Host configuration required"],
    [
      { target: "imports", selection: "selection-11", offset: 0 },
      "owner@example.test",
    ],
    ["capacity", '"durableUnknownHolds":null'],
  ] as const;
  for (const [index, [inspection, expected]] of inspectionCases.entries()) {
    action = { text: "", inspection };
    for (const extra of [
      // Cover every target on an admitted shared/guest surface, not a redundant
      // Cartesian product. Guest actors receive at most four calls each.
      index % 2 === 0
        ? {
            direct: false,
            metadata: { channelType: "channel" as const },
            address: {
              channel: "slack" as const,
              accountId: "T1",
              conversationId: "C1",
            },
          }
        : {
            senderId: `guest-${Math.floor(guestCase++ / 4)}`,
            metadata: { channelType: "im" as const },
          },
      ...(inspection === "mcp-connections" ||
      inspection === "mcp-enrollment" ||
      inspection === "memory" ||
      inspection === "credentials"
        ? [
            {
              direct: false,
              senderId: "group-guest",
              metadata: { channelType: "mpim" as const },
              address: {
                channel: "slack" as const,
                accountId: "T1",
                conversationId: "G1",
              },
            },
          ]
        : []),
    ]) {
      const before = requests.length;
      const readsBefore = reads;
      const report = await deliver(extra);
      expect(report).toContain(expected);
      expect(report).not.toMatch(/SECRET|secret-source|another-audience/);
      expect(report.length).toBeLessThanOrEqual(
        inspection === "capability-matrix" ? 6000 : 4000,
      );
      expect(requests).toHaveLength(before + 1);
      expect(requests.at(-1)?.inspectionAvailable).toBe(true);
      expect(requests.at(-1)?.importCancelAvailable).toBe(true);
      expect(reads).toBe(
        readsBefore +
          (inspection === "inference" || inspection === "forgetting" ? 0 : 1),
      );
      expect(cancellations).toBe(0);
    }
  }
  // The same host gate covers all targets; exercise both local and delegated
  // readers, including a structured selection, without repeating every surface.
  for (const inspection of [
    "memory",
    "inference",
    { target: "imports", selection: "selection-11", offset: 0 },
  ] as const) {
    action = { text: "", inspection };
    const readsBeforeDenials = reads;
    search = true;
    expect(await deliver()).toContain(
      "Subsystem inspection requires an available integration for this task",
    );
    expect(requests.at(-1)?.usageStage).toBe("synthesis");
    expect(requests.at(-1)?.inspectionAvailable).toBe(false);
    expect(requests.at(-1)?.importCancelAvailable).toBe(false);
    expect(reads).toBe(readsBeforeDenials);
    search = false;
    unchecked = true;
    action = {
      text: "",
      inspection,
      release: { action: "inspect", revision: null },
    };
    expect(await deliver()).toContain("inspection is unavailable");
    expect(reads).toBe(readsBeforeDenials);
    expect(cancellations).toBe(0);
    unchecked = false;
  }
  const readsAfterShared = reads;
  action = { text: "", inspection: "slack-search" };
  const readiness = await deliver();
  expect(readiness).toContain("Runtime slack.searchEnabled: true");
  expect(readiness).toContain("present and unconsumed in the local cache");
  expect(readiness).toContain("actual installed bot grant is unverified");
  expect(readiness).toContain("Live search access is unverified");
  expect(readiness).toContain("No Slack request was made");
  expect(reads).toBe(readsAfterShared + 1);
  action = { text: "", inspection: "mcp-enrollment" };
  expect(await deliver()).toContain("Host configuration required");
  expect(requests.at(-1)?.system).toContain('inspection to "mcp-enrollment"');
  expect(requests.at(-1)?.mcpAvailable).toBe(false);
  expect(reads).toBe(readsAfterShared + 2);
  action = { text: "", inspection: "credentials" };
  fail = true;
  expect(await deliver()).toContain("inspection is unavailable");
  fail = false;
  // A completed old window must never describe a newly configured window.
  expect(store.importProgress("selection-1")?.complete).toBe(true);
  selections["selection-1"] = { ...coverage, to: 1001 };
  action = { text: "", inspection: "imports" };
  expect(await deliver()).toContain("inspection is unavailable");
  action = {
    text: "",
    inspection: { target: "imports", selection: "selection-1", offset: 0 },
  };
  expect(await deliver()).toContain("inspection is unavailable");
  expect(store.importProgress("selection-1")?.coverage.to).toBe(999);
  action = {
    text: "",
    inspection: { target: "imports", selection: "hidden", offset: 0 },
  };
  expect(await deliver()).toContain("inspection is unavailable");
  disabled = true;
  for (const target of [
    "tombstones",
    "memory",
    "imports",
    "reflection",
    "snapshot-retention",
    "operations",
  ] as const) {
    action = { text: "", inspection: target };
    expect(await deliver()).toContain("unavailable");
  }
  action = { text: "", inspection: "native-coding" };
  expect(await deliver()).toContain(
    "preflight is unavailable; readiness cannot be inferred",
  );
  action = { text: "", inspection: "retention" };
  expect(await deliver()).toContain("Ledger: not configured in this runtime");
  action = { text: "", inspection: "capabilities" };
  expect(await deliver()).toContain("Generic capabilities are disabled");
  action = { text: "", inspection: "credentials" };
  expect(await deliver()).toContain("Credential resolver: absent");
  action = { text: "", inspection: "slack-search" };
  expect(await deliver()).toContain("Slack is not configured");
  action = { text: "", inspection: "capability-matrix" };
  expect(await deliver()).toContain("live verification are unknown");
  disabled = false;
  action = { text: "", inspection: "snapshot-retention" };
  const before = personality.retentionReport();
  const snapshotReport = await deliver();
  expect(snapshotReport).toContain(JSON.stringify(before));
  expect(snapshotReport).toContain('"dryRun":true,"automaticDeletion":false');
  expect(snapshotReport).toContain("replay later tombstones");
  expect(snapshotReport.length).toBeLessThan(2000);
  expect(snapshotReport).not.toContain(root);
  expect(personality.retentionReport()).toEqual(before);
  extractionEnabled = true;
  action = { text: "", inspection: "imports" };
  const extractionReport = await deliver();
  expect(extractionReport.length).toBeLessThanOrEqual(4000);
  expect(extractionReport).toContain('"batch":1,"eligible":1');
  expect(extractionReport).toContain('"overflow":0');
  expect(extractionReport).toContain(
    '"state":"paused","reason":"approval-required"',
  );
  expect(extractionReport).toContain(
    '"review":"/operator/imports/selection-0/extraction"',
  );
  expect(extractionReport).toMatch(/"digest":"[a-f0-9]{64}"/);
  expect(extractionReport).toContain(
    'importCancel:{action:"extract",selection:ID,digest} with extraction.digest',
  );
  expect(extractionReport).toContain("not a compulsory human step");
  expect(extractionReport).toContain("pending claims only");
  expect(extractionReport).not.toContain("secret-source");
  expect(requests.at(-1)?.system).toContain(
    'For extraction status use inspection:"imports"',
  );
  expect(JSON.stringify(sent)).not.toContain("SECRET");
  expect(JSON.stringify(sent)).not.toContain("secret-source");
  expect(fetches).toBe(1); // Inspection never retried the rejected page.
  expect(store.source(audience, retainedSource.id)).toEqual(retainedSource);
  expect(JSON.stringify(sent)).not.toContain("https://secret.example");
  expect(JSON.stringify(sent)).not.toContain(
    "12345678-1234-1234-1234-123456789abc",
  );
  expect(sessions).toBe(0);
  expect(vaultReads).toBe(0);
  expect(importProgressSnapshot()).toEqual(importsBeforeInspection);
  expect(store.proposals(audience)).toEqual(proposalsBeforeInspection);
  expect(personality.ownerHistory()).toEqual(revisionsBeforeInspection);
  disabled = false;
  store.deleteSource("SECRET TOMBSTONE ID");
  action = { text: "", inspection: "tombstones" };
  const readsBeforeTombstone = reads;
  const tombstoneReport = await deliver();
  // The import fixture already tombstoned one source above.
  expect(tombstoneReport).toContain(
    '"watermark":2,"maxEntries":100,"maxBytes":64000',
  );
  expect(tombstoneReport).toContain(
    "Independent retention and physical purge are not verified",
  );
  expect(tombstoneReport.length).toBeLessThan(1000);
  expect(requests.at(-1)?.system).toContain('use inspection:"tombstones"');
  expect(reads).toBe(readsBeforeTombstone + 1);
  // Synthesis and malformed custom-provider actions still cannot cancel.
  action = { text: "", importCancel: "selection-0" };
  search = true;
  expect(await deliver()).toContain(
    "Import cancellation requires an available integration for this task",
  );
  expect(requests.at(-1)?.usageStage).toBe("synthesis");
  expect(requests.at(-1)?.importCancelAvailable).toBe(false);
  search = false;
  unchecked = true;
  for (const invalid of [
    { text: "", importCancel: "selection-0", inspection: "memory" },
    { text: "SECRET UNTRUSTED RECEIPT", importCancel: "selection-0" },
  ] as const) {
    action = invalid;
    expect(await deliver()).toContain("could not be confirmed");
    expect(requests.at(-1)?.inspectionAvailable).toBe(true);
    expect(requests.at(-1)?.importCancelAvailable).toBe(true);
  }
  action = { text: "SECRET UNTRUSTED STATUS", inspection: "memory" };
  expect(await deliver()).toContain("inspection is unavailable");
  unchecked = false;
  expect(cancellations).toBe(0);
  expect(reads).toBe(readsBeforeTombstone + 1);
  expect(importProgressSnapshot()).toEqual(importsBeforeInspection);

  // Callability never admits a fabricated conversation or import audience.
  const requestsBeforeForgery = requests.length;
  await expect(
    privateActor.receive({
      id: "forged-owner-scope",
      type: "message",
      messageId: "forged-owner-scope",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D3" },
      senderId: "U3",
      direct: true,
      metadata: { channelType: "im" },
      text: "Inspect your status",
    }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(requestsBeforeForgery);
  expect(cancellations).toBe(0);
  expect(reads).toBe(readsBeforeTombstone + 1);
  for (const selection of ["hidden", "not-configured"]) {
    action = { text: "", importCancel: selection };
    const denied = await deliver({
      senderId: "cancellation-guest",
      metadata: { channelType: "im" },
    });
    expect(denied).toContain("could not be confirmed");
    expect(denied).not.toMatch(/hidden|not-configured|authorized|SECRET/);
    expect(importProgressSnapshot()).toEqual(importsBeforeInspection);
  }
  expect(cancellations).toBe(2);

  // Each admitted audience cancels a different exact selection. The configured
  // retention audience stays bound; only that selection's cancelled bit changes.
  const cancellationCases: [string, Partial<MessageEvent>][] = [
    ["selection-0", {}],
    [
      "selection-2",
      { senderId: "cancellation-guest", metadata: { channelType: "im" } },
    ],
    [
      "selection-3",
      {
        direct: false,
        senderId: "channel-guest",
        botMentioned: true,
        metadata: { channelType: "channel" },
        address: { channel: "slack", accountId: "T1", conversationId: "C2" },
      },
    ],
    [
      "selection-4",
      {
        direct: false,
        senderId: "cancellation-group-guest",
        metadata: { channelType: "mpim" },
        address: { channel: "slack", accountId: "T1", conversationId: "G2" },
      },
    ],
  ];
  for (const [selection, extra] of cancellationCases) {
    store.beginImport(selection, coverage);
    const before = importProgressSnapshot();
    const cancellationsBefore = cancellations;
    action = { text: "", importCancel: selection };
    expect(await deliver(extra)).toContain("recorded durably");
    expect(requests.at(-1)?.importCancelAvailable).toBe(true);
    expect(cancellations).toBe(cancellationsBefore + 1);
    expect(importProgressSnapshot()).toEqual({
      ...before,
      [selection]: { ...before[selection], cancelled: true },
    });
  }
  const afterCancellation = importProgressSnapshot();
  action = { text: "", importCancel: "selection-0" };
  expect(await deliver()).toContain("recorded durably");
  expect(cancellations).toBe(7);
  expect(importProgressSnapshot()).toEqual(afterCancellation);
  expect(store.importProgress("selection-0")).toEqual({
    ...progress,
    cancelled: true,
  });
  selections["selection-1"] = coverage;
  action = { text: "", inspection: "imports" };
  expect(await deliver()).toContain('"cancelled":true');
  expect(fetches).toBe(1); // Cancellation/inspection never retried the conflict.
  expect(JSON.stringify(sent)).not.toContain("SECRET");
  expect(store.source(audience, retainedSource.id)).toEqual(retainedSource);
  expect(store.proposals(audience)).toEqual(proposalsBeforeInspection);
  expect(personality.ownerHistory()).toEqual(revisionsBeforeInspection);
  expect(() =>
    parseReply('{"text":"","importCancel":"selection-0"}', []),
  ).toThrow();
  action = { text: "", inspection: "memory" };
  expect(() =>
    store.appendSource({ ...retainedSource, text: "SECRET WRITE ERROR" }),
  ).toThrow();
  const failedWriteReport = await deliver();
  expect(failedWriteReport).toContain('"transaction":{"status":"failed"');
  expect(failedWriteReport).toContain('"sources":2,"claims":0');
  store.deleteSource("secret-source");
  extractionEnabled = false;
  action = { text: "", inspection: "reflection" };
  const afterDeletion = await deliver();
  expect(afterDeletion).toContain('"currentInputs":null');
  expect(afterDeletion).toContain('"recordedOutcome":"withheld"');
  expect(afterDeletion).not.toContain("secret-source");
  extractionEnabled = true;
  action = { text: "", inspection: "memory" };
  store.close();
  const failedReadReport = await deliver();
  expect(failedReadReport).toContain("snapshot failed");
  expect(failedReadReport).toContain("counts and size are unknown");
  expect(failedReadReport).toContain('"connection":"closed"');
  expect(failedReadReport).toContain('"read":{"status":"failed"');
  expect(failedReadReport).not.toContain('"sources":0');
  expect(JSON.stringify(sent)).not.toContain("SECRET");
  expect(JSON.stringify(requests)).not.toContain("SECRET");
  expect(extractions).toBe(0);
  expect(reflections).toBe(0);
  for (const inspection of [
    "start",
    "forget",
    { target: "memory", audience: "guest" },
    { target: "imports", selection: "selection-0", offset: 0, audience },
    { target: "imports", selection: "selection-0", offset: -1 },
    { target: "imports", selection: "selection-0", offset: 0.5 },
  ])
    expect(() =>
      parseReply(JSON.stringify({ text: "", inspection }), [], {
        inspectionAvailable: true,
      }),
    ).toThrow();
  expect(() => parseReply('{"text":"","inspection":"memory"}', [])).toThrow();
}, 90_000);

it("preserves exact cancellation targets with shared prefixes while bounding metadata", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const prefix = "s".repeat(80);
  const longer = `${prefix}-separate-job`;
  const omitted = "y".repeat(2048);
  const coverage = {
    platform: "slack",
    account: "fixture",
    conversations: ["C1"],
    from: 1,
    to: 2,
    audiences: ["owner"],
  };
  const selections = Object.fromEntries(
    [prefix, longer, "unrelated", omitted].map((id) => [id, coverage]),
  );
  const imports = new HistoryImports(
    store,
    Object.fromEntries(
      Object.entries(selections).map(([id, coverage]) => [
        id,
        {
          coverage,
          credentialAccount: "FIXTURE_SLACK_ACCOUNT",
          fetchPage: async () => {
            throw new Error("No reads allowed");
          },
        },
      ]),
    ),
  );
  const report = await createInspectionReader({
    audience: "owner",
    imports,
    selections,
  })("imports");
  expect(report).toContain(JSON.stringify({ selection: prefix }).slice(0, -1));
  expect(report).toContain(JSON.stringify({ selection: longer }).slice(0, -1));
  expect(report).toContain("showing 3");
  expect(report).not.toContain(omitted);
  expect(report.length).toBeLessThanOrEqual(4000);
  const action = parseReply(
    JSON.stringify({ text: "", importCancel: longer }),
    [],
    { importCancelAvailable: true },
  );
  if (typeof action.importCancel !== "string")
    throw new Error("Expected cancellation ID");
  imports.cancel(action.importCancel, "owner");
  expect(store.importProgress(longer)?.cancelled).toBe(true);
  expect(store.importProgress(prefix)).toBeUndefined();
});

it("keeps interrupted reflection inspection bounded, private and read-only without claiming settlement", async () => {
  const audience = "owner-private";
  const requests = Array.from({ length: 12 }, (_, i) => ({
    id: `SECRET REQUEST ${i}`,
    scope: audience,
    evidenceIds: ["SECRET SOURCE"],
    kind: "reflection" as const,
    status: i === 1 ? ("cancelling" as const) : ("running" as const),
    attempts: 2,
    createdAt: 1,
  }));
  // Exclude foreign work before both aggregation and the five-row bound.
  const first = requests[0];
  if (!first) throw new Error("Missing reflection fixture");
  requests.unshift({ ...first, id: "SECRET FOREIGN", scope: "other" });
  const status = {
    reflection: { version: 1 as const, requests, scopes: [] },
    invocations: Object.fromEntries(
      requests.map((request, i) => [
        JSON.stringify([request.id, 2]),
        i === 2 ? ("started" as const) : ("uncertain" as const),
      ]),
    ),
    liveActive: 14,
    activeTurnIds: Array.from({ length: 12 }, (_, i) => `SECRET TURN ${i}`),
    candidateIds: ["SECRET CANDIDATE"],
  };
  const before = structuredClone(status);
  const read = createInspectionReader({
    audience,
    selections: {},
    reflection: async () => status,
  });
  const report = await read("reflection");
  expect(status).toEqual(before);
  expect(report).not.toContain("SECRET");
  expect(report).not.toContain(audience);
  expect(report).toContain('"running":11,"cancelling":1');
  expect(report).toContain('"started":1,"settled":0,"uncertain":11');
  expect(report).toContain("Held scoped requests: 12; showing 5.");
  expect(report).toContain("Owner-wide live turn references: 12; showing 5.");
  const rows = JSON.parse(report.split("showing 5. ")[1]?.split("\n")[0] ?? "");
  expect(rows).toHaveLength(5);
  expect(rows[0]).toEqual({
    reference:
      "34166e0796c504dc750032965719990ff7f1361372810a4870cfc17be7fb2405",
    status: "running",
    attempt: 2,
    invocation: "uncertain",
  });
  expect(rows[1]).toMatchObject({
    status: "cancelling",
    invocation: "started",
  });
  const turns = JSON.parse(
    report.split("showing 5. ")[2]?.split("\n")[0] ?? "",
  );
  expect(turns).toHaveLength(5);
  expect(turns[0]).toBe(
    "4c1a9245f15d4fe290d6dae1b83e9a1686f4da1f38f08c2d3eac5dd4b3b27428",
  );
  expect(report).toContain(
    "its outcome is unknown, not success or confirmed failure",
  );
  expect(report).toContain("cancelling is not stopped");
  expect(report).toContain(
    "Do not retry unknown work or release its capacity automatically",
  );
  expect(report).toContain("GET /operator/reflection");
  expect(report).toContain("POST /operator/reflection/reconcile");
  expect(report).toContain('"confirmedStopped":true,"live":false');
  expect(report).toContain('"confirmedStopped":true,"live":true');
  expect(report).toContain(
    "If stoppage cannot be verified, leave the hold and outcome unknown",
  );
  expect(report).toContain("Require reconciled:true and read status again");
  expect(report.length).toBeLessThan(4000);
});

it("projects bounded unresolved metadata without reading payloads or mutating replay markers", () => {
  const modelInvocations = Object.freeze({
    "SECRET START": "started" as const,
    "SECRET UNCERTAIN": "uncertain" as const,
    "SECRET SETTLED": "settled" as const,
  });
  const webInvocations = Object.freeze({ "SECRET QUERY": "started" as const });
  const deliveries = Object.freeze(
    Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `SECRET DESTINATION ${i}`,
        Object.freeze({
          get message(): OutboundMessage {
            throw new Error("must not read payload");
          },
          phase: i === 0 ? ("sending" as const) : ("settled" as const),
          attempts: 1,
          result:
            i === 0
              ? {
                  status: "rejected" as const,
                  code: "SECRET ERROR",
                  retryable: true,
                }
              : { status: "unknown" as const, code: "SECRET ERROR" },
        }),
      ]),
    ),
  );
  const state = Object.freeze({ modelInvocations, webInvocations, deliveries });
  const snapshot = outstandingOperationMetadata(state);
  expect(snapshot.counts).toEqual({
    model: { started: 1, uncertain: 1 },
    web: { started: 1, uncertain: 0 },
    delivery: { sending: 1, unknown: 11 },
  });
  expect(snapshot.operations).toHaveLength(10);
  expect(snapshot.omitted).toBe(5);
  expect(
    snapshot.operations.every(
      (row) => row.status === "unresolved" && /^[a-f0-9]{64}$/.test(row.id),
    ),
  ).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("SECRET");
  expect(outstandingOperationMetadata(state)).toEqual(snapshot);
  expect(outstandingOperationMetadata({ deliveries: {} }).recorded).toEqual({
    model: false,
    web: false,
  });
});

it("pages exact scope without widening audiences or fetching history", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const coverage = {
    platform: "slack",
    account: "TEXACT",
    conversations: Array.from({ length: 130 }, (_, i) => `C${i}/123.456789`),
    from: 123001,
    to: 987999,
    audiences: ["private"],
  };
  // Similar long IDs must remain distinguishable, even beyond summary limits.
  const ids = Array.from({ length: 12 }, (_, i) => `${"s".repeat(100)}-${i}`);
  const selections = Object.fromEntries<typeof coverage>([
    ["SECRET", { ...coverage, audiences: ["other"] }],
    ...ids.map((id) => [id, coverage] as const),
  ]);
  const imports = new HistoryImports(
    store,
    Object.fromEntries(
      Object.entries(selections).map(([id, coverage]) => [
        id,
        {
          coverage,
          credentialAccount: "FIXTURE_EXACT_ACCOUNT",
          async fetchPage() {
            throw new Error("must not fetch history");
          },
        },
      ]),
    ),
  );
  const read = createInspectionReader({
    audience: "private",
    selections,
    imports,
  });
  for (const selection of [null, ids[11] as string]) {
    let offset: number | null = 0;
    let json = "";
    let pages = 0;
    while (offset !== null) {
      const report = await read({ target: "imports", selection, offset });
      expect(report).not.toContain("SECRET");
      expect(report.length).toBeLessThan(3500);
      const data = JSON.parse(report.split("\n")[1] ?? "");
      if (selection !== null)
        expect(data.digest).toBe(imports.review(selection).digest);
      json += selection === null ? data.selectionsJson : data.coverageJson;
      expect(data.nextOffset === null || data.nextOffset > offset).toBe(true);
      offset = data.nextOffset;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(JSON.parse(json)).toEqual(
      selection === null
        ? ids
        : {
            selection,
            platform: "slack",
            account: "TEXACT",
            conversations: coverage.conversations,
            from: 123001,
            to: 987999,
          },
    );
  }
  for (const selection of ["SECRET", "constructor", "missing"])
    await expect(
      read({ target: "imports", selection, offset: 0 }),
    ).rejects.toThrow("unavailable");
  await expect(
    read({ target: "imports", selection: null, offset: 999999 }),
  ).rejects.toThrow("offset");
  expect(imports.status(ids[11] as string)).toMatchObject({
    running: false,
    progress: undefined,
    notBefore: 0,
    cooldownReason: null,
    coolingDown: false,
  });
  const mismatched = createInspectionReader({
    audience: "private",
    imports,
    selections: { [ids[0] as string]: { ...coverage, account: "TOTHER" } },
  });
  await expect(mismatched("imports")).rejects.toThrow("coverage changed");
  await expect(
    mismatched({ target: "imports", selection: ids[0] as string, offset: 0 }),
  ).rejects.toThrow("coverage changed");
});
