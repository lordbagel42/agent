import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { McpConnections } from "../tools/connections.js";
import { type CapabilityContext, runCapability } from "./capabilities.js";
import { runExecutionCapability } from "./execution-capabilities.js";
import { conversationInputId } from "./inbox.js";
import { createInspectionReader } from "./inspection.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";

it("fresh exact commands and June's decision can back up in admitted guest/channel tasks; status and replay do not", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-backup-command-"));
  const store = new EvidenceStore(
    join(directory, "evidence.sqlite"),
    randomBytes(32),
  );
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const sent: OutboundMessage[] = [];
  let modelCalls = 0;
  let chooseBackup = false;
  store.appendSource({
    id: "private-source",
    audiences: [audience],
    platform: "slack",
    account: "T1",
    conversation: "D1",
    author: "U1",
    observedAt: 1,
    sourceUrl: "https://example.invalid/private-source",
    text: "PRIVATE_BACKUP_EVIDENCE_BODY",
  });
  const registry = createJuneRegistry({
    owner,
    memory: { store, source: () => undefined },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(message);
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
    model: {
      async reply(request) {
        modelCalls++;
        if (request.inspectionAvailable) {
          expect(request.system).toContain('inspection to "backup"');
          expect(request.system).toContain("!memory-backup");
          return parseReply(
            JSON.stringify({
              text: "",
              ...(chooseBackup
                ? { memoryBackup: true }
                : { inspection: "backup" }),
            }),
            [],
            request,
          );
        }
        // A misbehaving model still cannot bypass an absent inspection grant.
        return { text: "", inspection: "backup" };
      },
    },
    inspection: createInspectionReader({
      audience,
      memory: { store },
      selections: {},
    }),
  });
  const { client } = await setupTest(t, registry);
  t.onTestFinished(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  const deliver = async (patch: Partial<MessageEvent> = {}) => {
    const event: MessageEvent = {
      id: `event-${sequence++}`,
      messageId: `message-${sequence}`,
      type: "message",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      text: "!memory-backup",
      metadata: { channelType: "im" },
      memoryBackupEligible: true,
      ...patch,
    };
    const scope = routeEvent(event, owner, true);
    if (!scope) throw new Error("Missing test scope");
    const actor = client.conversation.getOrCreate(scope.key);
    const before = Object.values((await actor.snapshot()).events).filter(
      (e) => e.done,
    ).length;
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).filter((e) => e.done)
            .length,
        { timeout: 10000 },
      )
      .toBe(before + 1);
    return { event, actor };
  };
  const root = join(directory, "backups");
  await deliver({ text: 'Please quote "!memory-backup"' });
  await deliver({ text: " !memory-backup" });
  await deliver({ text: "!memory-backup\n" });
  await deliver({ memoryBackupEligible: undefined });
  await deliver({ memoryBackupEligible: false });
  expect(existsSync(root)).toBe(false);
  const guestChannel: Partial<MessageEvent> = {
    senderId: "guest",
    direct: false,
    botMentioned: true,
    address: { channel: "slack", accountId: "T1", conversationId: "C1" },
    metadata: { channelType: "channel" },
  };
  for (const patch of [
    { ...guestChannel, senderId: "U1" },
    { senderId: "guest" },
    guestChannel,
  ]) {
    const { event } = await deliver(patch);
    expect(store.backupStatus().latest?.id).toBe(
      conversationInputId({ type: "event", event }),
    );
  }
  const { event, actor } = await deliver();
  expect(modelCalls).toBe(5);
  expect(store.backupStatus().latest?.tombstoneWatermark).toBe(0);
  const files = readdirSync(root);
  await actor.send("inbox", { type: "event", event });
  await deliver({ text: "Inspect my backup" }); // A later turn drains the duplicate first.
  expect(modelCalls).toBe(6);
  expect(readdirSync(root)).toEqual(files);
  chooseBackup = true;
  const chosen = await deliver({
    ...guestChannel,
    text: "Keep the local evidence ledger safe",
    memoryBackupEligible: undefined,
  });
  expect(modelCalls).toBe(7);
  expect(store.backupStatus().latest?.id).toBe(
    conversationInputId({ type: "event", event: chosen.event }),
  );
  const reports = JSON.stringify(sent);
  expect(reports).toContain("Local encrypted evidence-ledger backup confirmed");
  expect(reports).toContain("This inspection created no backup");
  expect(reports).not.toContain(directory);
  expect(reports).not.toContain("payload");
  expect(reports).not.toContain("PRIVATE_BACKUP_EVIDENCE_BODY");
  expect(reports).not.toContain("private-source");
});

