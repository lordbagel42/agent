import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { MessageEvent } from "../core/contracts.js";
import { EvidenceStore } from "../memory/store.js";
import {
  type ConversationInput,
  conversationInputId,
} from "../runtime/inbox.js";
import { defaultGlobalPersonality } from "../runtime/personality.js";
import type { ConversationState } from "../runtime/registry.js";
import { createSessionCatalog, type SessionHost } from "./catalog.js";
import { produceSessionArchiveTurn } from "./producer.js";

it("preserves an already-prepared destination when preparation is retried", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const key = ["private", "owner"];
  const source: MessageEvent = {
    type: "message",
    id: "source",
    messageId: "1800000000.000001",
    occurredAt: 100,
    senderId: "U1",
    direct: true,
    text: "Hello",
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  };
  const id = conversationInputId({ type: "event", event: source });
  const state: ConversationState = {
    history: [],
    events: {},
    deliveries: {},
    lastInbound: {},
    jobs: {},
    pendingInputs: { [id]: source },
    ingress: {
      sequence: 1,
      receivedThrough: 100,
      receipts: {
        [id]: {
          sequence: 1,
          kind: "message",
          lane: "session",
          receivedAt: 100,
        },
      },
    },
    migration: {
      phase: "sessions",
      scope: JSON.stringify(key),
      epoch: "a".repeat(64),
      barrier: "b".repeat(64),
      legacyInputs: [],
      archivedInputs: [],
      barrierObserved: true,
    },
  };
  const host: SessionHost = {
    state,
    key,
    persist: async () => {},
    personality: async () => defaultGlobalPersonality,
    worker: () => {
      throw new Error("No worker expected");
    },
    publish: async () => {},
    enqueue: async () => {},
    schedule: async () => {},
    publishNative: async () => {},
    wakeupContext: async () => null,
    claimWakeup: async () => false,
    completeWakeup: async () => {},
  };
  const catalog = createSessionCatalog(
    {
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
      },
      channels: {},
      model: { reply: async () => ({ text: "" }) },
      memory: { store, source: () => undefined },
      sessions: { idleMs: 1000 },
    },
    () => true,
    () => "test",
  );
  await catalog.pump(host);
  const turn = state.sessions?.turns[id];
  if (!turn) throw new Error("Missing assignment");
  await catalog.prepare(host, turn.assignment, []);
  if (!turn.context) throw new Error("Missing prepared context");
  // Old code saved this before the preparation RPC's response was lost.
  turn.context.replyAddress = { ...source.address };
  const resumed = await catalog.prepare(host, turn.assignment, []);
  if ("control" in resumed) throw new Error("Unexpected suppression");
  expect(resumed.replyAddress).toEqual(source.address);
  const applied = await catalog.apply(host, turn.assignment, {
    text: "Hello back",
  });
  expect(applied.replyAddress ?? resumed.replyAddress).toEqual(source.address);
});

