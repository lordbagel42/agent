import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent, ModelRequest } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createJuneRegistry } from "./registry.js";

it("grants sandbox execution separately from other tools and interaction dispatch", () => {
  const reply = {
    text: "",
    javascript: { source: "return 42;", inputJson: "null" },
  };
  const caps = { javascriptAvailable: true };
  expect(parseReply(JSON.stringify(reply), [], caps)).toEqual(reply);
  expect(replyJsonSchema([], caps).properties).toHaveProperty("javascript");
  expect(() => parseReply(JSON.stringify(reply), [])).toThrow();
  expect(() =>
    parseReply(JSON.stringify(reply), [], {
      ...caps,
      agentRole: "interaction",
    }),
  ).toThrow();
  expect(() =>
    parseReply(JSON.stringify({ ...reply, text: "already ran it" }), [], caps),
  ).toThrow();
  expect(() =>
    parseReply(JSON.stringify({ ...reply, webSearch: "anything" }), [], {
      ...caps,
      webSearchAvailable: true,
    }),
  ).toThrow();
});

it.for(["guest", "owner"])(
  "lets %s delegate channel JavaScript without granting unconfigured workflows",
  async (kind, t) => {
    const owner = {
      id: "owner",
      identities: [
        { channel: "slack" as const, accountId: "T1", senderId: "U1" },
      ],
    };
    const sent: string[] = [];
    let observation = "";
    const execute = (request: ModelRequest) => {
      expect(request.javascriptAvailable).toBe(true);
      expect(request.workflowAvailable).toBe(false);
      return parseReply(
        JSON.stringify({
          text: "",
          javascript: {
            source: "console.log('computed'); return input.a - input.b;",
            inputJson: '{"a":19,"b":7}',
          },
        }),
        [],
        request,
      );
    };
    const registry = createJuneRegistry({
      owner,
      model: {
        async reply(request) {
          if (request.executionAvailable)
            return {
              text: "",
              execution: [
                {
                  agent: "calculate",
                  action: "run" as const,
                  task: "Run the submitted JavaScript with input a=19,b=7 and report the observed result.",
                },
              ],
            };
          expect(observation).toContain('"result": "12"');
          return { text: observation };
        },
      },
      execution: {
        model: {
          async reply(request) {
            const result = request.messages.findLast(
              (m) =>
                m.role === "user" &&
                m.content.includes("QuickJS sandbox result"),
            );
            if (result) {
              observation = result.content;
              expect(observation).toContain('"result": "12"');
              return { text: observation };
            }
            return execute(request);
          },
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
            if (message.content.type === "text")
              sent.push(message.content.text);
            return { status: "sent", messageId: `out-${sent.length}` };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const event: MessageEvent = {
      id: `js-${kind}`,
      type: "message",
      messageId: "123.456",
      occurredAt: Date.now(),
      senderId: kind === "guest" ? "U2" : "U1",
      direct: false,
      botMentioned: true,
      metadata: { channelType: "channel" },
      address: { channel: "slack", accountId: "T1", conversationId: "C1" },
      text: "Run this JavaScript: console.log('computed'); return input.a - input.b; with a=19,b=7",
    };
    const scope = routeEvent(event, owner);
    if (!scope) throw new Error("Invalid fixture");
    const actor = client.conversation.getOrCreate(scope.key);
    await actor.send("inbox", { type: "event", event });
    await expect
      .poll(() => sent.join("\n"), { timeout: 15000 })
      .toContain('"result": "12"');
    expect(sent.join("\n")).toContain('"computed"');
    expect(sent.join("\n")).toContain("```json");
  },
);
