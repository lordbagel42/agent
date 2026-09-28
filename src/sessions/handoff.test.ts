import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent, SendResult } from "../core/contracts.js";
import { slackSource } from "../imports/identity.js";
import { EvidenceStore } from "../memory/store.js";
import { conversationInputId } from "../runtime/inbox.js";
import * as priority from "../runtime/priority.js";
import { createJuneRegistry, type Dependencies } from "../runtime/registry.js";

const event = (id: string, text: string): MessageEvent => ({
  type: "message",
  id,
  messageId: `1800000000.00000${id}`,
  occurredAt: 1800000000000,
  senderId: "U1",
  direct: true,
  metadata: { channelType: "im" },
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  text,
});

it.for([
  "drained",
  "unknown-send",
  "old-inference",
  "missing-lineage",
] as const)(
  "freezes legacy admission without replay or invented settlement (%s)",
  async (mode, t) => {
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const reply = vi.fn(async () => ({ text: "PRIVATE MODEL ANSWER" }));
    const send = vi.fn(
      async (): Promise<SendResult> =>
        mode === "unknown-send"
          ? { status: "unknown", code: "lost-response" }
          : { status: "sent", messageId: "1800000001.000001" },
    );
    const deps: Dependencies = {
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
      },
      model: { reply },
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, threads: true, reactions: true },
          receive: async () => ({ response: new Response(), events: [] }),
          send,
        },
      },
      memory: {
        store,
        source: (input, audience) =>
          slackSource({
            audiences: [audience],
            workspace: "T1",
            channel: "D1",
            ts: input.messageId,
            author: "U1",
            text: input.text,
            workspaceUrl: "https://example.slack.com/",
          }),
      },
    };
    const registry = createJuneRegistry(deps);
    if (mode === "missing-lineage")
      delete registry.config.use.conversation.config.onCreate;
    if (mode === "drained") {
      const config = registry.config.use.conversation.config;
      if (!("createVars" in config) || !config.createVars)
        throw new Error("Missing fixture vars");
      const createVars = config.createVars;
      let lost = false;
      let deleted = false;
      config.createVars = async (c, input) => {
        const vars = await createVars(c, input);
        return {
          ...vars,
          persist: async () => {
            await vars.persist();
            if (
              !lost &&
              Object.values(c.state.pendingInputs ?? {}).some(
                (event) => event.id === "1",
              )
            ) {
              lost = true;
              throw new Error("Saved admission; publication did not run");
            }
            if (!deleted && c.state.migration?.archivePending) {
              deleted = true;
              store.deleteSource("unrelated-source");
            }
          },
        };
      };
    }
    const { client } = await setupTest(t, registry);
    const scope = ["private", "owner"];
    const june = client.conversation.getOrCreate(scope);
    const old = event(
      "1",
      mode === "old-inference" ? "PRIVATE INPUT" : "!approve 0123456789ab",
    );
    const oldId = conversationInputId({ type: "event", event: old });
    if (mode === "drained") {
      await expect(june.receive(old)).rejects.toThrow();
      expect((await june.snapshot()).pendingInputs?.[oldId]).toEqual(old);
      expect(send).not.toHaveBeenCalled();
    } else {
      await june.receive(old);
      await vi.waitFor(async () =>
        expect((await june.snapshot()).events[oldId]?.done).toBe(true),
      );
      expect(send).toHaveBeenCalledTimes(1);
    }
    expect(reply).toHaveBeenCalledTimes(mode === "old-inference" ? 1 : 0);

    // Lose the ledger's response once after its durable write. The projection
    // and first admission time must remain exact across workflow retry.
    const archive = store.archiveSessionTurn.bind(store);
    let lost = false;
    vi.spyOn(store, "archiveSessionTurn").mockImplementation(
      (input, revision) => {
        const through = archive(input, revision);
        if (!lost) {
          lost = true;
          throw new Error("Lost archive ACK");
        }
        return through;
      },
    );
    deps.sessionHandoff = true;
    const fresh = event("2", "NEW ACTIVITY INPUT");
    const freshId = conversationInputId({ type: "event", event: fresh });
    await june.receive(fresh);
    await vi.waitFor(
      async () => {
        const migration = (await june.snapshot()).migration;
        expect(migration?.barrierObserved).toBe(true);
        expect(migration?.archivedInputs).toEqual(
          mode === "missing-lineage" ? [] : [oldId],
        );
      },
      { timeout: 15000 },
    );
    const saved = await june.snapshot();
    expect(saved.migration?.legacyInputs).toEqual([oldId]);
    expect(saved.migration?.phase).toBe(
      mode === "drained" ? "sessions" : "draining",
    );
    expect(saved.ingress?.receipts[oldId]?.lane).toBe("legacy");
    expect(saved.ingress?.receipts[freshId]?.lane).toBe("session");
    expect(saved.pendingInputs?.[freshId]).toEqual(fresh);
    expect(saved.events[freshId]).toBeUndefined();
    const held = await june.outstandingOperations();
    expect(held.migration.ready).toBe(mode === "drained");
    if (mode !== "drained")
      expect(held.migration.reasons).toContain(
        {
          "unknown-send": "unresolvedDeliveries",
          "old-inference": "modelSettlementUnproven",
          "missing-lineage": "missingCoverage",
        }[mode],
      );
    const archived = store.searchSessions(JSON.stringify(scope), "").sessions;
    expect(archived).toHaveLength(mode === "missing-lineage" ? 0 : 1);
    if (mode !== "missing-lineage") {
      const data = store.retrieveSession(
        JSON.stringify(scope),
        archived[0]?.id ?? "",
      ).turns[0]?.data;
      expect(data?.incomplete).toBe(true);
      expect(
        data?.entries.every((entry) => entry.content.retention === "omitted"),
      ).toBe(true);
      expect(JSON.stringify(data)).not.toContain(old.text);
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(mode === "old-inference" ? 1 : 0);

    // Deactivation and duplicate delivery cannot reassign the saved receipt or
    // let accepted session traffic fall through to permanent-history inference.
    deps.sessionHandoff = false;
    await june.receive(fresh);
    await june.receive(event("3", "AFTER DEACTIVATION"));
    const later = await june.snapshot();
    expect(later.ingress?.receipts[freshId]).toEqual(
      saved.ingress?.receipts[freshId],
    );
    expect(
      Object.values(later.ingress?.receipts ?? {}).filter(
        (receipt) => receipt.lane === "session",
      ),
    ).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(mode === "old-inference" ? 1 : 0);

    if (mode === "drained") {
      await june.send("inbox", {
        type: "event",
        event: event("4", "UNTRACKED DIRECT INPUT"),
      });
      await vi.waitFor(async () =>
        expect(
          (await june.outstandingOperations()).migration.counts
            .unfrozenLegacyInputs,
        ).toBe(1),
      );
      expect((await june.outstandingOperations()).migration.ready).toBe(false);
      expect(reply).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    }
  },
);

