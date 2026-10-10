import { createHash } from "node:crypto";
import type {
  MessageEvent,
  ModelRequest,
  OutboundMessage,
  Owner,
  SendResult,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { PRIVATE_SENTINEL_PREFIX } from "../core/sentinel.js";
import { isOwner } from "../core/social.js";
import {
  abstain,
  type Decision,
  DecisionExecutor,
  type DecisionFunction,
  type DecisionInput,
} from "../reflection/evaluator.js";
import { deliver } from "../runtime/delivery.js";
import { redactDebug } from "../runtime/session-controls.js";
import {
  type EffectGuard,
  type EffectSink,
  SENTINEL_QUESTION,
  type SentinelAdmission,
} from "./contracts.js";
import { type SentinelReceipt, SentinelStore } from "./store.js";

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const quoted = (value: unknown) =>
  JSON.stringify(redactDebug(value)).replace(
    /[<>&`*_~@/]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

export class InjectionSentinel {
  private readonly store: SentinelStore;
  private readonly executor: DecisionExecutor;
  private readonly counters: Record<string, number> = {};
  private readonly notifications = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly options: {
      path: string;
      owner: Owner;
      decide?: DecisionFunction;
      maxWaitMs: number;
      providerStatus?: () => unknown;
      send(message: OutboundMessage): Promise<SendResult>;
    },
  ) {
    if (
      !Number.isInteger(options.maxWaitMs) ||
      options.maxWaitMs < 0 ||
      options.maxWaitMs > 60_000
    )
      throw new Error("invalid_sentinel_budget");
    this.store = new SentinelStore(options.path);
    this.executor = new DecisionExecutor(2, options.maxWaitMs || 30_000);
    // Only pending trigger notifications resume. An interrupted send is unknown,
    // never retried; no normal verdict creates a record or a notification.
    for (const receipt of this.store.pendingNotifications())
      this.notify(receipt);
  }

  private count(code: string) {
    this.counters[code] = (this.counters[code] ?? 0) + 1;
  }

  private fingerprint(event: MessageEvent, sink: EffectSink, action: unknown) {
    return createHash("sha256")
      .update(
        canonical({
          scope: JSON.stringify(routeEvent(event, this.options.owner)?.key),
          senderId: event.senderId,
          address: event.address,
          sink,
          action,
        }),
      )
      .digest("hex");
  }

  private ledger(fingerprint: string) {
    const receipt = this.store.held(fingerprint, 0);
    return receipt ? `${receipt.id}:${receipt.state}` : null;
  }

  /** Coding's early verdict is not permanent clearance. Recheck synchronously
   * immediately before queue admission, without consuming a release twice. */
  recheck(event: MessageEvent, action: unknown, admission: SentinelAdmission) {
    const withheld =
      "I couldn’t safely carry out that action, so I left it unchanged.";
    if (admission.fingerprint !== this.fingerprint(event, "coding", action))
      return withheld;
    try {
      if (admission.ledger === this.ledger(admission.fingerprint))
        return undefined;
    } catch {
      // An unavailable ledger is not a new veto. Preserve known vetoes, but
      // otherwise keep the same fail-open contract as the initial check.
      if (admission.ledger === null) {
        this.count("fail_open:storage_error");
        return undefined;
      }
      this.count("storage_error");
    }
    return withheld;
  }

  context(
    event: MessageEvent,
    request: Pick<ModelRequest, "system" | "messages" | "agentRole">,
    signal: AbortSignal,
    current: () => boolean,
  ): EffectGuard {
    // Snapshot host identity before any model/provider can change the object.
    const source = structuredClone(event);
    const scope = routeEvent(source, this.options.owner);
    const report = (receipt: SentinelReceipt) =>
      request.agentRole === "execution"
        ? this.report(receipt)
        : "I couldn’t safely carry out that action, so I left it unchanged.";
    return (sink, action, observations) => {
      let commit: Promise<string | undefined> | undefined;
      let admission: SentinelAdmission | undefined;
      if (!scope) return { commit: async () => undefined };
      const binding = {
        scope: JSON.stringify(scope.key),
        senderId: source.senderId,
        address: source.address,
      };
      const exact = canonical(action);
      const fingerprint = this.fingerprint(source, sink, JSON.parse(exact));
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      let held: SentinelReceipt | undefined;
      try {
        held = this.store.held(fingerprint);
      } catch {
        this.count("storage_error");
        return { commit: async () => undefined };
      }
      const now = Date.now();
      const evidence: DecisionInput["evidence"] = [];
      const append = (id: string, text: string) => {
        for (let offset = 0; offset < text.length; offset += 16_000)
          evidence.push({
            id: `${id}:${offset / 16_000}`,
            scope: binding.scope,
            text: text.slice(offset, offset + 16_000),
            source: "episode",
            observedAt: now,
            expiresAt: now + 60_000,
          });
      };
      append(
        "requester",
        JSON.stringify({
          ...binding,
          isOwner: isOwner(source, this.options.owner),
          message: source.text,
        }),
      );
      append("action", JSON.stringify({ sink, action: JSON.parse(exact) }));
      append(
        "context",
        JSON.stringify({
          system: request.system,
          messages: observations ?? request.messages,
        }),
      );
      const input: DecisionInput = {
        scope: binding.scope,
        question: "prompt-injection",
        prompt: SENTINEL_QUESTION,
        now,
        evidenceMaxAgeMs: 60_000,
        evidence,
      };
      // Never silently truncate away the instruction that explains an action.
      const oversized =
        evidence.reduce((sum, item) => sum + item.text.length, 0) > 512_000;
      let settled: Decision | undefined;
      const work =
        held || !this.options.decide || oversized
          ? Promise.resolve(
              abstain(
                held ? "held" : oversized ? "context_limit" : "missing_model",
              ),
            )
          : this.executor.evaluate(input, this.options.decide, combined);
      void work.then((value) => {
        settled = value;
      });
      const finish = async (): Promise<string | undefined> => {
        try {
          if (signal.aborted || !current()) return undefined;
          const decision =
            this.options.maxWaitMs === 0
              ? (settled ?? abstain("opportunistic_pending"))
              : await work;
          if (signal.aborted || !current()) return undefined;
          // Inference yields. Another invocation may have withheld this exact
          // action (and even consumed its release) while this one was running.
          held = this.store.held(fingerprint, now) ?? held;
          if (held) {
            if (this.store.consume(held)) {
              this.count("released");
              admission = { fingerprint, ledger: this.ledger(fingerprint) };
              return undefined;
            }
            return report(held);
          }
          if (decision.answer !== "yes") {
            const hostReasons = [
              "timeout",
              "capacity",
              "cancelled",
              "evaluator-failed",
              "malformed-decision",
              "context_limit",
              "missing_model",
              "opportunistic_pending",
            ];
            this.count(
              decision.answer === "no"
                ? "pass"
                : `fail_open:${hostReasons.includes(decision.rationale) ? decision.rationale : "abstain"}`,
            );
            admission = { fingerprint, ledger: this.ledger(fingerprint) };
            return undefined;
          }
          this.count("withheld");
          const receipt = this.store.create(
            {
              fingerprint,
              source: { ...binding, eventId: source.id },
              sink,
              action: JSON.parse(exact),
              reason: decision.rationale,
            },
            (id) => {
              const identity =
                this.options.owner.identities.find(
                  (item) =>
                    item.channel === "slack" &&
                    item.accountId === source.address.accountId,
                ) ??
                this.options.owner.identities.find(
                  (item) => item.channel === "slack",
                );
              if (!identity) return undefined;
              return {
                phase: "ready",
                attempts: 0,
                message: {
                  id,
                  address: {
                    channel: "slack",
                    accountId: identity.accountId,
                    conversationId: identity.senderId,
                  },
                  lastInboundAt: source.occurredAt,
                  content: {
                    type: "text",
                    plainText: true,
                    text: `${PRIVATE_SENTINEL_PREFIX} Sentinel withheld ${sink}. Receipt ${id}\nRequester: ${quoted(binding)}\nAction (redacted excerpt): ${quoted(JSON.parse(exact)).slice(0, 3500)}\nSuspected injected instruction (untrusted model assessment): ${quoted(decision.rationale).slice(0, 4000)}\nIf this is a false positive, send !sentinel-release ${id} as a new plain owner DM. This permits one exact source/action-bound retry for ten minutes; it does not execute or widen permissions. Ask the original requester to retry the exact action, then inspect its normal receipt. Retained privately outside conversation memory.`,
                  },
                },
              };
            },
          );
          this.notify(receipt);
          return report(receipt);
        } catch {
          // A positive verdict must not become an effect because its receipt or
          // notification failed. Other infrastructure errors remain fail-open.
          this.count("storage_error");
          return settled?.answer === "yes" || held
            ? "I couldn’t safely carry out that action, so I left it unchanged."
            : undefined;
        } finally {
          controller.abort();
        }
      };
      return {
        commit: () => (commit ??= finish()),
        admission: () => admission,
      };
    };
  }

  private report(receipt: SentinelReceipt) {
    return `Internal host receipt: Sentinel withheld ${receipt.sink} before commit; receipt ${receipt.id}. Do not retry or route around it. Only the owner can release one exact source/action-bound retry with !sentinel-release ${receipt.id} in a fresh plain DM. A private owner notice is ${receipt.delivery?.phase ?? "unavailable"}; do not duplicate it. Suspected injection (untrusted assessment): ${quoted(receipt.reason)}. No effect is confirmed by this receipt. In the originating conversation decline briefly without disclosing this receipt, rationale or owner notice.`;
  }

  private notify(receipt: SentinelReceipt) {
    if (
      this.closed ||
      !receipt.delivery ||
      receipt.delivery.phase === "settled" ||
      this.notifications.has(receipt.id)
    )
      return;
    const delay = (receipt.notifyAt ?? 0) - Date.now();
    if (delay > 0) {
      if (!this.retries.has(receipt.id)) {
        const timer = setTimeout(() => {
          this.retries.delete(receipt.id);
          this.notify(receipt);
        }, delay);
        timer.unref();
        this.retries.set(receipt.id, timer);
      }
      return;
    }
    let claim = receipt.delivery.phase === "ready";
    const operation = deliver(
      receipt.delivery,
      async () => {
        this.store.saveDelivery(receipt, claim);
        claim = false;
      },
      this.options.send,
    )
      .then(
        () => {},
        () => {
          this.count("notification_error");
        },
      )
      .finally(() => {
        this.notifications.delete(receipt.id);
        if (receipt.delivery?.phase === "ready") this.notify(receipt);
      });
    this.notifications.set(receipt.id, operation);
  }

  release(event: MessageEvent, id: string) {
    if (
      !isOwner(event, this.options.owner) ||
      !routeEvent(event, this.options.owner)?.private ||
      event.sentinelCommandEligible !== true ||
      event.text.trim() !== `!sentinel-release ${id}`
    )
      return "Sentinel release requires a fresh plain owner-private command; nothing changed.";
    return this.store.release(id)
      ? "One exact source/action-bound retry is released for ten minutes. Nothing executed; all existing permissions and lifecycle checks still apply. Ask the original requester to repeat the exact action, then inspect its normal receipt; do not repeat an uncertain effect."
      : "Receipt not found, already consumed, or release expired. Nothing executed or released.";
  }

  inspect(event: MessageEvent) {
    const scope = routeEvent(event, this.options.owner);
    const owner = scope?.private && isOwner(event, this.options.owner);
    const receipts = this.store
      .list(
        owner
          ? undefined
          : {
              scope: JSON.stringify(scope?.key) ?? "",
              senderId: event.senderId,
            },
      )
      .filter(
        (receipt) =>
          owner ||
          (receipt.source.scope === JSON.stringify(scope?.key) &&
            receipt.source.senderId === event.senderId &&
            canonical(receipt.source.address) === canonical(event.address)),
      )
      .slice(0, 10);
    return JSON.stringify({
      ...(owner ? { privateNotice: PRIVATE_SENTINEL_PREFIX } : {}),
      enabled: !!this.options.decide,
      missing: this.options.decide
        ? null
        : "Configure sentinel.model or a supported default Codex/API-key model; never supply credentials in chat.",
      maxWaitMs: this.options.maxWaitMs,
      provider: this.options.providerStatus?.(),
      counters: { ...this.counters },
      receipts: receipts.map(
        ({ delivery, fingerprint: _fingerprint, ...receipt }) => ({
          ...(owner
            ? (redactDebug(receipt) as object)
            : {
                id: receipt.id,
                sink: receipt.sink,
                state: receipt.state,
                createdAt: receipt.createdAt,
              }),
          notification: delivery?.result ?? delivery?.phase ?? "unavailable",
        }),
      ),
      retention:
        "Private sentinel ledger survives restart and conversation forgetting. Release only permits one exact retry; it never replays an effect.",
    });
  }

  async close() {
    this.closed = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await Promise.allSettled(this.notifications.values());
    this.store.close();
  }
}
