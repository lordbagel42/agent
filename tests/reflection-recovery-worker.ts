// Disposable crash fixture; only reflection-recovery.test.ts starts this host.
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { EvidenceStore } from "../src/memory/store.js";
import { createJuneRegistry } from "../src/runtime/registry.js";

if (!process.env.RIVETKIT_STORAGE_PATH) throw new Error("Missing test storage");
const scope = JSON.stringify(["private", "fixture"]);
// Both ledger and actor storage survive the host; this key is fixture-only.
const store = new EvidenceStore(
  join(process.env.RIVETKIT_STORAGE_PATH, "memory.sqlite"),
  Buffer.alloc(32, 7),
);
store.appendSource({
  id: "evidence",
  audiences: [scope],
  platform: "slack",
  account: "T1",
  conversation: "D1",
  author: "U1",
  observedAt: Number(process.env.OBSERVED_AT),
  sourceUrl: "https://example.com/fixture",
  text: "Original fixture observation",
});
const registry = createJuneRegistry({
  owner: {
    id: "fixture",
    identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
  },
  memory: {
    store,
    source: (event, audience) => ({
      id: event.id,
      audiences: [audience],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      observedAt: event.occurredAt,
      sourceUrl: "https://example.com/fixture",
      text: event.text,
    }),
  },
  reflection: {
    ownerId: "fixture",
    policy: {
      totalCapacity: 2,
      liveReserve: 1,
      cooldownMs: 0,
      maxAttempts: 1,
      maxNoNewEvidence: 1,
      evidenceMaxAgeMs: 300000,
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
          300000,
        ),
      ) === JSON.stringify(evidence),
    async retrieve(input) {
      return {
        authorized: input.scope === scope,
        evidence: store.reflectionEvidence(
          input.scope,
          input.evidenceIds,
          300000,
        ),
      };
    },
    async decide() {
      return {
        answer: "yes",
        rationale: "CRASH PRIVATE HYPOTHESIS",
        evidenceIds: ["evidence"],
        confidence: 0.7,
      };
    },
  },
  model: {
    async reply(request) {
      process.send?.({ kind: "model", stage: request.usageStage });
      if (request.usageStage === "synthesis")
        return { text: "CRASH PRIVATE SYNTHESIS" };
      const id = request.messages
        .findLast((m) => m.role === "user")
        ?.content.match(/[a-f0-9]{64}/)?.[0];
      if (!id) throw new Error("Missing fixture alias");
      return { text: "", reflectionReview: { action: "inspect", id } };
    },
  },
  channels: {
    slack: {
      channel: "slack",
      capabilities: { text: true, threads: true, reactions: true },
      async receive() {
        return { response: new Response(), events: [] };
      },
      async send(message) {
        process.send?.({ kind: "send", id: message.id });
        if (
          process.env.FIXTURE_PHASE === "interrupt" &&
          process.env.INTERRUPT_AT === "send"
        )
          await new Promise<never>(() => {});
        return { status: "sent", messageId: "fixture-output" };
      },
    },
  },
});
if (
  process.env.FIXTURE_PHASE === "interrupt" &&
  process.env.INTERRUPT_AT === "settled"
) {
  const config = registry.config.use.conversation.config;
  if (!("createVars" in config)) throw new Error("Missing fixture vars");
  const createVars = config.createVars;
  config.createVars = async (c, driver) => {
    const vars = await createVars(c, driver);
    return {
      ...vars,
      async persist() {
        await vars.persist();
        if (
          Object.entries(c.state.modelInvocations ?? {}).some(
            ([key, value]) =>
              key.includes('"reflection-review"') && value === "settled",
          )
        ) {
          // Raw inference settled, durable marker saved, callback not returned.
          process.send?.({ kind: "settled" });
          await new Promise<never>(() => {});
        }
      },
    };
  };
}
Object.assign(registry.config, {
  startEngine: true,
  startServices: false,
  engineHost: "127.0.0.1",
  namespace: "default",
  token: "default",
  noWelcome: true,
});
registry.start();
while (!(await registry.routes.health()).ok) await setTimeout(50);
process.send?.({ kind: "ready" });
