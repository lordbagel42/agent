// A real Rivet host with only external side effects replaced. Launched solely by
// recovery.test.ts; no credentials, network model calls, messages, or Amp runs.
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createWorktreeManager } from "../src/coding/worktree.js";
import { slackSource } from "../src/imports/identity.js";
import { EvidenceStore } from "../src/memory/store.js";
import { createJevObserver } from "../src/models/jev.js";
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
  runtimeKind: "amp",
  runtimeId: "fixture-runtime-v1",
  workspaces: { june: repositoryRoot },
  isolation: { june: createWorktreeManager({ repositoryRoot, worktreeRoot }) },
  timeoutMs: 60_000,
  runtime: {
    async run(input) {
      if (process.env.FIXTURE_CODING_BOUNDARY !== "before-session")
        await input.onThread("T-fixture-saved");
      process.send?.({ kind: "coding" });
      return new Promise<never>(() => {});
    },
  },
};

const registry = createJuneRegistry({
  ...(process.env.FIXTURE_ACTIVITY
    ? {
        sessions: { idleMs: 1000 },
        memory: {
          store: new EvidenceStore(
            join(storage, "activity-memory.db"),
            Buffer.alloc(32, 1),
          ),
          source: (
            event: import("../src/core/contracts.js").MessageEvent,
            audience: string,
          ) =>
            slackSource({
              audiences: [audience],
              workspace: "T1",
              channel: "D1",
              ts: event.messageId,
              author: "U1",
              text: event.text,
              workspaceUrl: "https://example.slack.com/",
            }),
        },
      }
    : {}),
  owner: {
    id: "fixture",
    identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
  },
  model: {
    ...(process.env.FIXTURE_ACTIVITY
      ? {
          beginReply: () => {
            process.send?.({ kind: "activity-model" });
            return {
              answer: Promise.resolve({ text: "Activity reply" }),
              settlement: Promise.resolve("confirmed_stopped" as const),
            };
          },
        }
      : {}),
    async reply(request) {
      if (request.system.includes("Coding completion")) {
        process.send?.({ kind: "coding-report", text: request.system });
        return { text: "" };
      }
      if (
        JSON.parse(request.messages.at(-1)?.content ?? "{}").text ===
        "Jev fixture"
      ) {
        process.send?.({ kind: "jev-model" });
        return { text: "", jevObservation: true };
      }
      if (
        JSON.parse(request.messages.at(-1)?.content ?? "{}").source?.eventId ===
        "Ev-crash"
      )
        return {
          text: "",
          messages: ["The heron is remembered.", "And a second thought."],
        };
      return { text: "The heron is remembered." };
    },
  },
  jev: {
    question: { type: "noul", instructions: "Observe fixture only." },
    observe: createJevObserver({
      endpoint: "https://example.invalid/jev",
      apiKey: "fake-key",
      model: "fixture",
      questions: {
        observation: { type: "noul", instructions: "Observe fixture only." },
      },
      async fetch() {
        process.send?.({ kind: "jev" });
        return new Promise<never>(() => {});
      },
    }),
  },
  execution:
    process.env.FIXTURE_EXECUTION === "disabled"
      ? undefined
      : {
          model: {
            async reply() {
              process.send?.({ kind: "execution" });
              return new Promise<never>(() => {});
            },
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
        const notification =
          message.content.type === "text" &&
          message.content.text.startsWith("Coding job crash-job:");
        process.send?.({
          kind: notification ? "notification" : "send",
          id: message.id,
        });
        if (
          (process.env.FIXTURE_PHASE === "interrupt" &&
            process.env.FIXTURE_ACTIVITY !== "ack") ||
          (notification &&
            process.env.FIXTURE_PHASE === "interrupt-notification")
        )
          await new Promise<never>(() => {});
        return { status: "sent", messageId: "fixture-outbound" };
      },
    },
  },
  coding,
  research: process.env.FIXTURE_RESEARCH
    ? {
        pollMs: 20,
        model: {
          async reply() {
            process.send?.({ kind: "research-batch" });
            return new Promise<never>(() => {});
          },
        },
      }
    : undefined,
});
// Pause after a real durable admission save, before queue publication. The next
// process must recover that input without relying on a repeated webhook.
const conversationConfig = registry.config.use.conversation.config;
if (!("createVars" in conversationConfig) || !conversationConfig.createVars)
  throw new Error("Missing conversation vars");
// One fixture begins with legacy state. Upgrading the host must not mint a
// creation-only lineage marker on wake, even when new turns subsequently finish.
if (
  process.env.FIXTURE_PHASE === "interrupt" &&
  process.env.FIXTURE_CODING_BOUNDARY === "before-session"
)
  delete conversationConfig.onCreate;
const createVars = conversationConfig.createVars;
conversationConfig.createVars = async (c, input) => {
  const vars = await createVars(c, input);
  return {
    ...vars,
    persist: async () => {
      await vars.persist();
      if (
        process.env.FIXTURE_ACTIVITY === "ack" &&
        process.env.FIXTURE_PHASE === "interrupt" &&
        Object.values(c.state.sessions?.directory.receipts ?? {}).some(
          (receipt) => receipt.status === "settled",
        )
      ) {
        process.send?.({ kind: "activity-ack" });
        await new Promise<never>(() => {});
      }
      if (
        process.env.FIXTURE_PHASE === "interrupt" &&
        (Object.values(c.state.pendingInputs ?? {}).some(
          (event) => event.id === "Ev-admission",
        ) ||
          Object.values(c.state.pendingNotifications ?? {}).some(
            (input) => input.source.id === "Ev-admission",
          ))
      ) {
        process.send?.({ kind: "admission" });
        await new Promise<never>(() => {});
      }
    },
  };
};
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
