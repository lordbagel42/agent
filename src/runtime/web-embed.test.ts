import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent, OutboundMessage } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { parseReply } from "../models/provider.js";
import { currentExecutionCapabilities } from "./execution-context.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";

it.for([false, true])(
  "delivers an owner embed once through durable delivery (worker=%s), and blocks guests",
  async (worker, t) => {
    const sent: OutboundMessage[] = [];
    const origins = ["https://demo.example.org"];
    const embed = {
      url: "https://demo.example.org/view",
      thumbnailUrl: "https://demo.example.org/thumb.png",
      title: "Public demo",
    };
    const owner = {
      id: "owner",
      identities: [
        { channel: "slack" as const, accountId: "T1", senderId: "U1" },
      ],
    };
    let workerTurns = 0;
    const deps: Dependencies = {
      owner,
      channels: {
        slack: {
          channel: "slack",
          capabilities: { text: true, reactions: true, threads: true },
          webEmbedOrigins: origins,
          async receive() {
            return { response: new Response(), events: [] };
          },
          async send(message) {
            sent.push(message);
            return { status: "sent", messageId: "out" };
          },
        },
      },
      model: {
        async reply(request) {
          if (worker && request.executionAvailable)
            return {
              text: "",
              execution: [
                {
                  agent: "preview",
                  action: "run",
                  task: "Show the public demo using webEmbed",
                },
              ],
            };
          if (worker && request.agentRole === "interaction")
            return { text: "Preview delivery was accepted." };
          // Bypass parsing deliberately: host must reject forged guest directives.
          return { text: "", webEmbed: embed };
        },
      },
      ...(worker
        ? ({
            execution: {
              model: {
                async reply(request) {
                  workerTurns++;
                  if (workerTurns === 1) {
                    expect(request.webEmbedOrigins).toEqual(origins);
                    return parseReply(
                      JSON.stringify({ text: "", webEmbed: embed }),
                      [],
                      request,
                    );
                  }
                  expect(request.webEmbedAvailable).not.toBe(true);
                  expect(
                    request.messages.some((message) =>
                      message.content.includes(
                        "Host-only private delivery sent",
                      ),
                    ),
                  ).toBe(true);
                  return {
                    text: "Preview delivery was accepted; rendering is unverified.",
                  };
                },
              },
            },
          } satisfies Partial<Dependencies>)
        : {}),
    };
    const { client } = await setupTest(t, createJuneRegistry(deps));
    const event: MessageEvent = {
      type: "message",
      id: "embed",
      messageId: "embed",
      occurredAt: Date.now(),
      address: { channel: "slack", accountId: "T1", conversationId: "D1" },
      direct: true,
      senderId: "U1",
      metadata: { channelType: "im" },
      text: "Show the public demo",
    };
    const actor = client.conversation.getOrCreate(["private", "owner"]);
    await actor.send("inbox", { type: "event", event });
    const embeds = () =>
      sent.filter(
        (message) =>
          message.content.type === "text" && message.content.webEmbed,
      );
    await expect.poll(() => embeds().length, { timeout: 15000 }).toBe(1);
    expect(embeds()[0]?.content).toMatchObject({
      webEmbed: embed,
      text: "Public demo\nhttps://demo.example.org/view",
    });
    await actor.send("inbox", { type: "event", event });
    const guest = { ...event, id: "guest", messageId: "guest", senderId: "U2" };
    const guestScope = routeEvent(guest, owner);
    if (!guestScope) throw new Error("Missing guest route");
    const guestActor = client.conversation.getOrCreate(guestScope.key);
    await guestActor.send("inbox", { type: "event", event: guest });
    await expect
      .poll(async () =>
        Object.values((await guestActor.snapshot()).events).some(
          (record) => record.event.id === "guest" && record.done,
        ),
      )
      .toBe(true);
    expect(embeds()).toHaveLength(1);
    expect(
      currentExecutionCapabilities(deps, event, {
        webEmbedAvailable: true,
        webEmbedOrigins: ["https://other.example.org"],
      }),
    ).toMatchObject({ webEmbedOrigins: [], webEmbedAvailable: false });
    if (worker) await expect.poll(() => workerTurns).toBe(2);
  },
);
