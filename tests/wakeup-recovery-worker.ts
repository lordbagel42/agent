// Disposable hard-crash fixture. Only the parent test starts this host.
import { setTimeout } from "node:timers/promises";
import { createJuneRegistry } from "../src/runtime/registry.js";

if (!process.env.RIVETKIT_STORAGE_PATH) throw new Error("Missing test storage");
const registry = createJuneRegistry({
  owner: {
    id: "fixture",
    identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
  },
  wakeups: { sources: ["webhook.fixture"], pollMs: 250 },
  model: {
    async reply() {
      process.send?.({ kind: "model" });
      return { text: "Scheduled notification." };
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
        return { status: "sent", messageId: "recovered" };
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
    let interrupted = false;
    return {
      ...vars,
      async persist() {
        await vars.persist();
        if (
          !interrupted &&
          Object.values(c.state.modelInvocations ?? {}).includes("settled")
        ) {
          interrupted = true;
          // State is saved, but the model step callback has not returned.
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
