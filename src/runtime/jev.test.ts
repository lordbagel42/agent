import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { parseConfig } from "../config.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { createJevObserver } from "../models/jev.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createJuneRegistry } from "./registry.js";

it("admits only owner-private typed observations, minimizes input and never repeats ambiguous calls", async (t) => {
  const owner = {
    id: "fixture",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const config = parseConfig({
    owner,
    model: { protocol: "openai", model: "fixture", apiKeyEnv: "FAKE_KEY" },
    slack: {
      teamId: "T1",
      botUserId: "B1",
      signingSecretEnv: "FAKE_SECRET",
      botTokenEnv: "FAKE_TOKEN",
    },
    jev: {
      endpoint: "https://example.invalid/jev",
      model: "fixture-jev",
      apiKeyEnv: "FAKE_KEY",
      question: {
        type: "choice",
        instructions: "Classify only this input.",
        criteria: {
          yes: "Present",
          no: "Absent",
          unknown: "Insufficient evidence",
        },
        abstainChoice: "unknown",
      },
    },
  });
  const jev = config.jev;
  if (!jev) throw new Error("Missing fixture configuration");
  const sent: string[] = [];
  const requests: ModelRequest[] = [];
  const payloads: unknown[] = [];
  let action: CompanionReply = { text: "", jevObservation: true };
  let failure = false;
  let choice = "unknown";
  let search = false;
  const registry = createJuneRegistry({
    owner,
    model: {
      async reply(request) {
        requests.push(request);
        expect(
          Object.hasOwn(
            replyJsonSchema([], request).properties,
            "jevObservation",
          ),
        ).toBe(request.jevObservationAvailable);
        if (request.jevObservationAvailable) {
          expect(request.system).toContain(jev.question.instructions);
          expect(request.system).toContain("never a juror or synthesizer");
        }
        if (search && request.webSearchAvailable)
          return { text: "", webSearch: "public query" };
        return action; // Host must also check custom providers bypassing parseReply.
      },
    },
    jev: {
      question: jev.question,
      observe: createJevObserver({
        ...jev,
        apiKey: "fake-key",
        questions: { observation: jev.question },
        async fetch(_url, init) {
          payloads.push(JSON.parse(String(init?.body)));
          if (failure) throw new Error("SECRET PROVIDER ERROR");
          return Response.json({
            model: "fixture-jev",
            answers: {
              observation: {
                type: "choice",
                choice,
                probabilities:
                  choice === "unknown"
                    ? { yes: 0.05, no: 0.15, unknown: 0.8 }
                    : { yes: 0.75, no: 0.2, unknown: 0.05 },
                confidence: 0.64,
              },
            },
            usage: {},
          });
        },
      }),
    },
    webSearch: {
      available: true,
      description: "fixture",
      async search() {
        return { status: "ready", results: [] };
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
          if (message.content.type === "text") sent.push(message.content.text);
          return { status: "sent", messageId: `out-${sent.length}` };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  let sequence = 0;
  const deliver = async (extra: Partial<MessageEvent> = {}) => {
    sequence++;
    const event: MessageEvent = {
      id: `in-${sequence}`,
      type: "message",
      messageId: `${sequence}.123`,
      occurredAt: Date.now(),
      senderId: "U1",
      direct: true,
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      text: `Use Jev to observe this message ${sequence}.`,
      ...extra,
    };
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("Invalid fixture scope");
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
        { timeout: 10000 },
      )
      .toBe(done + 1);
    return { actor, event, report: sent.at(-1) ?? "" };
  };
  action = { text: "Earlier private context must not go to Jev." };
  await deliver();
  action = { text: "", jevObservation: true };
  const abstained = await deliver();
  expect(abstained.report).toContain('"status":"abstained"');
  expect(abstained.report).toContain(
    '"value":0.64,"calibration":"uncalibrated"',
  );
  expect(payloads).toEqual([
    {
      model: "fixture-jev",
      state: abstained.event.text,
      questions: {
        observation: {
          type: "choice",
          instructions: "Classify only this input.",
          criteria: {
            yes: "Present",
            no: "Absent",
            unknown: "Insufficient evidence",
          },
        },
      },
    },
  ]);
  choice = "yes";
  expect((await deliver({ text: "é".repeat(2048) })).report).toContain(
    '"choice":"yes"',
  );
  expect(requests).toHaveLength(3); // No synthesis of Jev output.
  for (const extra of [
    { direct: false },
    { senderId: "U2", metadata: { channelType: "im" as const } },
    { text: "é".repeat(2049) },
  ]) {
    expect((await deliver(extra)).report).toContain(
      "require a fresh owner-private",
    );
    expect(requests.at(-1)?.jevObservationAvailable).toBe(false);
  }
  search = true;
  await deliver();
  expect(requests.at(-1)?.usageStage).toBe("synthesis");
  expect(requests.at(-1)?.jevObservationAvailable).toBe(false);
  search = false;
  expect(payloads).toHaveLength(2);
  for (const other of [
    { text: "fabricated verdict" },
    { webSearch: "query" },
    { coding: { workspace: "june", goal: "run" } },
  ])
    expect(() =>
      parseReply(JSON.stringify({ ...action, ...other }), ["june"], {
        jevObservationAvailable: true,
        webSearchAvailable: true,
      }),
    ).toThrow();
  expect(() => parseReply(JSON.stringify(action), [])).toThrow();
  failure = true;
  const failed = await deliver();
  expect(failed.report).toContain('"requestState":"possibly_sent"');
  expect(failed.report).not.toContain("SECRET");
  expect(
    Object.values((await failed.actor.snapshot()).events).find(
      (e) => e.event.id === failed.event.id,
    )?.jevObservation,
  ).toEqual({ status: "unknown", code: "transport" });
  await failed.actor.send("inbox", { type: "event", event: failed.event });
  action = { text: "Next turn flushes the replay." };
  await deliver();
  expect(payloads).toHaveLength(3);
});
