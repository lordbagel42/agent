// A real Rivet host with only external side effects replaced. Launched solely by
// recovery.test.ts; no credentials, network model calls, messages, or Amp runs.
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createWorktreeManager } from "../src/coding/worktree.js";
import type { CodingDependencies } from "../src/runtime/coding.js";
import { createJuneRegistry } from "../src/runtime/registry.js";

// The parent owns this disposable directory and retains it across both hosts.
// Never use mkdtemp here: recovery must see the original worktree and lease.
const storage = process.env.RIVETKIT_STORAGE_PATH;
if (!storage) throw new Error("Missing recovery fixture storage");
const repositoryRoot = join(storage, "coding-repo");
const worktreeRoot = join(storage, "coding-worktrees");
if (process.env.FIXTURE_PHASE === "interrupt") {
  await mkdir(repositoryRoot);
  await mkdir(worktreeRoot);
  execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
}
const coding: CodingDependencies = {
  runtimeId: "fixture-runtime-v1",
  workspaces: { june: repositoryRoot },
  isolation: { june: createWorktreeManager({ repositoryRoot, worktreeRoot }) },
  timeoutMs: 60_000,
  runtime: {
    async run(input) {
      await input.onThread("T-fixture-saved");
      process.send?.({ kind: "coding" });
      return new Promise<never>(() => {});
    },
  },
};

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
  coding,
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
