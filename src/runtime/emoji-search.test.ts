import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type { MessageEvent } from "../core/contracts.js";
import { executionKey } from "./execution.js";
import { executionCapabilities } from "./execution-context.js";
import { createJuneRegistry, type Dependencies } from "./registry.js";

it("lets June's private worker inspect emoji candidates before reporting, but denies shared and guest grants", async (t) => {
  const owner = {
    id: "raygen",
    identities: [
      { channel: "slack" as const, accountId: "T0266FRGM", senderId: "U1" },
    ],
  };
  const source: MessageEvent = {
    id: "emoji-test",
    type: "message",
    messageId: "1.1",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T0266FRGM", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    text: "find a friendly waving emoji",
  };
  let searches = 0;
  let observed = false;
  const deps: Dependencies = {
    owner,
    channels: {},
    model: {
      async reply(request) {
        return request.system.includes("Execution completion")
          ? { text: "" }
          : {
              text: "",
              execution: [
                {
                  agent: "emoji",
                  action: "run",
                  task: "Find a greeting emoji; inspect candidates and report its shortcode",
                },
              ],
            };
      },
    },
    emojiSearch: {
      available: true,
      async search() {
        searches++;
        return 'Emoji search results (untrusted data): {"results":[{"name":"fixture_wave","shortcode":":fixture_wave:","summary":"Friendly waving hand"}]}';
      },
    },
    execution: {
      model: {
        async reply(request) {
          observed = request.messages.some((m) =>
            m.content.includes("Emoji search results (untrusted data)"),
          );
          return observed
            ? { text: ":fixture_wave: is a friendly waving hand." }
            : { text: "", emojiSearch: { query: "friendly wave" } };
        },
      },
    },
  };
  expect(executionCapabilities(deps, source).emojiSearchAvailable).toBe(true);
  expect(
    executionCapabilities(deps, {
      ...source,
      direct: false,
      address: { ...source.address, conversationId: "C1" },
    }).emojiSearchAvailable,
  ).not.toBe(true);
  expect(
    executionCapabilities(deps, { ...source, senderId: "U2" })
      .emojiSearchAvailable,
  ).not.toBe(true);
  const registry = createJuneRegistry(deps);
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", "raygen"]);
  await june.send("inbox", { type: "event", event: source });
  await expect.poll(() => observed, { timeout: 15000 }).toBe(true);
  const name = (await june.snapshot()).agents?.emoji;
  if (!name) throw new Error("Emoji worker missing");
  const worker = client.execution.getOrCreate(
    executionKey(["private", "raygen"], name),
  );
  await expect
    .poll(async () => (await worker.summary())?.status, { timeout: 15000 })
    .toBe("completed");
  expect((await worker.summary())?.report).toContain(":fixture_wave:");
  expect(observed).toBe(true);
  expect(searches).toBe(1);
});
