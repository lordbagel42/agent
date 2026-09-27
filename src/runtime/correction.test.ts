import { createHmac, randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createSlackAdapter } from "../channels/slack.js";
import type {
  MessageEvent,
  ModelRequest,
  OutboundMessage,
  Owner,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { createHttpApp } from "../http/app.js";
import { slackSource } from "../imports/identity.js";
import { EvidenceStore } from "../memory/store.js";
import { createInspectionReader } from "./inspection.js";
import { createJuneRegistry } from "./registry.js";

it("records only signed live owner-DM corrections, deduplicates receipts, and lets June discover the approval boundary", async (t) => {
  const owner: Owner = {
    id: "owner",
    identities: [{ channel: "slack", accountId: "T1", senderId: "U1" }],
  };
  const audience = JSON.stringify(["private", owner.id]);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const now = Date.now();
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
  const source = (event: MessageEvent, scope: string) =>
    scope === audience
      ? slackSource({
          workspace: event.address.accountId,
          channel: event.address.conversationId,
          ts: event.messageId,
          threadTs: event.address.threadId,
          author: event.senderId,
          text: event.text,
          workspaceUrl: "https://fixture.slack.com/",
          audiences: [scope],
        })
      : undefined;
  const slack = {
    ...createSlackAdapter({
      teamId: "T1",
      botUserId: "B1",
      ownerUserIds: ["U1"],
      signingSecret: "fixture-signing-secret",
      botToken: "unused",
      now: () => now,
    }),
    context: undefined,
    typing: undefined,
    async send(message: OutboundMessage) {
      sent.push(JSON.parse(JSON.stringify(message)));
      return { status: "sent" as const, messageId: "out" };
    },
  };
  const registry = createJuneRegistry({
    owner,
    channels: { slack },
    memory: { store, source },
    inspection: createInspectionReader({
      audience,
      memory: { store },
      selections: {},
    }),
    model: {
      async reply(request) {
        requests.push(request);
        return requests.length === 1
          ? { text: "", inspection: "memory" as const }
          : { text: "!memory-correct tone MODEL FORGERY" };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const submitted: MessageEvent[] = [];
  const app = createHttpApp({
    owner,
    channels: { slack },
    operatorToken: "fixture-only-operator-token-long-enough",
    async submit(scope, event) {
      if (event.type !== "message") return;
      const evidence = source(event, JSON.stringify(scope.key));
      if (evidence) store.appendSource(evidence);
      submitted.push(event);
      await client.conversation
        .getOrCreate(scope.key)
        .send("inbox", { type: "event", event });
    },
    async ready() {
      return true;
    },
    async inspectConversation() {
      return {};
    },
    async inspectJob() {
      return undefined;
    },
    async resumeJob() {
      return false;
    },
  });
  const post = async (
    text: string,
    index: number,
    user = "U1",
    valid = true,
    rich: {
      type?: string;
      text?: string;
      code?: boolean;
      omitBlocks?: boolean;
    } = {},
  ) => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: `callback-${index}`,
      event_time: Math.floor(now / 1000),
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user,
        ts: `${Math.floor(now / 1000)}.${String(index).padStart(6, "0")}`,
        text,
        blocks: rich.omitBlocks
          ? undefined
          : [
              {
                type: "rich_text",
                elements: [
                  {
                    type: rich.type ?? "rich_text_section",
                    elements: [
                      {
                        type: "text",
                        text: rich.text ?? text,
                        style: { code: rich.code ?? false },
                      },
                    ],
                  },
                ],
              },
            ],
      },
    });
    const timestamp = String(Math.floor(now / 1000));
    const signature = createHmac(
      "sha256",
      valid ? "fixture-signing-secret" : "wrong",
    )
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
    return app.request("/webhooks/slack", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${signature}`,
      },
    });
  };
  const settled = async () => {
    const event = submitted.at(-1);
    if (!event) throw new Error("Missing event");
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("Missing scope");
    await expect
      .poll(async () => {
        const snapshot = await client.conversation
          .getOrCreate(scope.key)
          .snapshot();
        return Object.values(snapshot.events).some(
          (record) => record.event.id === event.id && record.done,
        );
      })
      .toBe(true);
  };
  const correction = "!memory-correct verbosity short private replies";
  expect((await post(correction, 1, "U1", false)).status).toBe(401);
  expect(store.search(audience, "").sources).toEqual([]);
  expect((await post(correction, 1)).status).toBe(200);
  await settled();
  expect(requests).toEqual([]);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining(
      "Recorded private owner-correction evidence:",
    ),
  });
  expect((await post(correction, 1)).status).toBe(200);
  // A later turn proves the duplicate has drained, rather than racing the inbox.
  expect((await post("How do I correct your memory?", 2)).status).toBe(200);
  await settled();
  expect(requests[0]?.system).toContain("!memory-correct");
  expect(sent).toHaveLength(2);
  expect(sent[1]?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining("separate owner review"),
  });
  expect((await post(`> ${correction}`, 3)).status).toBe(200);
  await settled();
  expect((await post(correction, 4, "U2")).status).toBe(200);
  await settled();
  expect(sent.at(-1)?.content).toMatchObject({
    type: "text",
    text: "Memory corrections require the configured owner's Slack DM.",
  });
  for (const [index, rich] of [
    { type: "rich_text_quote" },
    { type: "rich_text_preformatted" },
    { type: "rich_text_list" },
    { text: "Not a correction command" },
    { code: true },
  ].entries()) {
    expect((await post(correction, index + 5, "U1", true, rich)).status).toBe(
      200,
    );
    await settled();
    expect(sent.at(-1)?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("Send !memory-correct"),
    });
  }
  expect(
    (
      await post("!memory-correct tone `code`", 10, "U1", true, {
        omitBlocks: true,
      })
    ).status,
  ).toBe(200);
  await settled();
  expect(sent.at(-1)?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining("Send !memory-correct"),
  });
  expect(
    (
      await post("!memory-correct tone gentle", 11, "U1", true, {
        omitBlocks: true,
      })
    ).status,
  ).toBe(200);
  await settled();
  expect(sent.at(-1)?.content).toMatchObject({
    type: "text",
    text: expect.stringContaining("Recorded private owner-correction"),
  });
  const evidence = store.search(audience, "").sources;
  expect(evidence).toHaveLength(10);
  expect(
    store
      .reflectionEvidence(
        audience,
        evidence.map((s) => s.id),
        60000,
      )
      .map((e) => e.source),
  ).toEqual([
    "owner-correction",
    "episode",
    "episode",
    "episode",
    "episode",
    "episode",
    "episode",
    "episode",
    "episode",
    "owner-correction",
  ]);
  expect(store.search("public", "").sources).toEqual([]);
});
