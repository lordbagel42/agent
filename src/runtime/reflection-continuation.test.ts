import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "rivetkit/client";
import { createClient } from "rivetkit/client";
import { expect, it } from "vitest";
import { freeEnginePort, stopTestEngine } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createJuneRegistry, type JuneClientRegistry } from "./registry.js";
import { createRivetReader } from "./rivet-inspection.js";

it("admits only exact exclusive reflection reads through the model schema", () => {
  const capabilities = { reflectionReviewAvailable: true };
  const id = "e1".repeat(32);
  for (const reflectionReview of [
    { action: "list" },
    { action: "inspect", id },
  ]) {
    const value = { text: "", reflectionReview };
    expect(parseReply(JSON.stringify(value), [], capabilities)).toEqual(value);
    expect(() => parseReply(JSON.stringify(value), [], {})).toThrow();
  }
  expect(JSON.stringify(replyJsonSchema([], capabilities))).toContain(
    "reflectionReview",
  );
  expect(JSON.stringify(replyJsonSchema([], {}))).not.toContain(
    "reflectionReview",
  );
  for (const value of [
    { text: "", reflectionReview: { action: "inspect", id: id.slice(1) } },
    { text: "", reflectionReview: { action: "list", id } },
    { text: "", reflectionReview: { action: "reject", id } },
    { text: "mixed", reflectionReview: { action: "list" } },
    { text: "", reflectionReview: { action: "list" }, reaction: "eyes" },
    { text: "", reflectionReview: { action: "list" }, search: "private" },
  ])
    expect(() =>
      parseReply(JSON.stringify(value), [], {
        ...capabilities,
        searchAvailable: true,
      }),
    ).toThrow();
});

