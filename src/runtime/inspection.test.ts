import { randomBytes } from "node:crypto";
import type { Client } from "rivetkit/client";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { nativeCodingPreflight } from "../coding/preflight.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { HistoryImports } from "../imports/index.js";
import type { CuratedPersonalityStore } from "../memory/curated.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createInspectionReader } from "./inspection.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";

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

it("inspects bounded metadata through June while enforcing owner, guest, synthesis and read-only boundaries", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
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
  let fetches = 0;
  const imports = new HistoryImports(
    store,
    Object.fromEntries(
      Object.entries(selections).map(([id, coverage]) => [
        id,
        {
          coverage,
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
  store.persistPage(
    initial,
    {
      sources: [forgotten],
      nextCursor: "SECRET CURSOR",
      gaps: ["SECRET GAP"],
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
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
  let action: CompanionReply = { text: "", inspection: "memory" };
  let search = false;
  let fail = false;
  let disabled = false;
  let reads = 0;
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
        expect(
          Object.hasOwn(replyJsonSchema([], request).properties, "inspection"),
        ).toBe(request.inspectionAvailable);
        if (request.inspectionAvailable)
          expect(request.system).toContain(
            'Set inspection to "memory", "imports", "reflection", or "native-coding"',
          );
        if (request.inspectionAvailable)
          expect(request.system).toContain('Set inspection to "retention"');
        if (request.inspectionAvailable)
          expect(request.system).toContain("serialized-byte usage/limits");
        if (search && request.webSearchAvailable)
          return { text: "", webSearch: "public query" };
        // Exercise provider parsing for valid actions, and host guards against
        // providers that return forbidden or mixed directives without parsing.
        if (request.inspectionAvailable && !action.release)
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
    inspection: async (target) => {
      reads++;
      if (fail) throw new Error("SECRET ERROR PATH");
      return (
        disabled ? createInspectionReader({ audience, selections: {} }) : read
      )(target);
    },
    reflection: {
      ownerId: owner.id,
      policy: {
        totalCapacity: 2,
        liveReserve: 1,
        cooldownMs: 1,
        maxAttempts: 1,
        maxNoNewEvidence: 1,
        evidenceMaxAgeMs: 60000,
        quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
      },
      idleMs: 86400000,
      deepMs: 86400000,
      pollMs: 10000,
      timeoutMs: 1000,
      async retrieve() {
        throw new Error("must not retrieve reflection evidence");
      },
      async decide() {
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
    evidenceIds: ["SECRET EVIDENCE ID"],
    kind: "reflection",
    mode: "idle",
  });
  const read = createInspectionReader({
    audience,
    memory: { store },
    imports,
    selections,
    capabilities: () =>
      "Generic capability routes are mounted. Registered tools: 0.",
    nativeCoding: () =>
      nativeCodingPreflight(
        { enabled: false, workspaces: {}, isolation: {}, timeoutMs: 1000 },
        false,
        {},
      ),
    reflection: () => reflection.status(),
  });
  const deliver = async (extra: Partial<MessageEvent> = {}) => {
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
    const content = sent.at(-1)?.content;
    return content?.type === "text" ? content.text : "";
  };
  const memoryReport = await deliver();
  expect(memoryReport).toContain('"pending":1,"accepted":0,"rejected":0');
  expect(memoryReport).toContain(
    JSON.stringify({
      sources: 1,
      claims: 0,
      serializedBytes: new TextEncoder().encode(
        JSON.stringify({ sources: [retainedSource], claims: [] }),
      ).byteLength,
      limits: { sources: null, claims: null, serializedBytes: null },
    }),
  );
  expect(memoryReport).toContain("not total ledger/disk size");
  expect(memoryReport).toContain("remaining capacity is unknown");
  expect(memoryReport).toContain('"read":{"status":"succeeded"');
  expect(memoryReport).toContain('"transaction":{"status":"succeeded"');
  expect(memoryReport).toContain("Open is not a health check");
  expect(memoryReport.length).toBeLessThan(2000);
  action = { text: "", inspection: "imports" };
  const importReport = await deliver();
  expect(importReport).toContain("Configured selections: 12; showing 10");
  expect(importReport).toContain('"pages":1,"complete":false');
  expect(importReport.match(/"notBefore":1000000/g)).toHaveLength(10);
  expect(importReport.match(/"cooldownReason":"rate_limit"/g)).toHaveLength(10);
  expect(importReport.match(/"coolingDown":true/g)).toHaveLength(10);
  expect(importReport).toContain("not provider readiness");
  expect(importReport).toContain("no polling or automatic retry");
  expect(importReport).toContain('"gapCount":2');
  expect(importReport).toContain('"lastConflict":"immutable_source"');
  expect(importReport).toContain("Please arrange explicit reconciliation");
  expect(importReport).toContain("not a queued or completed repair");
  expect(importReport.length).toBeLessThan(4000);
  action = { text: "", inspection: "reflection" };
  expect(await deliver()).toContain('"pending":1,"running":0');
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
  for (const inspection of [
    "native-coding",
    "memory",
    "retention",
    "capabilities",
  ] as const) {
    action = { text: "", inspection };
    for (const extra of [
      {
        direct: false,
        address: {
          channel: "slack" as const,
          accountId: "T1",
          conversationId: "C1",
        },
      },
      { senderId: "U2", metadata: { channelType: "im" as const } },
    ]) {
      const before = requests.length;
      expect(await deliver(extra)).toContain("owner-private turn");
      expect(requests).toHaveLength(before + 1);
      expect(requests.at(-1)?.inspectionAvailable).toBe(false);
      expect(reads).toBe(6);
    }
    search = true;
    await deliver();
    expect(requests.at(-1)?.usageStage).toBe("synthesis");
    expect(requests.at(-1)?.inspectionAvailable).toBe(false);
    expect(reads).toBe(6);
    search = false;
    action = {
      text: "",
      inspection,
      release: { action: "inspect", revision: null },
    };
    expect(await deliver()).toContain("inspection is unavailable");
    expect(reads).toBe(6);
  }
  action = { text: "", inspection: "memory" };
  fail = true;
  expect(await deliver()).toContain("inspection is unavailable");
  fail = false;
  // A completed old window must never describe a newly configured window.
  store.beginImport("selection-1", coverage);
  const oldWindow = store.importProgress("selection-1");
  if (!oldWindow) throw new Error("Missing fixture import");
  store.persistPage(oldWindow, { sources: [], nextCursor: null }, 1);
  expect(store.importProgress("selection-1")?.complete).toBe(true);
  selections["selection-1"] = { ...coverage, to: 1001 };
  action = { text: "", inspection: "imports" };
  expect(await deliver()).toContain("inspection is unavailable");
  expect(store.importProgress("selection-1")?.coverage.to).toBe(999);
  disabled = true;
  for (const target of ["memory", "imports", "reflection"] as const) {
    action = { text: "", inspection: target };
    expect(await deliver()).toContain("unavailable.");
  }
  action = { text: "", inspection: "native-coding" };
  expect(await deliver()).toContain(
    "preflight is unavailable; readiness cannot be inferred",
  );
  action = { text: "", inspection: "retention" };
  expect(await deliver()).toContain("Ledger: not configured in this runtime");
  action = { text: "", inspection: "capabilities" };
  expect(await deliver()).toContain("Generic capabilities are disabled");
  expect(JSON.stringify(sent)).not.toContain("SECRET");
  expect(JSON.stringify(sent)).not.toContain("secret-source");
  expect(JSON.stringify(sent)).not.toContain("private-account");
  expect(fetches).toBe(1); // Inspection never retried the rejected page.
  expect(store.source(audience, retainedSource.id)).toEqual(retainedSource);
  expect(store.importProgress("selection-0")).toEqual(progress);
  expect(store.proposals(audience)[0]?.status).toBe("pending");
  disabled = false;
  action = { text: "", inspection: "memory" };
  expect(() =>
    store.appendSource({ ...retainedSource, text: "SECRET WRITE ERROR" }),
  ).toThrow();
  const failedWriteReport = await deliver();
  expect(failedWriteReport).toContain('"transaction":{"status":"failed"');
  expect(failedWriteReport).toContain('"sources":1,"claims":0');
  store.close();
  const failedReadReport = await deliver();
  expect(failedReadReport).toContain("snapshot failed");
  expect(failedReadReport).toContain("counts and size are unknown");
  expect(failedReadReport).toContain('"connection":"closed"');
  expect(failedReadReport).toContain('"read":{"status":"failed"');
  expect(failedReadReport).not.toContain('"sources":0');
  expect(JSON.stringify(sent)).not.toContain("SECRET");
  for (const inspection of [
    "start",
    "forget",
    { target: "memory", audience: "guest" },
  ])
    expect(() =>
      parseReply(JSON.stringify({ text: "", inspection }), [], {
        inspectionAvailable: true,
      }),
    ).toThrow();
  expect(() => parseReply('{"text":"","inspection":"memory"}', [])).toThrow();
});
