import { randomUUID } from "node:crypto";
import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type { MessageEvent, ModelSettlement } from "../core/contracts.js";
import { beginModelReply } from "../models/invocation.js";
import { type Delivery, deliver } from "./delivery.js";
import { conversationInputId } from "./inbox.js";
import type { ConversationState, Dependencies } from "./registry.js";

export interface DebugSnapshot {
  id: string;
  sessionId: string;
  capturedAt: string;
  revision: string;
  scope: string[];
  reason: string;
  data: unknown;
  exclusions: string[];
}

export interface DebugInvestigator {
  run(
    snapshot: DebugSnapshot,
    signal: AbortSignal,
    onThread: (id: string) => Promise<void>,
  ): Promise<{ threadId: string; report: string }>;
}

export interface SessionCommandReceipt {
  snapshot?: DebugSnapshot;
  delivery: Delivery;
  published?: boolean;
  ping?: {
    receivedAt: number;
    messageAt?: number;
    model?: "ready" | "started" | "completed" | "failed" | "unknown";
    modelMs?: number;
    timing?: Delivery;
  };
}

/** Only authenticated live ingress may set eligibility. Quoted instructions,
 * model output, history imports and callbacks cannot invoke these controls. */
export function sessionCommand(event: MessageEvent) {
  if (event.address.channel !== "slack" || !event.sessionCommandEligible)
    return;
  if (event.text === "CLEARHISTORY") return { kind: "clear" as const };
  if (event.text === "PING" || event.text === "PINGMODEL")
    return { kind: "ping" as const, model: event.text === "PINGMODEL" };
  const match = /^DEBUGSHARE(?: ([^\r\n]*))?$/.exec(event.text);
  if (match) return { kind: "debug" as const, reason: match[1] ?? "" };
}

/** Do not export arbitrary actor/config state. This second layer removes common
 * credential forms in owner-provided text; it is not a claim of perfect DLP. */
