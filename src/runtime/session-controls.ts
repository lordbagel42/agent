import { createHash, randomUUID } from "node:crypto";
import { actor, queue } from "rivetkit";
import { db } from "rivetkit/db";
import { workflow } from "rivetkit/workflow";
import type {
  Address,
  MessageEvent,
  ModelSettlement,
  SendResult,
} from "../core/contracts.js";
import { DEBUG_COMMAND } from "../core/routing.js";
import {
  type DebugSiteOutbox,
  publishDebugSite,
} from "../diagnostics/outbox.js";
import { beginModelReply } from "../models/invocation.js";
import {
  type CompressedJson,
  commandSnapshot,
  readDeliveries,
  readEvents,
  readHistory,
  readModelInvocations,
} from "./conversation-storage.js";
import {
  DEBUG_CHUNK_BYTES,
  DebugBodies,
  type DebugBodyRef,
  initializeDebugBodies,
} from "./debug-bodies.js";
import { type Delivery, deliver } from "./delivery.js";
import { conversationInputId } from "./inbox.js";
import type {
  ConversationState,
  Dependencies,
  MemoryReference,
} from "./registry.js";

export interface DebugSnapshot {
  id: string;
  sessionId: string;
  capturedAt: string;
  revision: string;
  scope: string[];
  reason: string;
  /** Set only by verified command ingress, never inferred from scope or text.
   * Missing on historical snapshots; absence does not attest owner authority. */
  reporter?: {
    channel: "slack";
    accountId: string;
    senderId: string;
    isOwner: boolean;
  };
  /** DEBUG is storage-only. Missing on historical DEBUGSHARE snapshots. */
  snapshotOnly?: boolean;
  data: unknown;
  exclusions: string[];
}

export interface DebugInvestigator {
  /** Repeating run only submits/observes the same durable request, never relaunches. */
  resumeSafe?: boolean;
  /** Privileged attestation after verification, independent of launch completion. */
  resolve?(id: string, current?: () => boolean): Promise<boolean>;
  inspect?(id: string): Promise<
    | {
        status: "queued" | "running" | "completed" | "unknown";
        threadId?: string;
        resolved?: true;
      }
    | undefined
  >;
  run(
    snapshot: DebugSnapshot,
    signal: AbortSignal,
    onThread: (id: string) => Promise<void>,
  ): Promise<{ threadId: string; report: string; resolved?: true }>;
}

