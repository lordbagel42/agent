import { randomUUID } from "node:crypto";
import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type { MessageEvent } from "../core/contracts.js";
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
}

/** Only authenticated live ingress may set eligibility. Quoted instructions,
 * model output, history imports and callbacks cannot invoke these controls. */
export function sessionCommand(event: MessageEvent) {
  if (event.address.channel !== "slack" || !event.sessionCommandEligible)
    return;
  if (event.text === "CLEARHISTORY") return { kind: "clear" as const };
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

export async function publishSessionCommand(
  receipt: SessionCommandReceipt,
  deps: Dependencies,
  persist: () => Promise<void>,
  publish: (snapshot: DebugSnapshot) => Promise<void>,
) {
  if (receipt.snapshot && !receipt.published) {
    await publish(receipt.snapshot);
    receipt.published = true;
    await persist();
  }
  await deliver(
    receipt.delivery,
    persist,
    async (message) =>
      deps.channels[message.address.channel]?.send(message) ?? {
        status: "rejected",
        code: "channel_disabled",
        retryable: false,
      },
  );
}