it.for([
  "job_result",
  "wakeup",
  "execution_result",
  "silent_execution_result",
  "untracked_job_result",
  "decision_mode_mismatch",
] as const)(
  "retains %s origin dependencies and suppresses revoked preparation",
  async (scenario, t) => {
    const kind =
      scenario === "untracked_job_result"
        ? "job_result"
        : scenario === "silent_execution_result"
          ? "execution_result"
          : scenario === "decision_mode_mismatch"
            ? "wakeup"
            : scenario;
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const key = ["private", "owner"];
    const audience = JSON.stringify(key);
    store.appendSource({
      id: "origin-evidence",
      audiences: [audience],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      observedAt: 1,
      sourceUrl: "https://example.com/source",
      text: "PRIVATE ORIGIN EVIDENCE",
    });
    const source: MessageEvent = {
      id: "source",
      type: "message",
      messageId: "1800000000.000001",
      occurredAt: 1800000000000,
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      senderId: "U1",
      direct: true,
      text: "An unrelated query",
    };
    const input: Exclude<ConversationInput, { type: "event" }> =
      kind === "job_result"
        ? {
            type: kind,
            jobId: "job",
            attempt: 1,
            source,
            text: "PRIVATE COMPLETION",
          }
        : kind === "wakeup"
          ? {
              type: kind,
              source,
              wakeup: {
                runId: "run",
                jobId: "timer",
                ...(scenario === "decision_mode_mismatch"
                  ? { mode: "decision" as const }
                  : {}),
                originEventId: "job",
                instruction: "PRIVATE COMPLETION",
                event: {
                  id: "tick",
                  source: "timer",
                  type: "due",
                  occurredAt: 10,
                  data: {},
                },
              },
            }
          : { type: kind, source, agentId: "worker", requestId: "task" };
    const id = conversationInputId(input);
    const state: ConversationState = {
      history: [],
      events: {},
      deliveries: {},
      lastInbound: {},
      jobs: {},
      agents: { work: "worker" },
      jobAgents: { job: { agentId: "worker", requestId: "task" } },
      memoryContexts: {
        job: {
          // The scheduler inherited this dependency from a worker's later
          // recall, not from the original conversation's dispatch reference.
          sourceIds: kind === "wakeup" ? [] : ["origin-evidence"],
          contextSourceIds: [],
          deletionTracked: true,
          personality: "test",
        },
      },
      controlCompletions: scenario === "execution_result" ? [id] : [],
      pendingNotifications: { [id]: input },
      ingress: {
        sequence: 1,
        receivedThrough: 100,
        receipts: {
          [id]: {
            sequence: 1,
            kind: "notification",
            lane: "session",
            receivedAt: 100,
          },
        },
      },
      migration: {
        phase: "sessions",
        scope: audience,
        epoch: "a".repeat(64),
        barrier: "b".repeat(64),
        legacyInputs: [],
        archivedInputs: [],
        barrierObserved: true,
      },
    };
    const worker = {
      summary: async () => ({ pending: 0, evidenceIds: [] }),
      result: async () => ({
        status: "completed",
        task: "preview",
        evidenceIds: [],
        report:
          scenario === "silent_execution_result" ? "" : "OBSOLETE PREVIEW",
        silent: scenario === "silent_execution_result",
      }),
      submit: async () => true,
      cancel: async () => {},
      recordCodingResult: vi.fn(async () => {}),
    };
    const host: SessionHost = {
      state,
      key,
      worker: () => worker,
      persist: async () => {},
      personality: async () => defaultGlobalPersonality,
      publish: vi.fn(async () => {}),
      enqueue: vi.fn(async () => {}),
      schedule: async () => {},
      publishNative: vi.fn(async () => {}),
      wakeupContext: vi.fn(async () => ({
        evidenceIds: ["origin-evidence"],
        retentionTracked: true,
      })),
      claimWakeup: vi.fn(async () => true),
      completeWakeup: async () => {},
    };
    const catalog = createSessionCatalog(
      {
        owner: {
          id: "owner",
          identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
        },
        channels: {},
        model: { reply: async () => ({ text: "" }) },
        memory: {
          store,
          source: () => {
            if (scenario === "decision_mode_mismatch")
              throw new Error(
                "Forged placement must not become Slack evidence",
              );
            return undefined;
          },
        },
        sessions: { idleMs: 1000 },
      },
      (_scope, ref) =>
        [...ref.sourceIds, ...(ref.contextSourceIds ?? [])].every(
          (id) => !!store.source(audience, id),
        ),
      () => "test",
    );
    await catalog.pump(host);
    const turn = state.sessions?.turns[id];
    if (!turn) throw new Error("Missing assignment");
    if (scenario === "decision_mode_mismatch") {
      expect(await catalog.prepare(host, turn.assignment, [])).toMatchObject({
        control: { effects: "confirmed" },
      });
      expect(host.claimWakeup).not.toHaveBeenCalled();
      return;
    }
    if (scenario === "untracked_job_result") {
      delete state.memoryContexts?.job;
      // Input was admitted before ledger-first deletion; actor cleanup has not
      // run. No origin reference can prove this saved report is still usable.
      store.deleteSource("origin-evidence");
      expect(await catalog.prepare(host, turn.assignment, [])).toMatchObject({
        control: {
          effects: "confirmed",
          input: { turn: { data: { entries: [] } } },
        },
      });
      expect(worker.recordCodingResult).not.toHaveBeenCalled();
      expect(host.publishNative).not.toHaveBeenCalled();
      expect(turn.context).toBeUndefined();
      return;
    }
    if (scenario === "execution_result") {
      // Token A was replaced, but its host-only classification is immutable.
      expect(state.forgetConfirmations).toBeUndefined();
      expect(turn.mode).toBe("control");
      expect(host.enqueue).toHaveBeenCalledWith(input);
      expect(host.publish).not.toHaveBeenCalled();
      turn.revoked = true;
      await expect(catalog.prepare(host, turn.assignment, [])).rejects.toThrow(
        "Control receipt unavailable",
      );
      expect(turn.control).toBeUndefined();
      return;
    }
    const prepared = await catalog.prepare(host, turn.assignment, [
      {
        role: "user",
        content: source.text,
        source,
        reference: { sourceIds: [], personality: "test" },
      },
      {
        role: "assistant",
        content: "Acknowledged earlier request",
        source: {
          ...source,
          id: "ack",
          senderId: "",
          messageId: "1800000001.000001",
        },
        reference: { sourceIds: [], personality: "test" },
      },
      {
        role: "user",
        content: "A newer correction",
        source: { ...source, id: "correction", messageId: "1800000002.000001" },
        reference: { sourceIds: [], personality: "test" },
      },
    ]);
    if (scenario === "silent_execution_result") {
      if (!("control" in prepared)) throw new Error("Expected silent receipt");
      expect(host.publishNative).toHaveBeenCalledWith(
        expect.objectContaining({ id: "worker:task", source: "execution" }),
        [],
      );
      expect(prepared.control.input.turn.eventId).toBe(id);
      expect(prepared.control.input.turn.data.entries).toEqual([]);
      await expect(
        catalog.acknowledge(host, turn.assignment, {
          control: true,
          archivedThrough: turn.assignment.sequence,
        }),
      ).rejects.toThrow("Activity archive not acknowledged");
      const archivedThrough = store.archiveSessionTurn(
        prepared.control.input,
        0,
      );
      expect(await catalog.prepare(host, turn.assignment, [])).toEqual(
        prepared,
      );
      expect(host.publishNative).toHaveBeenCalledTimes(1);
      await catalog.acknowledge(host, turn.assignment, {
        control: true,
        archivedThrough,
      });
      expect(catalog.status(host, turn.assignment)).toBe("acknowledged");
      expect(state.events[id]?.done).toBe(true);
      expect(state.pendingNotifications?.[id]).toBeUndefined();
      return;
    }
    if ("control" in prepared) throw new Error("Unexpected suppression");
    // Notifications reuse source for routing, never as a newly arrived request.
    expect(
      prepared.request.messages
        .slice(0, 3)
        .map(({ content }) => JSON.parse(content).text),
    ).toEqual([
      source.text,
      "Acknowledged earlier request",
      "A newer correction",
    ]);
    expect([
      ...prepared.reference.sourceIds,
      ...(prepared.reference.contextSourceIds ?? []),
    ]).toContain("origin-evidence");
    if (kind === "job_result") {
      expect(worker.recordCodingResult).toHaveBeenCalledExactlyOnceWith(
        "job:1",
        "task",
        "PRIVATE COMPLETION",
      );
      expect(host.publishNative).toHaveBeenCalledWith(
        expect.objectContaining({ id: "job:1", source: "coding" }),
        ["origin-evidence"],
      );
      const blank = { text: " \n", messages: [" "] };
      expect(await catalog.apply(host, turn.assignment, blank)).toEqual({
        text: "PRIVATE COMPLETION",
      });
      expect(await catalog.apply(host, turn.assignment, blank)).toEqual({
        text: "PRIVATE COMPLETION",
      });
    } else {
      expect(prepared.reference.sourceIds).not.toContain("origin-evidence");
      expect(host.wakeupContext).toHaveBeenCalledWith("run");
      vi.mocked(host.wakeupContext).mockResolvedValueOnce({
        evidenceIds: ["origin-evidence"],
        retentionTracked: false,
      });
      expect(await catalog.prepare(host, turn.assignment, [])).toMatchObject({
        retentionExcluded: true,
      });
      vi.mocked(host.claimWakeup).mockResolvedValue(false);
      expect(await catalog.prepare(host, turn.assignment, [])).toMatchObject({
        control: {
          effects: "confirmed",
          input: { turn: { data: { entries: [] } } },
        },
      });
    }
    store.archiveSessionTurn(
      produceSessionArchiveTurn(
        {
          ...turn.assignment,
          audience,
          retentionExcluded: false,
          deliveries: [
            {
              reference: prepared.reference,
              delivery: {
                phase: "settled",
                attempts: 1,
                outcomeObservedAt: 101,
                result: { status: "sent", messageId: "out" },
                message: {
                  id: "out",
                  address: source.address,
                  lastInboundAt: source.occurredAt,
                  content: { type: "text", text: "PRIVATE COMPLETION" },
                },
              },
            },
          ],
        },
        catalog.evidence,
      ),
      0,
    );
    expect(
      store.retrieveSession(audience, turn.assignment.sessionId).turns,
    ).toHaveLength(1);
    store.deleteSource("origin-evidence");
    expect(
      store.retrieveSession(audience, turn.assignment.sessionId).turns,
    ).toEqual([]);
  },
);
