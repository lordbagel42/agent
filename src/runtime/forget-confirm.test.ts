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
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createInspectionReader } from "./inspection.js";
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
  const sessionId = "a".repeat(64);
  const archiveTarget = (sequence: number) =>
    store.archiveSessionTurn(
      {
        sessionId,
        audience,
        openedAt: 10,
        turn: {
          eventId: sequence.toString(16).padStart(64, "0"),
          sequence,
          receivedAt: 10 + sequence - 1,
          data: {
            sourceIds: ["target"],
            contextSourceIds: [],
            entries: [
              {
                role: "assistant",
                address: {
                  channel: "slack",
                  accountId: "T1",
                  conversationId: "D1",
                },
                observedAt: 20,
                delivery: "unknown",
                content: {
                  retention: "retained",
                  text: "SYNTHETIC PRIVATE ARCHIVE",
                },
              },
            ],
          },
        },
      },
      0,
    );
  archiveTarget(1);
  const sent: OutboundMessage[] = [];
  let action: CompanionReply = {
    text: "",
    forgetPreview: { sourceId: "target" },
  };
  let cleanupCalls = 0;
  let modelCalls = 0;
  let failCleanup = false;
  let failTargetCleanup = true;
  let rejectDelivery = false;
  let pendingAtTargetCleanup: unknown;
  const registry = createJuneRegistry({
    owner,
    workflows: { tools: {} },
    inspection: createInspectionReader({
      audience,
      memory: { store },
      selections: {},
    }),
    memory: {
      store,
      source: () => undefined,
      async forget(scope, sourceId) {
        expect(scope).toBe(audience);
        expect(store.isDeleted(sourceId)).toBe(true);
        cleanupCalls++;
        if (sourceId === "target" && failTargetCleanup) {
          failTargetCleanup = false;
          throw new Error("SYNTHETIC host cleanup unavailable");
        }
        if (failCleanup) {
          // Longer than Rivet's default step deadline: the supervisor must
          // retain a usable started receipt rather than kill this conversation.
          await setTimeout(31000);
          throw new Error("SYNTHETIC PRIVATE FAILURE");
        }
        // Exercise the same self-action used by the host callback, not a no-op.
        await june.forget(sourceId);
        if (sourceId === "target")
          pendingAtTargetCleanup = (await june.snapshot()).pendingNotifications;
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
      async reply(request) {
        modelCalls++;
        if (action.inspection === "forgetting") {
          expect(request.system).toContain('inspection to "forgetting"');
          expect(JSON.stringify(replyJsonSchema([], request))).toContain(
            '"forgetting"',
          );
          return parseReply(JSON.stringify(action), [], request);
        }
        return action;
      },
    },
  });
  const frozen = Promise.withResolvers<void>();
  const resumeFreeze = Promise.withResolvers<void>();
  t.onTestFinished(() => resumeFreeze.resolve());
  let pauseFreeze = false;
  const conversationConfig = registry.config.use.conversation.config;
  if (
    !("state" in conversationConfig) ||
    !("createVars" in conversationConfig) ||
    !conversationConfig.createVars
  )
    throw new Error("Missing conversation configuration");
  conversationConfig.state.jobs["frozen-different-job"] = {
    workspace: "fixture",
    goal: "SYNTHETIC PRIVATE BODY target",
  };
  const createVars = conversationConfig.createVars;
  conversationConfig.createVars = async (c, input) => {
    const vars = await createVars(c, input);
    return {
      ...vars,
      persist: async () => {
        await vars.persist();
        if (pauseFreeze && c.state.forgetCleanups?.['"target"']) {
          pauseFreeze = false;
          frozen.resolve();
          await resumeFreeze.promise;
        }
      },
    };
  };
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
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).some(
            (e) => e.done && e.event.id === event.id,
          ),
        { timeout: 40000 },
      )
      .toBe(true);
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
  expect(sent.at(-1)?.content).toMatchObject({
    text: expect.stringContaining('"archivedTurns":1'),
  });
  expect((await june.snapshot()).forgetConfirmations?.[first]).toMatchObject({
    includeArchives: true,
    archivedTurns: 1,
  });
  archiveTarget(2);
  expect(await turn(`!forget-confirm ${first}`)).toContain("no longer current");
  expect(store.source(audience, "target")).toBeDefined();
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
  pauseFreeze = true;
  const confirming = turn(`!forget-confirm ${fresh}`);
  await frozen.promise;
  expect(store.isDeleted("target")).toBe(false);
  if (!lastEvent) throw new Error("Missing confirmation event");
  const lateNotice = {
    type: "job_result" as const,
    jobId: "frozen-different-job",
    attempt: 1,
    // No matching frozen event: only the non-event job ID owns this cleanup.
    source: {
      ...lastEvent,
      id: "unrecorded-job-original",
      text: "SYNTHETIC PRIVATE saved worker source",
    },
    text: "SYNTHETIC PRIVATE completion between freeze and tombstone",
  };
  await june.notify(lateNotice);
  const admittedDuringFreeze = await june.snapshot();
  expect(
    Object.values(admittedDuringFreeze.pendingNotifications ?? {}),
  ).toEqual([lateNotice]);
  const noticeId = Object.keys(
    admittedDuringFreeze.pendingNotifications ?? {},
  )[0];
  if (!noticeId) throw new Error("Missing admitted notification");
  const frozenTarget = admittedDuringFreeze.forgetCleanups?.['"target"'];
  if (!frozenTarget || frozenTarget.completed)
    throw new Error("Missing frozen cleanup");
  expect(frozenTarget.eventIds).toContain(noticeId);
  resumeFreeze.resolve();
  expect(await confirming).toContain("cleanup completion is unconfirmed");
  expect(cleanupCalls).toBe(1);
  await expect
    .poll(async () => (await june.snapshot()).events[noticeId]?.done)
    .toBe(true);
  const beforeRetry = (await june.snapshot()).events[noticeId]?.event;
  if (beforeRetry?.type !== "message") throw new Error("Missing source record");
  expect(beforeRetry.text).toBe(lateNotice.source.text);
  const result = await turn(`!forget-confirm ${fresh}`);
  const cleaned = await june.snapshot();
  const cleanedNotice = cleaned.events[noticeId]?.event;
  if (cleanedNotice?.type !== "message")
    throw new Error("Missing source record");
  expect(cleanedNotice.text).toBe("");
  // Inspect while the confirmation still owns the consumer: a later dequeue
  // must not make a stale recoverable body look as though cleanup removed it.
  expect(pendingAtTargetCleanup).toEqual({});
  expect(cleaned.pendingNotifications).toEqual({});
  expect(cleaned.ingress).toEqual(admittedDuringFreeze.ingress);
  expect(cleaned.forgottenEvents).toContain("frozen-different-job");
  expect(result).toContain("host cleanup completed");
  expect(result).toContain("physicalPurge:false");
  expect(result).toContain("journals, backups, or already-sent");
  expect(modelCalls).toBe(calls);
  expect(cleanupCalls).toBe(2);
  expect(store.isDeleted("target")).toBe(true);
  expect(store.isDeleted("new-dependent")).toBe(true);
  expect(store.retrieveSession(audience, sessionId)).toEqual({
    session: { id: sessionId, openedAt: 10, archivedThrough: 2 },
    turns: [],
    omitted: 0,
  });
  expect(store.source(audience, "unrelated")).toBeDefined();
  expect((await june.snapshot()).forgetConfirmations?.[fresh]?.status).toBe(
    "completed",
  );
  expect(await turn(`!forget-confirm ${fresh}`)).toContain("already completed");
  expect(cleanupCalls).toBe(2);

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
  expect(cleanupCalls).toBe(2);

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
  action = { text: "", inspection: "forgetting" };
  const interruptedState = await june.snapshot();
  const inspection = await turn("Did forgetting cleanup finish?");
  expect(inspection).toContain('"started":1,"completed":1');
  expect(inspection).toContain(`"token":"${interrupted}"`);
  expect(inspection).toContain('"logicalDeletion":"confirmed"');
  expect(inspection).toContain('"recovery":"repeat-confirmation"');
  expect(inspection).toContain("!forget-confirm TOKEN");
  expect(inspection).toContain("physicalPurge:false");
  expect(inspection).toContain("completion is unconfirmed");
  expect(inspection).not.toContain('"sourceId"');
  expect(inspection).not.toContain("SYNTHETIC PRIVATE");
  expect(inspection.length).toBeLessThan(4000);
  expect((await june.snapshot()).forgetConfirmations).toEqual(
    interruptedState.forgetConfirmations,
  );
  expect(cleanupCalls).toBe(3);
  expect(store.source(audience, "interrupted")).toBeUndefined();
  action = { text: "Fresh post-deletion reply" };
  await turn("Fresh post-deletion request");
  if (!lastEvent) throw new Error("Missing fresh event");
  await library.manage(
    lastEvent,
    "fresh-workflow",
    workflow("define", "fresh"),
    store.deletionRevision(),
  );
  expect(cleanupCalls).toBe(3);
  expect(await turn(`!forget-confirm ${interrupted}`)).toContain(
    "host cleanup completed",
  );
  expect(cleanupCalls).toBe(4);
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
  expect(cleanupCalls).toBe(4);
  action = { text: "", inspection: "forgetting" };
  const completedInspection = await turn("Check forgetting status again");
  expect(completedInspection).toContain('"started":0,"completed":2');
  expect(completedInspection).toContain("physicalPurge:false");
  expect(completedInspection).not.toContain(interrupted);
  expect(cleanupCalls).toBe(4);
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
  expect(cleanupCalls).toBe(4);
  expect(store.isDeleted("before-delete")).toBe(false);
  action = { text: "", inspection: "forgetting" };
  const preDeleteInspection = await turn("Inspect the interrupted deletion");
  expect(preDeleteInspection).toContain(`"token":"${beforeDelete}"`);
  expect(preDeleteInspection).toContain('"logicalDeletion":"unconfirmed"');
  expect(preDeleteInspection).toContain('"recovery":"fresh-preview"');
  expect(cleanupCalls).toBe(4);
  const refreshed = await preview("before-delete");
  expect(await turn(`!forget-confirm ${refreshed}`)).toContain(
    "host cleanup completed",
  );
  expect(cleanupCalls).toBe(5);
  expect(store.isDeleted("before-delete")).toBe(true);
  expect(JSON.stringify(sent)).not.toContain("SYNTHETIC PRIVATE");
}, 90000);
