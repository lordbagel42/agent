// A real Rivet host with only external side effects replaced. Launched solely by
// recovery.test.ts; no credentials, network model calls, messages, or Amp runs.
import { setTimeout } from "node:timers/promises";
import { createJuneRegistry } from "../src/runtime/registry.js";

const registry = createJuneRegistry({
  owner: {
    id: "fixture",
    identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
  },
  model: {
    async reply() {
      return { text: "The heron is remembered." };
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
        if (message.address.conversationId === "C-backoff") {
          process.send?.({ kind: "backoff", id: message.id });
          return process.env.FIXTURE_PHASE === "interrupt"
            ? {
                status: "rejected",
                code: "rate_limited",
                retryable: true,
                retryAfterMs: 2000,
              }
            : { status: "sent", messageId: "fixture-after-backoff" };
        }
        process.send?.({ kind: "send", id: message.id });
        if (process.env.FIXTURE_PHASE === "interrupt")
          await new Promise<never>(() => {});
        return { status: "sent", messageId: "fixture-outbound" };
      },
    },
  },
  coding: {
    workspaces: { june: "/unused" },
    timeoutMs: 60_000,
    runtime: {
      async run(input) {
        await input.onThread("T-fixture-saved");
        process.send?.({ kind: "coding" });
        return new Promise<never>(() => {});
      },
    },
  },
});
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