it("memoryBackup is a grant-gated, exclusive true-only directive with empty text", () => {
  const grants = { inspectionAvailable: true };
  for (const agentRole of [undefined, "execution"] as const) {
    const capabilities = { ...grants, agentRole };
    const schema = replyJsonSchema([], capabilities);
    expect(schema.properties).toHaveProperty("memoryBackup", {
      type: ["boolean", "null"],
      enum: [true, null],
      description: expect.any(String),
    });
    expect(schema.required).toContain("memoryBackup");
    expect(
      parseReply('{"text":"","memoryBackup":true}', [], capabilities),
    ).toEqual({ text: "", memoryBackup: true });
    expect(
      parseReply('{"text":"status","memoryBackup":null}', [], capabilities),
    ).toEqual({ text: "status" });
  }
  for (const capabilities of [
    {},
    { inspectionAvailable: false },
    { ...grants, agentRole: "interaction" as const },
    { ...grants, agentRole: "repository" as const },
  ]) {
    expect(replyJsonSchema([], capabilities).properties).not.toHaveProperty(
      "memoryBackup",
    );
    expect(replyJsonSchema([], capabilities).required).not.toContain(
      "memoryBackup",
    );
    expect(() =>
      parseReply('{"text":"","memoryBackup":true}', [], capabilities),
    ).toThrow("invalid_response");
  }
  for (const invalid of [
    { memoryBackup: false },
    { memoryBackup: "true" },
    { memoryBackup: { id: "a".repeat(64), path: "/tmp/not-authority" } },
    { text: "Already done" },
    { inspection: "backup" },
    { reaction: "thumbsup" },
    { mcp: { connection: "tool", tool: "run", argumentsJson: "{}" } },
    { mcpCatalog: { connection: null, tool: null, offset: 0 } },
    { mcpPermission: { connection: "tool", tool: "run" } },
    {
      mcpProposal: {
        action: "inspect",
        id: "11111111-1111-4111-8111-111111111111",
      },
    },
  ])
    expect(() =>
      parseReply(
        JSON.stringify({ text: "", memoryBackup: true, ...invalid }),
        [],
        {
          ...grants,
          mcpAvailable: true,
          mcpPermissionAvailable: true,
          mcpProposalAvailable: true,
        },
      ),
    ).toThrow("invalid_response");
});

function backupFixture() {
  const directory = mkdtempSync(join(tmpdir(), "june-model-backup-"));
  const path = join(directory, "evidence.sqlite");
  const key = randomBytes(32);
  let store = new EvidenceStore(path, key);
  onTestFinished(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const event: MessageEvent = {
    id: "guest-task",
    messageId: "1.000001",
    type: "message",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "C1" },
    direct: false,
    botMentioned: true,
    senderId: "guest",
    text: "Keep the ledger safe",
    metadata: { channelType: "channel" },
  };
  const unused = (): never => {
    throw new Error("Unexpected unrelated backup capability");
  };
  const deps: Dependencies = {
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    channels: {},
    model: {
      async reply() {
        return unused();
      },
    },
    memory: { store, source: () => undefined },
  };
  const scope = routeEvent(event, deps.owner);
  if (!scope) throw new Error("Missing guest task scope");
  const audience = JSON.stringify(scope.key);
  deps.inspection = createInspectionReader({
    audience,
    memory: { store },
    selections: {},
  });
  const context: CapabilityContext = {
    event,
    scope,
    audience,
    eventId: conversationInputId({ type: "event", event }),
    operationId: createHash("sha256").update("execution-backup").digest("hex"),
    origin: "event",
    phase: "reply",
    ownerTurn: false,
    deletionRevision: 0,
    personalityVersion: undefined,
    workspaces: [],
    signal: new AbortController().signal,
    valid: () => true,
    canStartAction: () => true,
    model: deps.model,
    deps,
    ports: {
      beginJevObservation: unused,
      personality: { stage: unused, read: unused, pending: unused },
      coding: {
        ids: unused,
        visible: unused,
        job: unused,
        hasProvenance: unused,
        bindReport: unused,
      },
      evidence: { sourceIds: unused, bindRecall: unused, bindPending: unused },
      inspectInference: unused,
      deliverRivet: unused,
      waitForTypingCleanup: unused,
      send: unused,
    },
  };
  const request: ModelRequest = {
    system: "Back up the local evidence ledger",
    messages: [],
    workspaces: [],
    inspectionAvailable: true,
    agentRole: "execution",
  };
  return {
    directory,
    key,
    store,
    context,
    request,
    reopen() {
      store.close();
      store = new EvidenceStore(path, key);
      deps.memory = { store, source: () => undefined };
      deps.inspection = createInspectionReader({
        audience,
        memory: { store },
        selections: {},
      });
      return store;
    },
    run(reply: CompanionReply) {
      return runExecutionCapability(
        reply,
        request,
        context,
        deps,
        {} as Parameters<typeof runExecutionCapability>[4],
        [],
        unused,
      );
    },
  };
}

it("a model-selected guest channel backup uses the host event identity without a command marker", async () => {
  const { store, context, request } = backupFixture();
  context.operationId = undefined;
  request.agentRole = undefined;
  expect(context.event.memoryBackupEligible).toBeUndefined();
  const reply = await runCapability(
    parseReply('{"text":"","memoryBackup":true}', [], request),
    request,
    context,
  );
  expect(store.backupStatus().latest?.id).toBe(context.eventId);
  expect(reply.text).toContain(JSON.stringify(store.backupStatus().latest));
});

