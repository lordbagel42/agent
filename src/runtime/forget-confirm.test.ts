import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { EvidenceStore } from "../memory/store.js";
import { createJuneRegistry } from "./registry.js";

it("requires exact owner confirmation and resumes frozen cleanup without erasing fresh work", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  for (const id of [
    "target",
    "unrelated",
    "interrupted",
    "foreign-race",
    "before-delete",
  ])
    store.appendSource({
      id,
      audiences: id === "foreign-race" ? [audience, "foreign"] : [audience],
      platform: "slack",
      account: "T1",
      conversation: "D1",
      author: "U1",
      observedAt: 1,
      sourceUrl: "https://example.com/fixture",
      text: `SYNTHETIC PRIVATE BODY ${id}`,
    });
  const sent: OutboundMessage[] = [];
  let action: CompanionReply = {
    text: "",
    forgetPreview: { sourceId: "target" },
  };
  let cleanupCalls = 0;
  let modelCalls = 0;
  let failCleanup = false;
  let rejectDelivery = false;
  const registry = createJuneRegistry({
    owner,
    workflows: { tools: {} },
    memory: {
      store,
      source: () => undefined,
      async forget(scope, sourceId) {
        expect(scope).toBe(audience);
        expect(store.isDeleted(sourceId)).toBe(true);
        cleanupCalls++;
        if (failCleanup) {
          // Longer than Rivet's default step deadline: the supervisor must
          // retain a usable started receipt rather than kill this conversation.
          await setTimeout(31000);
          throw new Error("SYNTHETIC PRIVATE FAILURE");
        }
        // Exercise the same self-action used by the host callback, not a no-op.
        await june.forget(sourceId);
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return rejectDelivery
            ? { status: "unknown", code: "fixture" }
            : { status: "sent", messageId: `out${sent.length}` };
        },
      },
    },
    model: {
      async reply() {
        modelCalls++;
        return action;
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", owner.id]);
  let sequence = 0;
  let lastEvent: MessageEvent | undefined;
  const turn = async (text: string, extra: Partial<MessageEvent> = {}) => {
    const event: MessageEvent = {
      type: "message",
      id: `in${++sequence}`,
      messageId: `ts${sequence}`,
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      text,
      forgetCommandEligible: true,
      ...extra,
    };
    lastEvent = event;
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("Missing fixture scope");
    const actor = client.conversation.getOrCreate(scope.key);
    const done = Object.values((await actor.snapshot()).events).filter(
      (e) => e.done,
    ).length;
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).filter((e) => e.done)
            .length,
        { timeout: 40000 },
      )
      .toBe(done + 1);
    const content = sent.at(-1)?.content;
    return content?.type === "text" ? content.text : "";
  };
  const preview = async (sourceId = "target") => {
    action = { text: "", forgetPreview: { sourceId } };
    const text = await turn("Preview forgetting this source");
    expect(text).not.toContain("SYNTHETIC PRIVATE BODY");
    const token = text.match(/!forget-confirm ([a-f0-9]{32})/)?.[1];
    expect(token).toBeDefined();
    return token as string;
  };

  const first = await preview();
  expect(cleanupCalls).toBe(0);
  action = { text: "nothing changed" };
  await turn(`> !forget-confirm ${first}`);
  await turn(`quoted: !forget-confirm ${first}`);
  await turn(`!forget-confirm ${first}`, { forgetCommandEligible: false });
  await turn(`!forget-confirm ${first}`, { forgetCommandEligible: undefined });
  await turn(`!forget-confirm ${first}`, {
    senderId: "U2",
    metadata: { channelType: "im" },
  });
  await turn(`!forget-confirm ${first}`, {
    direct: false,
    address: { channel: "slack", accountId: "T1", conversationId: "C1" },
  });
  // Custom model output is never an authenticated raw owner command.
  action = { text: `!forget-confirm ${first}` };
  await turn("model suggests a command");
  action = {
    text: "",
    forgetPreview: { sourceId: "target", confirmed: true },
  } as unknown as CompanionReply;
  await turn("model claims confirmation");
  expect(cleanupCalls).toBe(0);
  expect(store.source(audience, "target")).toBeDefined();

  store.appendClaim({
    id: "new-dependent",
    entity: "owner",
    text: "SYNTHETIC dependent",
    audiences: [audience],
    kind: "evidence",
    dependsOn: ["target"],
    contradicts: [],
    supersedes: [],
  });
  expect(await turn(`!forget-confirm ${first}`)).toContain("no longer current");
  expect(store.source(audience, "target")).toBeDefined();
  expect(cleanupCalls).toBe(0);

  rejectDelivery = true;
  const unsent = await preview();
  rejectDelivery = false;
  expect(await turn(`!forget-confirm ${unsent}`)).toContain("unavailable");
  expect(cleanupCalls).toBe(0);

  const fresh = await preview();
  const calls = modelCalls;
  const result = await turn(`!forget-confirm ${fresh}`);
  expect(result).toContain("host cleanup completed");
  expect(result).toContain("physicalPurge:false");
  expect(result).toContain("journals, backups, or already-sent");
  expect(modelCalls).toBe(calls);
  expect(cleanupCalls).toBe(1);
  expect(store.isDeleted("target")).toBe(true);
  expect(store.isDeleted("new-dependent")).toBe(true);
  expect(store.source(audience, "unrelated")).toBeDefined();
  expect((await june.snapshot()).forgetConfirmations?.[fresh]?.status).toBe(
    "completed",
  );
  expect(await turn(`!forget-confirm ${fresh}`)).toContain("already completed");
  expect(cleanupCalls).toBe(1);

  // Hidden changes deliberately do not alter the scoped fingerprint. Both the
  // issuance and confirmation paths must also check host-only confirmability.
  const foreign = await preview("foreign-race");
  store.appendClaim({
    id: "hidden-dependent",
    entity: "other",
    text: "SYNTHETIC PRIVATE foreign claim",
    audiences: ["foreign"],
    kind: "evidence",
    dependsOn: ["foreign-race"],
    contradicts: [],
    supersedes: [],
  });
  expect(await turn(`!forget-confirm ${foreign}`)).toContain(
    "no longer current",
  );
  expect(store.isDeleted("foreign-race")).toBe(false);
  expect(store.isDeleted("hidden-dependent")).toBe(false);
  const refused = await turn("Preview the same source again");
  expect(refused).not.toContain("!forget-confirm");
  expect(refused).not.toContain("hidden-dependent");
  expect(refused).not.toContain("confirmable");
  expect(refused).not.toContain("fingerprint");
  expect(cleanupCalls).toBe(1);

  const interrupted = await preview("interrupted");
  const library = client.workflowLibrary.getOrCreate([owner.id]);
  const workflow = (action: string, name: string) => ({
    action,
    name,
    source: action === "define" ? 'return "synthetic";' : null,
    dataJson: null,
    runId: null,
    offset: 0,
  });
  if (!lastEvent) throw new Error("Missing preview event");
  await library.manage(
    lastEvent,
    "old-workflow",
    workflow("define", "old"),
    store.deletionRevision(),
  );
  failCleanup = true;
  expect(await turn(`!forget-confirm ${interrupted}`)).toContain(
    "cleanup completion is unconfirmed",
  );
  expect(store.isDeleted("interrupted")).toBe(true);
  expect(
    (await june.snapshot()).forgetConfirmations?.[interrupted]?.status,
  ).toBe("started");
  if (!lastEvent) throw new Error("Missing confirmation event");
  await june.send("inbox", { type: "event", event: lastEvent });
  failCleanup = false;
  action = { text: "Fresh post-deletion reply" };
  await turn("Fresh post-deletion request");
  if (!lastEvent) throw new Error("Missing fresh event");
  await library.manage(
    lastEvent,
    "fresh-workflow",
    workflow("define", "fresh"),
    store.deletionRevision(),
  );
  expect(cleanupCalls).toBe(2);
  expect(await turn(`!forget-confirm ${interrupted}`)).toContain(
    "host cleanup completed",
  );
  expect(cleanupCalls).toBe(3);
  const after = await june.snapshot();
  expect(after.forgetConfirmations?.[interrupted]?.status).toBe("completed");
  if (!lastEvent) throw new Error("Missing resume event");
  expect(
    JSON.parse(
      await library.manage(
        lastEvent,
        "inspect-fresh",
        workflow("inspect", "fresh"),
        store.deletionRevision(),
      ),
    ).source,
  ).toBe('return "synthetic";');
  await expect(
    library.manage(
      lastEvent,
      "inspect-old",
      workflow("inspect", "old"),
      store.deletionRevision(),
    ),
  ).rejects.toThrow();
  expect(
    after.history.some(
      (entry) => entry.content === "Fresh post-deletion reply",
    ),
  ).toBe(true);
  expect(
    after.history.some(
      (entry) => entry.content === "Fresh post-deletion request",
    ),
  ).toBe(true);
  expect(await turn(`!forget-confirm ${interrupted}`)).toContain(
    "already completed",
  );
  expect(cleanupCalls).toBe(3);
  expect(JSON.stringify(sent)).not.toContain("SYNTHETIC PRIVATE");

  const beforeDelete = await preview("before-delete");
  const failedWrite = vi
    .spyOn(store, "deleteSource")
    .mockImplementationOnce(() => {
      throw new Error("SYNTHETIC PRIVATE storage failure");
    });
  expect(await turn(`!forget-confirm ${beforeDelete}`)).toContain(
    "Logical deletion is unconfirmed",
  );
  failedWrite.mockRestore();
  expect(store.isDeleted("before-delete")).toBe(false);
  expect(await turn(`!forget-confirm ${beforeDelete}`)).toContain(
    "fresh exact preview",
  );
  expect(cleanupCalls).toBe(3);
  expect(store.isDeleted("before-delete")).toBe(false);
  const refreshed = await preview("before-delete");
  expect(await turn(`!forget-confirm ${refreshed}`)).toContain(
    "host cleanup completed",
  );
  expect(cleanupCalls).toBe(4);
  expect(store.isDeleted("before-delete")).toBe(true);
  expect(JSON.stringify(sent)).not.toContain("SYNTHETIC PRIVATE");
}, 90000);