export interface SessionCommandReceipt {
  snapshot?: DebugSnapshot;
  snapshotId?: string;
  snapshotCompressed?: CompressedJson;
  snapshotRef?: DebugBodyRef;
  delivery: Delivery;
  /** Private owner copy for reports originating outside the owner DM. */
  ownerDelivery?: Delivery;
  /** New DEBUGSHARE reports outside owner DMs only; send after explicit resolution. */
  debugResolution?: Delivery;
  published?: boolean;
  /** Durable notification polling; only new requests opt in, never backfill. */
  debugLink?: {
    pollAt?: number;
    /** Keep a slower poll after an unresolved investigator returns. */
    awaitingResolution?: boolean;
    address?: Address;
    delivery?: Delivery;
    /** New owner reports return only their link to the originating surface. */
    replyAtOrigin?: boolean;
    /** DEBUG only drains its owner copy, never reads an Amp receipt or sends a link. */
    ownerOnly?: boolean;
  };
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
  const match = DEBUG_COMMAND.exec(event.text);
  if (match)
    return {
      kind: "debug" as const,
      reason: match[2] ?? "",
      snapshotOnly: match[1] === "DEBUG",
    };
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
  captureTimings?: (events: MessageEvent[]) => unknown,
  retention?: {
    memory: NonNullable<Dependencies["memory"]>;
    current(reference: MemoryReference): boolean;
  },
): DebugSnapshot {
  state.session ??= { id: randomUUID(), startedAt: 0 };
  const session = state.session;
  const events = readEvents(state);
  const excluded = new Set(
    [
      ...Object.entries(events)
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
      ...Object.keys(events),
      ...Object.keys(state.pendingInputs ?? {}),
      ...Object.keys(state.pendingNotifications ?? {}),
    ].filter(
      (id) =>
        !state.clearedInputs?.[id] &&
        !events[id]?.decision &&
        !excluded.has(id),
    ),
  );
  const audience = JSON.stringify(scope);
  const deletionRevision = retention?.memory.store.deletionRevision() ?? 0;
  const retained = (reference: MemoryReference) =>
    retention?.current(reference) &&
    (deletionRevision === 0 ||
      reference.contextSourceIds?.every((id) =>
        retention.memory.store.sessionContextAvailable(audience, id),
      ) === true);
  for (const id of ids) {
    const event = events[id]?.event ?? state.pendingInputs?.[id];
    const reference = state.memoryContexts?.[id];
    const source =
      event?.type === "message"
        ? retention?.memory.source(event, audience)
        : undefined;
    if (
      state.forgottenEvents?.includes(id) ||
      (event?.type === "message" &&
        event.address.channel === "slack" &&
        event.text.startsWith("##")) ||
      (source && retention?.memory.store.isDeleted(source.id)) ||
      (retention && (reference ? !retained(reference) : deletionRevision > 0))
    ) {
      ids.delete(id);
      excluded.add(id);
    }
  }
  const history = readHistory(state).filter((entry) => {
    const included =
      ids.has(entry.id) ||
      (entry.id.endsWith(":reply") && ids.has(entry.id.slice(0, -6)));
    if (!included) return false;
    if (
      retention &&
      ((entry.sourceId &&
        !retention.memory.store.source(audience, entry.sourceId)) ||
        (entry.context ? !retained(entry.context) : deletionRevision > 0))
    ) {
      excluded.add(entry.id);
      return false;
    }
    return true;
  });
  return {
    id: randomUUID(),
    sessionId: session.id,
    capturedAt: new Date().toISOString(),
    revision: revision ?? "unknown",
    scope: [...scope],
    reason: String(redactDebug(reason)),
    data: redactDebug({
      history,
      events: Object.fromEntries(
        Object.entries(events).filter(([id]) => ids.has(id)),
      ),
      pending: Object.fromEntries(
        Object.entries(state.pendingInputs ?? {}).filter(([id]) => ids.has(id)),
      ),
      deliveries: Object.fromEntries(
        Object.entries(readDeliveries(state)).filter(
          ([id, delivery]) =>
            !delivery.ephemeral &&
            [...ids].some((eventId) => id.startsWith(`${eventId}:`)),
        ),
      ),
      modelRequest: excluded.size ? undefined : modelRequest,
      modelInvocations: Object.fromEntries(
        Object.entries(readModelInvocations(state) ?? {}).filter(([id]) =>
          [...ids].some((eventId) => id.includes(eventId)),
        ),
      ),
      webInvocations: Object.fromEntries(
        Object.entries(state.webInvocations ?? {}).filter(([id]) =>
          [...ids].some((eventId) => id.includes(eventId)),
        ),
      ),
      activitySessionId: state.sessions?.directory.activeSessionId,
      timings: captureTimings?.(
        [...ids].flatMap((id) => {
          const event = events[id]?.event ?? state.pendingInputs?.[id];
          return event?.type === "message" ? [event] : [];
        }),
      ),
    }),
    exclusions: [
      "Credentials and configuration are not collected; recognizable tokens and URL query strings are redacted.",
      "Volatile tool results, unrelated conversations, process environment and raw service logs are not collected.",
      "Historical model requests before this feature and provider-internal state are unavailable.",
      "Timing observations cover only exactly matched retained inputs still in this process's bounded live trace buffer; historical unjoinable logs are excluded.",
      "Fresh captures revalidate tombstones and provenance; stale or unprovably independent evidence and cached requests are omitted after deletion.",
    ],
  };
}