it("feeds retained hypotheses to a bounded effect-free model continuation without retaining its private result", async (t) => {
  const owner = {
    id: "owner",
    identities: [{ channel: "slack" as const, accountId: "T", senderId: "U" }],
  };
  const scope = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  for (const id of ["source-a", "uncited-b"])
    store.appendSource({
      id,
      audiences: [scope],
      platform: "slack",
      account: "T",
      conversation: "D",
      author: "U",
      observedAt: Date.now(),
      sourceUrl: "https://example.com/fixture",
      text: `Original evidence ${id}`,
    });
  const hypothesis =
    "DISTINCTIVE PRIVATE HYPOTHESIS about asymmetric priorities";
  const synthesis =
    "PRIVATE SYNTHESIS: this is a tentative interpretation, not observed evidence.";
  const requests: ModelRequest[] = [];
  const sent: OutboundMessage[] = [];
  let alias = "";
  let extractions = 0;
  let attack: CompanionReply | undefined;
  let revoke: (() => void) | undefined;
  let beforeRetry: (() => Promise<void>) | undefined;
  let placement = false;
  const registry = createJuneRegistry({
    owner,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          if (beforeRetry) {
            const invalidate = beforeRetry;
            beforeRetry = undefined;
            await invalidate();
            return {
              status: "rejected",
              code: "fixture_retry",
              retryable: true,
            };
          }
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
    model: {
      async reply(request, signal, isCurrent) {
        requests.push(request);
        expect(signal?.aborted).toBe(false);
        expect(isCurrent?.()).toBe(true);
        if (requests.length === 1) return { text: "ordinary reply" };
        if (requests.length > 4) {
          if (request.usageStage !== "synthesis")
            return {
              text: "",
              replyInThread: placement,
              reflectionReview: { action: "inspect", id: alias },
            };
          revoke?.();
          return attack ?? { text: synthesis };
        }
        if (requests.length === 2)
          return {
            text: "",
            replyInThread: false,
            reflectionReview: { action: "list" as const },
          };
        if (requests.length === 3)
          return {
            text: "",
            reflectionReview: { action: "inspect" as const, id: alias },
          };
        return { text: synthesis };
      },
    },
    memory: {
      store,
      source: (event, audience) => ({
        id: event.id,
        audiences: [audience],
        platform: "slack",
        account: "T",
        conversation: "D",
        author: "U",
        observedAt: event.occurredAt,
        sourceUrl: "https://example.com/fixture",
        text: event.text,
      }),
      async extract() {
        extractions++;
      },
    },
    reflection: {
      ownerId: owner.id,
      policy: {
        totalCapacity: 2,
        liveReserve: 1,
        cooldownMs: 0,
        maxAttempts: 1,
        maxNoNewEvidence: 1,
        evidenceMaxAgeMs: 60000,
        quiet: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
      },
      idleMs: 86400000,
      deepMs: 86400000,
      pollMs: 20,
      timeoutMs: 10000,
      evidenceCurrent: (audience, evidence) =>
        audience === scope &&
        JSON.stringify(
          store.reflectionEvidence(
            audience,
            evidence.map((e) => e.id),
            60000,
          ),
        ) === JSON.stringify(evidence),
      async retrieve(input) {
        return {
          authorized: input.scope === scope,
          evidence: store.reflectionEvidence(
            input.scope,
            input.evidenceIds,
            60000,
          ),
        };
      },
      async decide() {
        return {
          answer: "yes",
          rationale: hypothesis,
          evidenceIds: ["source-a"],
          confidence: 0.7,
        };
      },
    },
  });
  // Use normal inspector authentication to inspect the complete workflow journal,
  // not only the sanitized conversation snapshot.
  const directory = await mkdtemp(join(tmpdir(), "june-reflection-review-"));
  const previousStorage = process.env.RIVETKIT_STORAGE_PATH;
  process.env.RIVETKIT_STORAGE_PATH = directory;
  const port = await freeEnginePort();
  Object.assign(registry.config, {
    namespace: "default",
    token: "default",
    enginePort: port,
    engineHost: "127.0.0.1",
    startEngine: true,
    startServices: false,
    noWelcome: true,
    shutdown: { disableSignalHandlers: true },
    envoy: { poolName: "default" },
    test: { enabled: false },
  });
  const client = createClient<JuneClientRegistry>({
    endpoint: `http://127.0.0.1:${port}`,
    namespace: "default",
    token: "default",
  });
  t.onTestFinished(async () => {
    await client.dispose();
    await registry.shutdown();
    await stopTestEngine(directory, port);
    await rm(directory, { recursive: true, force: true });
    if (previousStorage === undefined) delete process.env.RIVETKIT_STORAGE_PATH;
    else process.env.RIVETKIT_STORAGE_PATH = previousStorage;
  });
  registry.start();
  await expect
    .poll(async () => (await registry.routes.health()).ok, { timeout: 10000 })
    .toBe(true);
  const reflection = (
    client as Client<JuneClientRegistry>
  ).reflection.getOrCreate([owner.id]);
  const request = await reflection.enqueue({
    scope,
    evidenceIds: ["source-a", "uncited-b"],
    mode: "interaction",
    kind: "reflection",
  });
  const rawId = JSON.stringify([request.id, 1]);
  alias = createHash("sha256").update(rawId).digest("hex");
  await expect
    .poll(async () => (await reflection.status()).candidateIds, {
      timeout: 5000,
    })
    .toContain(rawId);
  const actor = client.conversation.getOrCreate(["private", owner.id]);
  let sequence = 0;
  let latestEvent: MessageEvent | undefined;
  const turn = async (text: string) => {
    const event: MessageEvent = {
      id: `turn-${++sequence}`,
      type: "message",
      messageId: `${sequence}.000000`,
      address: { channel: "slack", accountId: "T", conversationId: "D" },
      direct: true,
      senderId: "U",
      text,
      occurredAt: Date.now(),
      metadata: { channelType: "im" },
    };
    latestEvent = event;
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).filter(
            (record) => record.done,
          ).length,
        {
          timeout: 5000,
        },
      )
      .toBe(sequence);
  };
  await turn("hello");
  expect(extractions).toBe(1);
  await turn("Please inspect one reflection and explain it");
  expect(requests).toHaveLength(4);
  expect(requests[1]?.reflectionReviewAvailable).toBe(true);
  expect(JSON.stringify(requests[2])).toContain(alias);
  expect(JSON.stringify(requests[2])).not.toContain(hypothesis);
  expect(JSON.stringify(requests[3])).toContain(hypothesis);
  expect(JSON.stringify(requests[3])).toContain("uncited-b");
  for (const continuation of requests.slice(2)) {
    expect(continuation.workspaces).toEqual([]);
    expect(continuation.mcpAvailable).toBe(false);
    expect(
      Object.entries(continuation).filter(
        ([name, value]) =>
          name.endsWith("Available") &&
          name !== "reflectionReviewAvailable" &&
          value === true,
      ),
    ).toEqual([]);
  }
  expect(requests[3]?.reflectionReviewAvailable).not.toBe(true);
  expect(sent.at(-1)?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining(synthesis),
  });
  const snapshot = JSON.stringify(await actor.snapshot());
  expect(snapshot).not.toContain(hypothesis);
  expect(snapshot).not.toContain(synthesis);
  expect(extractions).toBe(1);
  expect(await reflection.candidate(alias, scope)).toBeNull();
  expect(store.proposals(scope)).toEqual([]);
  expect(sent.at(-1)?.address.threadId).toBeUndefined();
  placement = true;
  await turn("Explain that hypothesis in a thread");
  expect(sent.at(-1)?.address.threadId).toBe(`${sequence}.000000`);
  expect(sent.at(-1)?.content).toMatchObject({
    text: expect.stringContaining(synthesis),
  });

  // Unknown future staging fields must be refused even by custom providers.
  for (const injected of [
    { reflectionMemory: { id: alias, subjectSourceId: "source-a" } },
    {
      reflectionPersonalitySuggestion: {
        candidateId: alias,
        expectedVersion: 0,
        changes: { tone: "warm" },
      },
    },
    { reflectionInterruption: { id: alias } },
    { reaction: "eyes" },
    { search: "private hypothesis" },
    { personalitySuggestion: { rationale: hypothesis } },
    { reflectionReview: { action: "list" } },
  ]) {
    attack = { text: synthesis, ...injected } as CompanionReply;
    const before = sent.length;
    await turn("Review the same hypothesis");
    expect(
      sent
        .slice(before)
        .some((message) => JSON.stringify(message).includes(synthesis)),
    ).toBe(false);
    expect(store.proposals(scope)).toEqual([]);
  }
  attack = undefined;
  revoke = () => store.deleteSource("uncited-b");
  const before = sent.length;
  await turn("Explain the hypothesis once more");
  expect(
    sent
      .slice(before)
      .some((message) => JSON.stringify(message).includes(synthesis)),
  ).toBe(false);
  expect(await reflection.inspectCandidate(scope, alias)).toBeNull();
  expect(extractions).toBe(1);

  // A new publication distinguishes send-time rejection from synthesis-time
  // deletion. A transport rejection does not authorize a stale retry.
  revoke = undefined;
  store.appendSource({
    id: "fresh-c",
    audiences: [scope],
    platform: "slack",
    account: "T",
    conversation: "D",
    author: "U",
    observedAt: Date.now(),
    sourceUrl: "https://example.com/fixture",
    text: "New independent observation",
  });
  const second = await reflection.enqueue({
    scope,
    evidenceIds: ["source-a", "fresh-c"],
    mode: "interaction",
    kind: "reflection",
  });
  const secondId = JSON.stringify([second.id, 1]);
  alias = createHash("sha256").update(secondId).digest("hex");
  await expect
    .poll(async () => (await reflection.status()).candidateIds)
    .toContain(secondId);
  beforeRetry = async () => {
    await reflection.rejectCandidate(scope, alias);
  };
  const beforeRetriedSend = sent.length;
  const beforeRetriedCalls = requests.length;
  await turn("Review the new hypothesis");
  expect(sent).toHaveLength(beforeRetriedSend + 1);
  expect(requests).toHaveLength(beforeRetriedCalls + 2);
  // Durable backoff replays the callback without its transient answer. It must
  // neither regenerate that answer nor send it again after revocation.
  expect(
    Object.values((await actor.snapshot()).deliveries).find(
      (delivery) => delivery.message.id === sent.at(-1)?.id,
    )?.result,
  ).toMatchObject({
    status: "unknown",
    code: "review_not_retained",
  });

  const runtime = registry.parseConfig();
  let journal = "";
  const read = createRivetReader({
    owner,
    connection: () => ({
      endpoint: runtime.endpoint as string,
      namespace: runtime.namespace,
      token: runtime.token,
      pool: runtime.envoy.poolName,
    }),
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname.endsWith("/workflow-history")) {
        expect(response.ok).toBe(true);
        journal = await response.clone().text();
      }
      return response;
    },
  });
  if (!latestEvent) throw new Error("Missing completed fixture turn");
  await read(
    latestEvent,
    {
      target: "workflow-history",
      actorId: await actor.resolve(),
      name: null,
      table: null,
      cursor: null,
      pointer: "",
      offset: 0,
      page: 0,
      format: "raw",
    },
    new AbortController().signal,
  );
  expect(journal).toContain("reflection-review-continuation");
  expect(journal).not.toContain(hypothesis);
  expect(journal).not.toContain(synthesis);
});