it("a model-selected guest channel execution backup is terminal and idempotent across restart without exposing private bodies", async () => {
  const fixture = backupFixture();
  const { store, context, request, directory, key, run } = fixture;
  store.appendSource({
    id: "PRIVATE_SOURCE_ID",
    audiences: ['["private","owner"]'],
    platform: "slack",
    account: "PRIVATE_ACCOUNT",
    conversation: "PRIVATE_CONVERSATION",
    author: "PRIVATE_AUTHOR",
    observedAt: 1,
    sourceUrl: "https://example.invalid/PRIVATE_SOURCE",
    text: "PRIVATE_EVIDENCE_BODY",
  });
  const root = join(directory, "backups");
  const initial = await run({ text: "", inspection: "backup" });
  expect(initial.terminal).toBe(false);
  expect(initial.text).toContain("This inspection created no backup");
  expect(existsSync(root)).toBe(false);
  const directive = parseReply('{"text":"","memoryBackup":true}', [], request);
  const first = await run(directive);
  expect(first.terminal).toBe(true);
  const manifest = store.backupStatus().latest;
  expect(manifest).toMatchObject({
    id: context.operationId,
    tombstoneWatermark: 0,
  });
  expect(manifest?.id).not.toBe(context.eventId);
  expect(first.text).toContain(JSON.stringify(manifest));
  const files = readdirSync(root);
  const backupPath = join(root, manifest?.id ?? "missing", "evidence.sqlite");
  const ciphertext = readFileSync(backupPath);
  store.deleteSource("PRIVATE_SOURCE_ID");
  const reopened = fixture.reopen();
  const repeated = await run(directive);
  expect(repeated).toEqual(first);
  expect(reopened.backupStatus()).toMatchObject({
    latest: manifest,
    tombstoneWatermark: 1,
  });
  const inspected = await run({ text: "", inspection: "backup" });
  expect(inspected.terminal).toBe(false);
  expect(inspected.text).toContain("This inspection created no backup");
  expect(readdirSync(root)).toEqual(files);
  expect(readFileSync(backupPath)).toEqual(ciphertext);
  chmodSync(directory, 0o755);
  const unavailable = await run(directive);
  expect(unavailable).toEqual({
    text: "Local memory backup is unavailable; no new backup confirmed.",
    terminal: true,
  });
  const reports = JSON.stringify([
    initial,
    first,
    repeated,
    inspected,
    unavailable,
  ]);
  for (const forbidden of [
    directory,
    key.toString("hex"),
    key.toString("base64"),
    "PRIVATE_",
    "payload",
  ])
    expect(reports).not.toContain(forbidden);
});

it.each<[string, (context: CapabilityContext, request: ModelRequest) => void]>([
  [
    "missing grant",
    (_context, request) => {
      request.inspectionAvailable = false;
    },
  ],
  [
    "missing memory",
    (context) => {
      context.deps.memory = undefined;
    },
  ],
  [
    "synthesis",
    (context) => {
      context.phase = "synthesis";
    },
  ],
  [
    "wakeup",
    (context) => {
      context.origin = "wakeup";
    },
  ],
  [
    "worker result",
    (context) => {
      context.origin = "execution_result";
    },
  ],
  [
    "closed action admission",
    (context) => {
      context.canStartAction = () => false;
    },
  ],
  [
    "invalid event",
    (context) => {
      context.valid = () => false;
    },
  ],
  [
    "abort",
    (context) => {
      context.signal = AbortSignal.abort();
    },
  ],
])("model backup cannot run with %s", async (_name, restrict) => {
  const { directory, context, request, store } = backupFixture();
  restrict(context, request);
  const reply = await runCapability(
    { text: "", memoryBackup: true },
    request,
    context,
  );
  expect(reply).not.toHaveProperty("memoryBackup");
  expect(existsSync(join(directory, "backups"))).toBe(false);
  expect(store.backupStatus().latest).toBeNull();
});

it("custom-provider backups cannot accompany MCP calls or catalog rounds", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "june-backup-mcp-"));
  const connections = new McpConnections({
    directory,
    key: randomBytes(32),
    owner: "owner",
    origin: "https://june.example",
  });
  t.onTestFinished(async () => {
    await connections.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const catalogFirst of [false, true]) {
    for (const competing of [
      { mcp: { connection: "tool", tool: "run", argumentsJson: "{}" } },
      { mcpCatalog: { connection: null, tool: null, offset: 0 } },
    ]) {
      let calls = 0;
      const model = connections.wrap({
        async reply() {
          calls++;
          if (catalogFirst && calls === 1)
            return {
              text: "",
              mcpCatalog: { connection: null, tool: null, offset: 0 },
            };
          return { text: "", memoryBackup: true, ...competing };
        },
      });
      await expect(
        model.reply({
          system: "Back up the ledger",
          messages: [],
          workspaces: [],
          inspectionAvailable: true,
          mcpAvailable: true,
        }),
      ).rejects.toThrow("invalid_response");
      expect(calls).toBe(catalogFirst ? 2 : 1);
    }
  }
  expect(connections.proposals()).toEqual([]);
});
