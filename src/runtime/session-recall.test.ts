import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  OutboundMessage,
} from "../core/contracts.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import {
  type SessionArchiveInput,
  sessionTurnId,
} from "../sessions/archive.js";
import { recallSessions } from "../sessions/recall.js";
import { executionKey } from "./execution.js";
import { createJuneRegistry } from "./registry.js";

const owner = {
  id: "owner",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const audience = JSON.stringify(["private", owner.id]);
const sessionId = "a".repeat(64);
const address = {
  channel: "slack" as const,
  accountId: "T1",
  conversationId: "D1",
};

function archive(
  store: EvidenceStore,
  scope = audience,
  id = sessionId,
  sequence = 1,
  text = "I prefer the violet train.",
) {
  const source = {
    id: `${id}:${sequence}`,
    audiences: [scope],
    platform: "slack" as const,
    account: "T1",
    conversation: "D1",
    author: "U1",
    observedAt: 50,
    sourceUrl: "https://example.com/synthetic-source",
    text,
  };
  store.appendSource(source);
  const input: SessionArchiveInput = {
    sessionId: id,
    audience: scope,
    openedAt: 1000,
    turn: {
      eventId: sequence.toString(16).padStart(64, "0"),
      sequence,
      receivedAt: 1000 + sequence - 1,
      data: {
        sourceIds: [source.id],
        contextSourceIds: [],
        entries: [
          {
            role: "user",
            address,
            author: "U1",
            messageId: `${sequence}.000001`,
            observedAt: 50,
            sourceId: source.id,
            content: { retention: "retained", text },
          },
          {
            role: "assistant",
            address,
            observedAt: 70,
            delivery: "unknown",
            content: {
              retention: "retained",
              text: "I said I would book the violet train.",
            },
          },
        ],
      },
    },
  };
  store.archiveSessionTurn(input, store.deletionRevision());
  return input;
}

it("keeps archive recall scoped, typed and whole-turn bounded after JSON escaping", (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const first = archive(store);
  const big = archive(store, audience, sessionId, 2, "@".repeat(450));
  const last = archive(
    store,
    audience,
    sessionId,
    3,
    "The last short sentence.",
  );
  archive(store, "foreign", "f".repeat(64));
  const decode = (text: string) => JSON.parse(text.split("\n").at(-1) ?? "");
  const search = recallSessions(store, audience, {
    kind: "sessions",
    query: "violet",
    observedFrom: 60,
    observedTo: 80,
  });
  expect(decode(search.text).sessions).toEqual([
    { id: sessionId, openedAt: 1000, lastReceivedAt: 1002, matchingTurns: 3 },
  ]);
  expect(search.contextSourceIds).toEqual(
    [first, big, last].map((input) =>
      sessionTurnId(sessionId, input.turn.eventId),
    ),
  );
  expect(
    decode(
      recallSessions(store, audience, {
        kind: "sessions",
        query: "violet",
        observedFrom: 80,
      }).text,
    ).sessions,
  ).toEqual([]);
  expect(
    recallSessions(store, audience, {
      kind: "session",
      sessionId: "f".repeat(64),
    }),
  ).toEqual(
    recallSessions(store, audience, {
      kind: "session",
      sessionId: "e".repeat(64),
    }),
  );
  const page1 = recallSessions(store, audience, { kind: "session", sessionId });
  expect(
    decode(page1.text).turns.map((turn: { sequence: number }) => turn.sequence),
  ).toEqual([1]);
  expect(decode(page1.text).nextAfter).toBe(1);
  const page2 = recallSessions(store, audience, {
    kind: "session",
    sessionId,
    afterSequence: 1,
  });
  expect(page2.text.split("\n").at(-1)?.length).toBeLessThanOrEqual(3000);
  expect(
    decode(page2.text).turns.map((turn: { sequence: number }) => turn.sequence),
  ).toEqual([3]);
  expect(decode(page2.text).omitted).toBe(1);
  expect(decode(page2.text).nextAfter).toBeUndefined();
  expect(page2.text).not.toContain("\\u0040");

  for (const recall of [
    { kind: "sessions", query: "", observedFrom: 80, observedTo: 80 },
    { kind: "sessions", query: "", audience: "foreign" },
    { kind: "session", sessionId, afterSequence: -1 },
    { kind: "session", sessionId, afterSequence: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "session", sessionId: "not-an-id" },
  ])
    expect(() =>
      parseReply(JSON.stringify({ text: "", recall }), [], {
        recallAvailable: true,
      }),
    ).toThrow();
  expect(() =>
    parseReply(
      JSON.stringify({ text: "", recall: { kind: "session", sessionId } }),
      [],
    ),
  ).toThrow();
  expect(
    parseReply(
      JSON.stringify({
        text: "",
        recall: { kind: "session", sessionId, afterSequence: null },
      }),
      [],
      { recallAvailable: true },
    ).recall,
  ).toEqual({ kind: "session", sessionId });
});

it("recalls attributed archives inside the real worker and suppresses completion after deletion", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const original = archive(store);
  archive(store, "foreign", "f".repeat(64));
  const gate = Promise.withResolvers<void>();
  t.onTestFinished(() => gate.resolve());
  const sent: OutboundMessage[] = [];
  let held = false;
  let syntheses = 0;
  let cleanupCalls = 0;
  let previewReport = "";
  const report =
    "The owner preferred the violet train. June said she would book it, but that reply's delivery is unknown; it does not prove a booking.";
  const registry = createJuneRegistry({
    owner,
    memory: {
      store,
      source: () => undefined,
      forget: async () => {
        cleanupCalls++;
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
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
    execution: {
      model: {
        async reply(request): Promise<CompanionReply> {
          const latest = request.messages.at(-1)?.content;
          if (latest?.startsWith("preview-"))
            return { text: "", forgetPreview: { sourceId: `${sessionId}:1` } };
          if (latest?.includes("!forget-confirm")) {
            const token = latest.match(/!forget-confirm [a-f0-9]{32}/)?.[0];
            const marker = latest.match(
              /\[Archived turns affected: \d+\]/,
            )?.[0];
            expect(token).toBeDefined();
            expect(marker).toBe("[Archived turns affected: 1]");
            previewReport = `Forgetting this original removes one dependent archive payload, not its receipt.\n${marker}\n${token}`;
            return { text: previewReport };
          }
          if (latest === "recall") {
            expect(request.system).toContain('"kind":"sessions"');
            expect(JSON.stringify(replyJsonSchema([], request))).toContain(
              '"sessions"',
            );
            return parseReply(
              JSON.stringify({
                text: "",
                recall: {
                  kind: "sessions",
                  query: "violet",
                  observedFrom: 60,
                  observedTo: 80,
                },
              }),
              [],
              request,
            );
          }
          if (latest === "pause")
            return { text: "", recall: { kind: "session", sessionId } };
          const json = latest?.split("\n").find((line) => line.startsWith("{"));
          expect(json).toBeDefined();
          const observation = JSON.parse(json ?? "");
          if (observation.kind === "sessions") {
            expect(
              observation.sessions.map((item: { id: string }) => item.id),
            ).toEqual([sessionId]);
            return {
              text: "",
              recall: {
                kind: "session",
                sessionId: observation.sessions[0].id,
              },
            };
          }
          expect(observation.kind).toBe("session");
          expect(observation.turns[0].data.entries).toEqual(
            original.turn.data.entries,
          );
          if (request.messages.some((message) => message.content === "pause")) {
            held = true;
            await gate.promise;
            return { text: "DELETED ARCHIVE MUST NOT ESCAPE" };
          }
          return { text: report };
        },
      },
    },
    model: {
      async reply(request): Promise<CompanionReply> {
        if (request.system.includes("Execution completion")) {
          syntheses++;
          if (request.system.includes('"task":"preview-'))
            return {
              text: request.system.includes('"task":"preview-hidden"')
                ? previewReport.replace(
                    /\[Archived turns affected: \d+\]\n/,
                    "",
                  )
                : previewReport,
            };
          expect(request.system).toContain(report);
          return { text: `Earlier conversation: ${report}` };
        }
        const text = JSON.parse(request.messages.at(-1)?.content ?? "{}").text;
        return {
          text: "Checking the archive.",
          execution: [{ agent: text, action: "run", task: text }],
        };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", owner.id]);
  const receive = (text: string) =>
    june.receive({
      type: "message",
      id: text,
      messageId: text,
      address,
      senderId: "U1",
      occurredAt: Date.now(),
      direct: true,
      text,
      forgetCommandEligible: true,
      metadata: { channelType: "im" },
    } satisfies MessageEvent);
  await receive("recall");
  await expect
    .poll(
      () =>
        sent.some(
          (message) =>
            message.content.type === "text" &&
            message.content.text === `Earlier conversation: ${report}`,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  const state = await june.snapshot();
  const agent = state.agents?.recall;
  expect(agent).toBeDefined();
  const result = await client.execution
    .getOrCreate(executionKey(["private", owner.id], agent ?? ""))
    .result(agent ?? "");
  expect(result?.context?.sourceIds).toEqual([]);
  expect(result?.context?.contextSourceIds).toContain(
    sessionTurnId(sessionId, original.turn.eventId),
  );
  expect(result?.context?.contextSourceIds).toContain(`${sessionId}:1`);
  expect(
    store.independentEvidence(
      sessionTurnId(sessionId, original.turn.eventId),
      audience,
    ),
  ).toEqual([]);
  const texts = () =>
    sent.flatMap((message) =>
      message.content.type === "text" ? [message.content.text] : [],
    );
  await receive("preview-hidden");
  await expect
    .poll(() => texts().some((text) => text.includes("!forget-confirm")), {
      timeout: 15000,
    })
    .toBe(true);
  const hiddenToken = previewReport.match(/!forget-confirm [a-f0-9]{32}/)?.[0];
  expect(hiddenToken).toBeDefined();
  expect(texts().at(-1)).not.toContain("[Archived turns affected:");
  await receive(hiddenToken ?? "");
  await expect
    .poll(() => texts().at(-1), { timeout: 15000 })
    .toContain("That forgetting confirmation is unavailable");
  expect(cleanupCalls).toBe(0);
  expect(store.isDeleted(`${sessionId}:1`)).toBe(false);
  await receive("pause");
  await expect.poll(() => held, { timeout: 15000 }).toBe(true);
  await receive("preview-visible");
  await expect
    .poll(
      () =>
        texts().some((text) => text.includes("[Archived turns affected: 1]")),
      { timeout: 15000 },
    )
    .toBe(true);
  const visibleToken = previewReport.match(/!forget-confirm [a-f0-9]{32}/)?.[0];
  expect(visibleToken).toBeDefined();
  expect(visibleToken).not.toBe(hiddenToken);
  await receive(visibleToken ?? "");
  await expect.poll(() => cleanupCalls, { timeout: 15000 }).toBe(1);
  expect(store.isDeleted(`${sessionId}:1`)).toBe(true);
  gate.resolve();
  const waiting = (await june.snapshot()).agents?.pause;
  expect(waiting).toBeDefined();
  await expect
    .poll(
      async () =>
        (
          await client.execution
            .getOrCreate(executionKey(["private", owner.id], waiting ?? ""))
            .summary()
        ).pending,
      { timeout: 15000 },
    )
    .toBe(0);
  expect(syntheses).toBe(3);
  expect(JSON.stringify(sent)).not.toContain("DELETED ARCHIVE MUST NOT ESCAPE");
  expect(store.retrieveSession(audience, sessionId).turns).toEqual([]);
});
