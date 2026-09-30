import { createHash, randomUUID } from "node:crypto";
import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type { MessageEvent, ModelSettlement } from "../core/contracts.js";
import { beginModelReply } from "../models/invocation.js";
import {
  type CompressedJson,
  commandSnapshot,
  readHistory,
} from "./conversation-storage.js";
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
  /** Repeating run only submits/observes the same durable request, never relaunches. */
  resumeSafe?: boolean;
  inspect?(id: string): Promise<
    | {
        status: "queued" | "running" | "completed" | "unknown";
        threadId?: string;
      }
    | undefined
  >;
  run(
    snapshot: DebugSnapshot,
    signal: AbortSignal,
    onThread: (id: string) => Promise<void>,
  ): Promise<{ threadId: string; report: string }>;
}

export interface SessionCommandReceipt {
  snapshot?: DebugSnapshot;
  snapshotId?: string;
  snapshotCompressed?: CompressedJson;
  delivery: Delivery;
  published?: boolean;
  /** Only new requests opt in; do not notify historical DEBUGSHAREs on upgrade. */
  debugLink?: { pollAt?: number; delivery?: Delivery };
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
      ...readHistory(state)
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
      history: readHistory(state).filter(
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
  delete state.historyArchive;
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

// Base64 plus RPC framing stays below Rivet's 64 KiB incoming-message limit.
const DEBUG_CHUNK_BYTES = 32 * 1024;

export interface DebugSnapshotChunk {
  id: string;
  sha256: string;
  totalBytes: number;
  index: number;
  data: string;
}

export async function publishDebugSnapshot(
  snapshot: DebugSnapshot,
  send: (
    chunk: DebugSnapshotChunk,
  ) => Promise<{ nextIndex: number; complete: boolean }>,
) {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const count = Math.ceil(bytes.length / DEBUG_CHUNK_BYTES);
  for (let index = 0; index < count; ) {
    const result = await send({
      id: snapshot.id,
      sha256,
      totalBytes: bytes.length,
      index,
      data: bytes
        .subarray(index * DEBUG_CHUNK_BYTES, (index + 1) * DEBUG_CHUNK_BYTES)
        .toString("base64"),
    });
    if (
      !Number.isSafeInteger(result.nextIndex) ||
      result.nextIndex <= index ||
      result.nextIndex > count ||
      result.complete !== (result.nextIndex === count)
    )
      throw new Error("Invalid debug snapshot acknowledgment");
    if (result.complete) return;
    index = result.nextIndex;
  }
}

export function createDebugShareActor(deps: Pick<Dependencies, "debugShare">) {
  return actor({
    state: {} as {
      snapshot?: DebugSnapshot;
      upload?: { sha256: string; totalBytes: number; parts: string[] };
      status?: "queued" | "running" | "completed" | "unavailable" | "unknown";
      independentDispatch?: boolean;
      threadId?: string;
      report?: string;
    },
    createVars: (c) => ({
      persist: () => c.saveState({ immediate: true }),
      receiving: Promise.resolve(),
      finish: async (snapshot: DebugSnapshot) => {
        if (c.key[0] !== snapshot.id)
          throw new Error("Debug snapshot identity mismatch");
        const bytes = Buffer.from(JSON.stringify(snapshot));
        if (
          (c.state.snapshot &&
            JSON.stringify(c.state.snapshot) !== bytes.toString()) ||
          (c.state.upload &&
            (c.state.upload.totalBytes !== bytes.length ||
              c.state.upload.sha256 !==
                createHash("sha256").update(bytes).digest("hex")))
        )
          throw new Error("Debug snapshot conflict");
        if (!c.state.snapshot) {
          c.state.snapshot = snapshot;
          c.state.status = deps.debugShare ? "queued" : "unavailable";
        }
        delete c.state.upload;
        // Even a duplicate after a lost save acknowledgment needs a barrier.
        await c.saveState({ immediate: true });
        if (c.state.status === "queued")
          await c.queue.send("work", { start: true });
      },
    }),
    queues: { work: queue<{ start: true }>() },
    onWake: async (c) => {
      if (c.state.status === "queued")
        await c.queue.send("work", { start: true });
    },
    actions: {
      start: async (c, snapshot: DebugSnapshot) => {
        const receiving = c.vars.receiving.then(() => c.vars.finish(snapshot));
        c.vars.receiving = receiving.catch(() => {});
        await receiving;
      },
      startChunk: async (c, chunk: DebugSnapshotChunk) => {
        const receiving = c.vars.receiving.then(async () => {
          if (
            !chunk ||
            chunk.id !== c.key[0] ||
            typeof chunk.sha256 !== "string" ||
            !/^[0-9a-f]{64}$/.test(chunk.sha256) ||
            !Number.isSafeInteger(chunk.totalBytes) ||
            chunk.totalBytes <= 0 ||
            !Number.isSafeInteger(chunk.index) ||
            chunk.index < 0 ||
            chunk.index >= Math.ceil(chunk.totalBytes / DEBUG_CHUNK_BYTES) ||
            typeof chunk.data !== "string" ||
            chunk.data.length > 43692
          )
            throw new Error("Invalid debug snapshot chunk");
          const part = Buffer.from(chunk.data, "base64");
          if (
            part.toString("base64") !== chunk.data ||
            part.length !==
              Math.min(
                DEBUG_CHUNK_BYTES,
                chunk.totalBytes - chunk.index * DEBUG_CHUNK_BYTES,
              )
          )
            throw new Error("Invalid debug snapshot chunk");
          const count = Math.ceil(chunk.totalBytes / DEBUG_CHUNK_BYTES);
          if (c.state.snapshot) {
            const bytes = Buffer.from(JSON.stringify(c.state.snapshot));
            if (
              bytes.length !== chunk.totalBytes ||
              createHash("sha256").update(bytes).digest("hex") !==
                chunk.sha256 ||
              !bytes
                .subarray(
                  chunk.index * DEBUG_CHUNK_BYTES,
                  (chunk.index + 1) * DEBUG_CHUNK_BYTES,
                )
                .equals(part)
            )
              throw new Error("Debug snapshot conflict");
            await c.vars.finish(c.state.snapshot);
            return { nextIndex: count, complete: true };
          }
          const upload = c.state.upload ?? {
            sha256: chunk.sha256,
            totalBytes: chunk.totalBytes,
            parts: [],
          };
          if (
            upload.sha256 !== chunk.sha256 ||
            upload.totalBytes !== chunk.totalBytes ||
            chunk.index > upload.parts.length ||
            (chunk.index < upload.parts.length &&
              upload.parts[chunk.index] !== chunk.data)
          )
            throw new Error("Debug snapshot conflict");
          const parts =
            chunk.index === upload.parts.length
              ? [...upload.parts, chunk.data]
              : upload.parts;
          if (parts.length === count) {
            const bytes = Buffer.concat(
              parts.map((part) => Buffer.from(part, "base64")),
            );
            if (
              bytes.length !== upload.totalBytes ||
              createHash("sha256").update(bytes).digest("hex") !== upload.sha256
            )
              throw new Error("Debug snapshot digest mismatch");
            const snapshot = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            );
            await c.vars.finish(snapshot);
            return { nextIndex: count, complete: true };
          }
          c.state.upload = { ...upload, parts };
          await c.vars.persist();
          return { nextIndex: parts.length, complete: false };
        });
        c.vars.receiving = receiving.then(
          () => {},
          () => {},
        );
        return receiving;
      },
      inspect: async (c) => {
        const external =
          c.state.independentDispatch &&
          c.state.snapshot &&
          deps.debugShare?.inspect
            ? await deps.debugShare
                .inspect(c.state.snapshot.id)
                .catch(() => undefined)
            : undefined;
        return {
          id: c.state.snapshot?.id,
          sessionId: c.state.snapshot?.sessionId,
          capturedAt: c.state.snapshot?.capturedAt,
          status: external?.status ?? c.state.status,
          threadId: external?.threadId ?? c.state.threadId,
        };
      },
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
            if (
              step.state.status === "running" &&
              !(deps.debugShare.resumeSafe && step.state.independentDispatch)
            ) {
              step.state.status = "unknown";
              await step.vars.persist();
              return;
            }
            if (
              step.state.status !== "queued" &&
              step.state.status !== "running"
            )
              return;
            step.state.status = "running";
            step.state.independentDispatch =
              deps.debugShare.resumeSafe === true;
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
          receipt.snapshotCompressed ||
          receipt.snapshotId ||
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

export async function publishDebugLink(
  receipt: SessionCommandReceipt,
  threadId: string,
  deps: Dependencies,
  persist: () => Promise<void>,
) {
  const link = receipt.debugLink;
  if (!link) return;
  const previous = link.delivery;
  if (
    previous?.result?.status === "rejected" &&
    previous.result.retryable &&
    Date.now() <
      (previous.outcomeObservedAt ?? 0) + (previous.result.retryAfterMs ?? 0)
  )
    return;
  if (!link.delivery) {
    const outbound = receipt.delivery.message;
    const owner = deps.owner.identities.find(
      (identity) =>
        identity.channel === outbound.address.channel &&
        identity.accountId === outbound.address.accountId,
    );
    const mention =
      outbound.address.channel === "slack" && owner
        ? `<@${owner.senderId}> `
        : "";
    link.delivery = {
      phase: "ready",
      attempts: 0,
      message: {
        ...outbound,
        id: randomUUID(),
        content: {
          type: "text",
          text: `${mention}DEBUGSHARE ${receipt.snapshotId ?? receipt.snapshot?.id}\nAmp investigation: https://ampcode.com/threads/${encodeURIComponent(threadId)}`,
        },
      },
    };
    await persist();
  }
  const result = await deliver(
    link.delivery,
    persist,
    (message) =>
      deps.channels[message.address.channel]?.send(message) ??
      Promise.resolve({
        status: "rejected" as const,
        code: "channel_disabled",
        retryable: false,
      }),
  );
  if (
    result.status !== "rejected" ||
    !result.retryable ||
    link.delivery.attempts >= 3
  )
    delete link.pollAt;
  await persist();
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
    const snapshot = !receipt.published && commandSnapshot(receipt);
    if (snapshot) {
      await publish(snapshot);
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