it("does not reclassify a direct legacy input while it waits for priority", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const waiting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const createPriority = priority.createPriorityAdmission;
  const spy = vi
    .spyOn(priority, "createPriorityAdmission")
    .mockImplementation(() => {
      const admission = createPriority();
      const enter = admission.enter;
      admission.enter = async (...args) => {
        waiting.resolve();
        await resume.promise;
        return enter(...args);
      };
      return admission;
    });
  t.onTestFinished(() => spy.mockRestore());
  const reply = vi.fn(async () => ({ text: "LEGACY ANSWER" }));
  const send = vi.fn(
    async (): Promise<SendResult> => ({ status: "sent", messageId: "reply" }),
  );
  const deps: Dependencies = {
    owner: {
      id: "owner",
      identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
    },
    model: { reply },
    memory: { store, source: () => undefined },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, threads: true, reactions: true },
        receive: async () => ({ response: new Response(), events: [] }),
        send,
      },
    },
  };
  const { client } = await setupTest(t, createJuneRegistry(deps));
  const june = client.conversation.getOrCreate(["private", "owner"]);
  const input = { type: "event" as const, event: event("5", "DIRECT LEGACY") };
  const id = conversationInputId(input);
  await june.send("inbox", input);
  await waiting.promise;
  try {
    deps.sessionHandoff = true;
    await june.receive(input.event);
    const frozen = await june.snapshot();
    expect(frozen.migration?.legacyInputs).toContain(id);
    // The later webhook is not the first receipt of that already-running turn.
    expect(frozen.ingress?.receipts[id]).toBeUndefined();
  } finally {
    resume.resolve();
  }
  await vi.waitFor(async () =>
    expect((await june.snapshot()).events[id]?.done).toBe(true),
  );
  await june.receive(input.event);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await june.outstandingOperations()).migration.ready).toBe(false);
});