export function redactDebug(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) => {
      if (
        /^(authorization|cookie|password|secret|apiKey|accessToken|refreshToken)$/i.test(
          key,
        )
      )
        return "[redacted]";
      if (typeof item !== "string") return item;
      return item
        .replace(
          /\b(?:sk-[\w-]{12,}|xox[baprs]-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b/g,
          "[redacted]",
        )
        .replace(/\bBearer\s+[^\s"\\]+/gi, "Bearer [redacted]")
        .replace(/(https?:\/\/[^\s"<>]+)[?][^\s"<>]+/g, "$1?[redacted]");
    }),
  );
}

export function captureDebug(
  state: ConversationState,
  scope: string[],
  reason: string,
  revision?: string,
  modelRequest?: unknown,
): DebugSnapshot {
  state.session ??= { id: randomUUID(), startedAt: 0 };
  const session = state.session;
  const excluded = new Set(
    [
      ...Object.entries(state.events)
        // A notification retains its originating message, but has a distinct
        // host input identity. This also covers pre-upgrade compacted receipts.
        .filter(
          ([id, record]) =>
            record.decision ||
            id !== conversationInputId({ type: "event", event: record.event }),
        )
        .map(([id]) => id),
      ...Object.keys(state.pendingNotifications ?? {}),
      ...state.history
        .filter((entry) => entry.content.startsWith("[Automated wakeup;"))
        .map((entry) => entry.id),
    ].filter((id) => !state.clearedInputs?.[id]),
  );
  const ids = new Set(
    [
      ...Object.keys(state.events),
      ...Object.keys(state.pendingInputs ?? {}),
      ...Object.keys(state.pendingNotifications ?? {}),
    ].filter(
      (id) =>
        !state.clearedInputs?.[id] &&
        !state.events[id]?.decision &&
        !excluded.has(id),
    ),
  );
  return {
    id: randomUUID(),
    sessionId: session.id,
    capturedAt: new Date().toISOString(),
    revision: revision ?? "unknown",
    scope: [...scope],
    reason: String(redactDebug(reason)),
    data: redactDebug({
      history: state.history.filter(
        (entry) =>
          ids.has(entry.id) ||
          (entry.id.endsWith(":reply") && ids.has(entry.id.slice(0, -6))),
      ),
      events: Object.fromEntries(
        Object.entries(state.events).filter(([id]) => ids.has(id)),
      ),
      pending: Object.fromEntries(
        Object.entries(state.pendingInputs ?? {}).filter(([id]) => ids.has(id)),
      ),
      deliveries: Object.fromEntries(
        Object.entries(state.deliveries).filter(
          ([id, delivery]) =>
            !delivery.ephemeral &&
            [...ids].some((eventId) => id.startsWith(`${eventId}:`)),
        ),
      ),
      modelRequest: excluded.size ? undefined : modelRequest,
      modelInvocations: Object.fromEntries(
        Object.entries(state.modelInvocations ?? {}).filter(([id]) =>
          [...ids].some((eventId) => id.includes(eventId)),
        ),
      ),
      webInvocations: Object.fromEntries(
        Object.entries(state.webInvocations ?? {}).filter(([id]) =>
          [...ids].some((eventId) => id.includes(eventId)),
        ),
      ),
      activitySessionId: state.sessions?.directory.activeSessionId,
    }),
    exclusions: [
      "Credentials and configuration are not collected; recognizable tokens and URL query strings are redacted.",
      "Volatile tool results, unrelated conversations, process environment and raw service logs are not collected.",
      "Historical model requests before this feature and provider-internal state are unavailable.",
    ],
  };
}

export function resetConversation(state: ConversationState, at: number) {
  state.clearedInputs ??= {};
  for (const id of new Set([
    ...Object.keys(state.events),
    ...Object.keys(state.pendingInputs ?? {}),
    ...Object.keys(state.pendingNotifications ?? {}),
    ...Object.keys(state.ingress?.receipts ?? {}),
  ]))
    state.clearedInputs[id] = true;
  state.session = { id: randomUUID(), startedAt: at };
  // Events, deliveries, model settlement markers and memory archives remain.
  // Revocation is not proof that an already-running external effect stopped.
  state.history = [];
  const directory = state.sessions?.directory;
  if (directory) {
    const active =
      directory.activeSessionId &&
      directory.sessions[directory.activeSessionId];
    if (active) active.status = "sealed";
    delete directory.activeSessionId;
    delete directory.inFlight;
    directory.pending = [];
  }
}

export function createDebugShareActor(deps: Pick<Dependencies, "debugShare">) {
  return actor({
    state: {} as {
      snapshot?: DebugSnapshot;
      status?: "queued" | "running" | "completed" | "unavailable" | "unknown";
      threadId?: string;
      report?: string;
    },
    createVars: (c) => ({ persist: () => c.saveState({ immediate: true }) }),
    queues: { work: queue<{ start: true }>() },
    onWake: async (c) => {
      if (c.state.status === "queued")
        await c.queue.send("work", { start: true });
    },
    actions: {
      start: async (c, snapshot: DebugSnapshot) => {
        if (c.key[0] !== snapshot.id)
          throw new Error("Debug snapshot identity mismatch");
        if (!c.state.snapshot) {
          c.state.snapshot = snapshot;
          c.state.status = deps.debugShare ? "queued" : "unavailable";
          await c.saveState({ immediate: true });
        }
        if (c.state.status === "queued")
          await c.queue.send("work", { start: true });
      },
      inspect: (c) => ({
        id: c.state.snapshot?.id,
        sessionId: c.state.snapshot?.sessionId,
        capturedAt: c.state.snapshot?.capturedAt,
        status: c.state.status,
        threadId: c.state.threadId,
      }),
    },
    run: workflow(async (ctx) => {
      await ctx.loop("investigations", async (loop) => {
        await loop.queue.nextBatch("work", { names: ["work"], count: 1 });
        await loop.step({
          name: "investigate",
          timeout: 0,
          run: async (step) => {
            if (!step.state.snapshot || !deps.debugShare) return;
            // A restart after launch intent is uncertain, never an automatic second agent.
            if (step.state.status === "running") {
              step.state.status = "unknown";
              await step.vars.persist();
              return;
            }
            if (step.state.status !== "queued") return;
            step.state.status = "running";
            await step.vars.persist();
            try {
              const result = await deps.debugShare.run(
                JSON.parse(JSON.stringify(step.state.snapshot)),
                step.abortSignal,
                async (id) => {
                  step.state.threadId = id;
                  await step.vars.persist();
                },
              );
              step.state.threadId = result.threadId;
              step.state.report = String(redactDebug(result.report));
              step.state.status = "completed";
            } catch {
              step.state.status = "unknown";
            }
            await step.vars.persist();
          },
        });
      });
    }),
  });
}

export function createPingActor(deps: Dependencies) {
  return actor({
    state: {} as { receipt?: SessionCommandReceipt; done?: boolean },
    createVars: (c) => ({ persist: () => c.saveState({ immediate: true }) }),
    queues: { work: queue<{ start: true }>() },
    onWake: async (c) => {
      if (c.state.receipt && !c.state.done)
        await c.queue.send("work", { start: true });
    },
    actions: {
      start: async (c, receipt: SessionCommandReceipt) => {
        if (
          !receipt.ping ||
          receipt.snapshot ||
          c.key[0] !== receipt.delivery.message.id
        )
          throw new Error("Ping receipt identity mismatch");
        if (!c.state.receipt) {
          c.state.receipt = receipt;
          await c.vars.persist();
        }
        if (!c.state.done) await c.queue.send("work", { start: true });
      },
    },
    run: workflow(async (ctx) => {
      await ctx.loop("probes", async (loop) => {
        await loop.queue.nextBatch("work", { names: ["work"], count: 1 });
        await loop.step({
          name: "publish",
          timeout: 0,
          run: async (step) => {
            if (!step.state.receipt || step.state.done) return;
            await publishSessionCommand(
              step.state.receipt,
              deps,
              step.vars.persist,
              async () => {
                throw new Error("Ping cannot publish a debug snapshot");
              },
              step.abortSignal,
            );
            step.state.done = ![
              step.state.receipt.delivery,
              step.state.receipt.ping?.timing,
            ].some(
              (delivery) =>
                delivery?.result?.status === "rejected" &&
                delivery.result.retryable &&
                delivery.attempts < 3,
            );
            await step.vars.persist();
          },
        });
      });
    }),
  });
}

export async function publishSessionCommand(
  receipt: SessionCommandReceipt,
  deps: Dependencies,
  persist: () => Promise<void>,
  publish: (snapshot: DebugSnapshot) => Promise<void>,
  signal: AbortSignal,
) {
  const release = await deps.lifecycle?.enter(signal);
  let settlement: Promise<ModelSettlement> | undefined;
  try {
    if (receipt.snapshot && !receipt.published) {
      await publish(receipt.snapshot);
      receipt.published = true;
      await persist();
    }
    const ping = receipt.ping;
    if (ping?.model === "started") {
      // A recovered intent cannot prove whether the provider ran. Never replay it.
      ping.model = "unknown";
      await persist();
    }
    if (ping?.model === "ready") {
      ping.model = "started";
      await persist();
      signal.throwIfAborted();
      const started = performance.now();
      const invocation = beginModelReply(
        deps.model,
        {
          system:
            'This is a latency probe. Reply only with {"text":"PONG"}. Do not request tools or actions.',
          messages: [{ role: "user", content: "PING" }],
          workspaces: [],
        },
        signal,
        () => !signal.aborted,
        () => false,
      );
      settlement = invocation.settlement;
      try {
        await invocation.answer;
        ping.model = "completed";
      } catch {
        ping.model = "failed";
      }
      ping.modelMs = Math.round(performance.now() - started);
      await persist();
    }
    if (
      ping &&
      (ping.model === "failed" || ping.model === "unknown") &&
      receipt.delivery.phase === "ready"
    ) {
      receipt.delivery.message.content = {
        type: "text",
        text: `PINGMODEL ${ping.model === "failed" ? "failed" : "was interrupted; model outcome is unknown"}. No model retry was made.`,
      };
    }
    const send = (message: Delivery["message"]) =>
      deps.channels[message.address.channel]?.send(message) ??
      Promise.resolve({
        status: "rejected" as const,
        code: "channel_disabled",
        retryable: false,
      });
    const result = await deliver(receipt.delivery, persist, send);
    if (!ping || result.status !== "sent") return;
    if (!ping.timing) {
      const sentAt = receipt.delivery.outcomeObservedAt;
      if (sentAt === undefined) return;
      const outbound = receipt.delivery.message;
      ping.timing = {
        phase: "ready",
        attempts: 0,
        message: {
          ...outbound,
          id: randomUUID(),
          content: {
            type: "text",
            text: `${ping.model ? "PINGMODEL" : "PING"} timing: ${sentAt - ping.receivedAt} ms from verified ingress to reply accepted; ${ping.messageAt === undefined ? "unavailable" : `${Math.round(sentAt - ping.messageAt)} ms`} from Slack message timestamp.${ping.model ? ` Model: ${ping.modelMs === undefined ? "unavailable" : `${ping.modelMs} ms`} (${ping.model}).` : " No model call."} These are host observations, not client display latency.`,
          },
        },
      };
      await persist();
    }
    await deliver(ping.timing, persist, send);
  } finally {
    // PONG is already sent. Keep this workflow and its lease alive until the
    // native invocation retires; idle actor sleep must not interrupt retirement.
    if (settlement && (await settlement) === "unknown") deps.lifecycle?.fail();
    release?.();
  }
}