export function resetConversation(state: ConversationState, at: number) {
  state.clearedInputs ??= {};
  for (const id of new Set([
    ...Object.keys(readEvents(state)),
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

export function createDebugShareActor(
  deps: Pick<Dependencies, "debugShare" | "debugSite">,
) {
  return actor({
    db: db({ onMigrate: initializeDebugBodies }),
    state: {} as {
      snapshot?: DebugSnapshot;
      snapshotRef?: DebugBodyRef;
      upload?: {
        sha256: string;
        totalBytes: number;
        parts?: string[];
        nextIndex?: number;
      };
      status?:
        | "saved"
        | "queued"
        | "running"
        | "completed"
        | "unavailable"
        | "unknown";
      independentDispatch?: boolean;
      threadId?: string;
      report?: string;
      resolved?: true;
      resolutionNotification?: SendResult;
      website?: DebugSiteOutbox;
    },
    createVars: (c) => {
      const bodies = new DebugBodies(c.db);
      const remember = (ref: DebugBodyRef) => {
        c.state.snapshotRef = ref;
        if (!c.state.status) {
          c.state.status = ref.snapshotOnly
            ? "saved"
            : deps.debugShare
              ? "queued"
              : "unavailable";
          if (deps.debugSite)
            c.state.website = {
              url: deps.debugSite.url(ref.id),
              status: "pending",
              attempts: 0,
              retryAt: Date.now(),
            };
        }
      };
      return {
        bodies,
        remember,
        persist: () => c.saveState({ immediate: true }),
        receiving: Promise.resolve(),
        publishingSite: Promise.resolve(),
        finish: async (snapshot: DebugSnapshot) => {
          if (c.key[0] !== snapshot.id)
            throw new Error("Debug snapshot identity mismatch");
          const bytes = Buffer.from(JSON.stringify(snapshot));
          if (
            c.state.upload &&
            (c.state.upload.totalBytes !== bytes.length ||
              c.state.upload.sha256 !==
                createHash("sha256").update(bytes).digest("hex"))
          )
            throw new Error("Debug snapshot conflict");
          remember(await bodies.put("snapshot", snapshot));
          delete c.state.upload;
          // Even a duplicate after a lost save acknowledgment needs a barrier.
          await c.saveState({ immediate: true });
          if (c.state.website?.status === "pending" && deps.debugSite)
            await c.schedule.at(
              Math.max(Date.now(), c.state.website.retryAt ?? 0),
              "publishSite",
              c.state.website.retryAt ?? 0,
            );
          if (c.state.status === "queued")
            await c.queue.send("work", { start: true });
        },
      };
    },
    queues: { work: queue<{ start: true }>() },
    onWake: async (c) => {
      // Relocate legacy bodies before the native workflow's first checkpoint.
      // A manifest committed before an interrupted state ACK is also recoverable.
      const ref = c.state.snapshot
        ? await c.vars.bodies.put("snapshot", c.state.snapshot)
        : await c.vars.bodies.reference("snapshot");
      if (ref) {
        c.vars.remember(ref);
        delete c.state.snapshot;
        delete c.state.upload;
      } else if (c.state.upload?.parts) {
        const upload = c.state.upload;
        for (const [index, part] of (upload.parts ?? []).entries())
          await c.vars.bodies.writePart(upload.sha256, index, part);
        upload.nextIndex = upload.parts?.length ?? 0;
        delete upload.parts;
      }
      if (c.state.status === "queued")
        await c.queue.send("work", { start: true });
      if (c.state.website?.status === "pending" && deps.debugSite)
        await c.schedule.at(
          Math.max(Date.now(), c.state.website.retryAt ?? 0),
          "publishSite",
          c.state.website.retryAt ?? 0,
        );
    },
    actions: {
      publishSite: (c, at: number) => {
        // This independent lane cannot hold the capture ACK or the investigator.
        c.vars.publishingSite = c.vars.publishingSite
          .then(async () => {
            // Check inside the lane: wake repairs can duplicate durable timers,
            // but only the current generation may publish or schedule a successor.
            if (
              !c.state.snapshotRef ||
              !c.state.website ||
              !deps.debugSite ||
              c.state.website.status !== "pending" ||
              (c.state.website.retryAt ?? 0) !== at
            )
              return;
            try {
              await publishDebugSite(
                c.state.website,
                await c.vars.bodies.read(c.state.snapshotRef),
                deps.debugSite,
                c.vars.persist,
                Date.now(),
                c.state.status && c.state.status !== "saved"
                  ? {
                      phase:
                        c.state.status === "completed"
                          ? "returned"
                          : c.state.status,
                      threadId: c.state.threadId,
                    }
                  : undefined,
              );
            } catch {
              console.error("debug_site_publication_failed");
            }
            if (c.state.website.status === "pending")
              await c.schedule.at(
                Math.max(Date.now() + 1000, c.state.website.retryAt ?? 0),
                "publishSite",
                c.state.website.retryAt ?? 0,
              );
          })
          .catch(() => {
            console.error("debug_site_retry_schedule_failed");
          });
        void c.keepAwake(c.vars.publishingSite);
      },
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
          if (c.state.snapshotRef) {
            const ref = c.state.snapshotRef;
            if (
              ref.totalBytes !== chunk.totalBytes ||
              ref.sha256 !== chunk.sha256 ||
              (await c.vars.bodies.part(ref.sha256, chunk.index)) !== chunk.data
            )
              throw new Error("Debug snapshot conflict");
            await c.vars.finish(await c.vars.bodies.read(ref));
            return { nextIndex: count, complete: true };
          }
          const upload = c.state.upload ?? {
            sha256: chunk.sha256,
            totalBytes: chunk.totalBytes,
            nextIndex: 0,
          };
          const nextIndex = upload.nextIndex ?? 0;
          if (
            upload.sha256 !== chunk.sha256 ||
            upload.totalBytes !== chunk.totalBytes ||
            chunk.index > nextIndex
          )
            throw new Error("Debug snapshot conflict");
          await c.vars.bodies.writePart(chunk.sha256, chunk.index, chunk.data);
          const savedIndex = Math.max(nextIndex, chunk.index + 1);
          if (savedIndex === count) {
            const snapshot = await c.vars.bodies.read(upload);
            await c.vars.finish(snapshot);
            return { nextIndex: count, complete: true };
          }
          c.state.upload = { ...upload, nextIndex: savedIndex };
          await c.vars.persist();
          return { nextIndex: savedIndex, complete: false };
        });
        c.vars.receiving = receiving.then(
          () => {},
          () => {},
        );
        return receiving;
      },
      recordResolutionNotification: async (c, result: SendResult) => {
        c.state.resolutionNotification = result;
        await c.vars.persist();
      },
      inspect: async (c) => {
        const external =
          c.state.independentDispatch &&
          c.state.snapshotRef &&
          deps.debugShare?.inspect
            ? await deps.debugShare
                .inspect(c.state.snapshotRef.id)
                .catch(() => undefined)
            : undefined;
        return {
          id: c.state.snapshotRef?.id,
          sessionId: c.state.snapshotRef?.sessionId,
          capturedAt: c.state.snapshotRef?.capturedAt,
          status: external?.status ?? c.state.status,
          threadId: external?.threadId ?? c.state.threadId,
          resolved: external ? external.resolved : c.state.resolved,
          resolutionNotification: c.state.resolutionNotification,
          website: c.state.website,
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
            if (
              !step.state.snapshotRef ||
              step.state.snapshotRef.snapshotOnly ||
              !deps.debugShare
            )
              return;
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
                await step.vars.bodies.read(step.state.snapshotRef),
                step.abortSignal,
                async (id) => {
                  step.state.threadId = id;
                  await step.vars.persist();
                },
              );
              step.state.threadId = result.threadId;
              step.state.report = String(redactDebug(result.report));
              step.state.resolved = result.resolved;
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
          receipt.snapshotRef ||
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

export async function publishDebugNotifications(
  receipt: SessionCommandReceipt,
  threadId: string | undefined,
  deps: Dependencies,
  persist: () => Promise<void>,
  resolved = false,
) {
  const link = receipt.debugLink;
  if (!link) return false;
  // One serialized notifier owns all notices. Origin publication never touches
  // these deliveries, so concurrent retries cannot turn a live send into unknown.
  const sendNotification = async (delivery: Delivery) => {
    if (
      delivery.result?.status === "rejected" &&
      delivery.result.retryable &&
      delivery.attempts < 3 &&
      Date.now() <
        (delivery.outcomeObservedAt ?? 0) + (delivery.result.retryAfterMs ?? 0)
    )
      return true;
    const result = await deliver(
      delivery,
      persist,
      (message) =>
        deps.channels[message.address.channel]?.send(message) ??
        Promise.resolve({
          status: "rejected" as const,
          code: "channel_disabled",
          retryable: false,
        }),
    );
    return (
      result.status === "rejected" && result.retryable && delivery.attempts < 3
    );
  };
  if (receipt.ownerDelivery && (await sendNotification(receipt.ownerDelivery)))
    return true;
  if (threadId && !link.delivery) {
    const acknowledgment = link.replyAtOrigin
      ? receipt.delivery
      : (receipt.ownerDelivery ?? receipt.delivery);
    // The independently published origin acknowledgment may still be in flight.
    // Wait for its publisher; never call deliver on that live send here.
    if (acknowledgment.phase !== "settled") return true;
    const outbound = receipt.delivery.message;
    const address = link.address ?? outbound.address;
    const replyThread =
      acknowledgment.result?.status === "sent"
        ? (address.threadId ?? acknowledgment.result.messageId)
        : undefined;
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
        address: replyThread ? { ...address, threadId: replyThread } : address,
        content: {
          type: "text",
          text: `${mention}${replyThread ? "" : `DEBUGSHARE ${receipt.snapshotId ?? receipt.snapshot?.id}\n`}Amp investigation: https://ampcode.com/threads/${encodeURIComponent(threadId)}`,
        },
      },
    };
    await persist();
  }
  if (link.delivery && (await sendNotification(link.delivery))) return true;
  // A persisted attempt was already authorized by an attestation. A failed
  // status read must not retire its retryable rejection or reset its deadline.
  if (
    receipt.debugResolution &&
    (resolved || receipt.debugResolution.attempts > 0)
  ) {
    if (receipt.delivery.phase !== "settled") return true;
    return sendNotification(receipt.debugResolution);
  }
  return false;
}

export async function publishSessionCommand(
  receipt: SessionCommandReceipt,
  deps: Dependencies,
  persist: () => Promise<void>,
  publish: (snapshot: DebugSnapshot) => Promise<void>,
  signal: AbortSignal,
  load?: (ref: DebugBodyRef) => Promise<DebugSnapshot>,
) {
  const release = await deps.lifecycle?.enter(signal);
  let settlement: Promise<ModelSettlement> | undefined;
  try {
    if (!receipt.published && receipt.snapshotRef && !load)
      throw new Error("Debug snapshot loader required");
    const snapshot =
      !receipt.published &&
      (receipt.snapshotRef && load
        ? await load(receipt.snapshotRef)
        : commandSnapshot(receipt));
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
