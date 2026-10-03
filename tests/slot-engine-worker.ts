import { once } from "node:events";
import { actor, setup } from "rivetkit";
import { startSlotEngine } from "../src/deployment/engine.js";
import { createLifecycle } from "../src/runtime/lifecycle.js";

const lifecycle = createLifecycle();
const registry = setup({
  use: {
    counter: actor({
      state: { value: 0 },
      actions: { add: (c, amount: number) => (c.state.value += amount) },
    }),
  },
  engineHost: "127.0.0.1",
  startServices: false,
  noWelcome: true,
  shutdown: { disableSignalHandlers: true },
});

process.once("SIGTERM", () => {
  void registry.shutdown().then(() => process.exit(0));
});

try {
  const endpoint = registry.parseConfig().endpoint;
  const storagePath = process.env.RIVETKIT_STORAGE_PATH;
  if (!endpoint || !storagePath) throw new Error("Fixture config required");
  await startSlotEngine({
    endpoint,
    storagePath,
    onFailure: lifecycle.fail,
  });
  if (process.env.FIXTURE_MODE === "handoff") {
    const register = once(process, "message");
    process.send?.({ kind: "prestarted" });
    await register;
  }
  await registry.startAndWait();
  process.send?.({ kind: "ready" });
} catch {
  lifecycle.fail();
  process.send?.({
    kind: lifecycle.tryEnter() ? "failed-open" : "failed-fenced",
  });
}
