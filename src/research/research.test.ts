import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelProvider,
  OutboundMessage,
} from "../core/contracts.js";
import { EvidenceStore } from "../memory/store.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { createLifecycle } from "../runtime/lifecycle.js";
import { createJuneRegistry, type Dependencies } from "../runtime/registry.js";

const start = {
  action: "start",
  id: null,
  goal: "Find public museum opening hours with official source URLs.",
  connections: ["public-search"],
  intervalMinutes: null,
  dailyBatches: null,
  offset: 0,
} satisfies NonNullable<CompanionReply["research"]>;

it("admits research management only under its capability, never as mixed work", () => {
  const reply = { text: "", research: start };
  const capabilities = {
    agentRole: "execution" as const,
    researchAvailable: true,
  };
  expect(parseReply(JSON.stringify(reply), [], capabilities)).toEqual(reply);
  expect(replyJsonSchema([], capabilities).properties).toHaveProperty(
    "research",
  );
  expect(() => parseReply(JSON.stringify(reply), [])).toThrow();
  expect(() =>
    parseReply(JSON.stringify(reply), [], {
      ...capabilities,
      agentRole: "interaction",
    }),
  ).toThrow();
  expect(() =>
    parseReply(JSON.stringify({ ...reply, webSearch: "another task" }), [], {
      ...capabilities,
      webSearchAvailable: true,
    }),
  ).toThrow();
});

const owner = {
  id: "owner",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const event: MessageEvent = {
  type: "message",
  id: "research-request",
  messageId: "1.001",
  occurredAt: 1000,
  senderId: "U1",
  direct: true,
  text: "Private initiating conversation must not be copied into batch prompts.",
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  metadata: { channelType: "im" },
};
const command = (
  action: "list" | "inspect" | "pause" | "resume" | "stop",
  id: string | null,
) => ({
  ...start,
  action,
  id,
  goal: null,
  connections: [],
});
const settled = (reply: ModelProvider["reply"]): ModelProvider => ({
  reply,
  beginReply(...args) {
    const answer = reply(...args);
    return {
      answer,
      settlement: answer.then(
        () => "confirmed_stopped" as const,
        () => "confirmed_stopped" as const,
      ),
    };
  },
});

it("isolates admitted research management and evidence by original sender and conversation", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const audiences: string[] = [];
  const registry = createJuneRegistry({
    owner,
    channels: {},
    memory: {
      store,
      source: (_source, audience) => {
        audiences.push(audience);
        return undefined;
      },
    },
    model: { reply: async () => ({ text: "" }) },
    research: {
      model: settled(async () => ({
        text: '{"checkpoint":"done","done":true,"findings":[]}',
      })),
    },
  });
  const { client } = await setupTest(t, registry);
  const library = client.researchLibrary.getOrCreate([owner.id]);
  const channel: MessageEvent = {
    ...event,
    senderId: "guest",
    direct: false,
    botMentioned: true,
    metadata: { channelType: "channel" },
    address: { ...event.address, conversationId: "C1", threadId: "thread" },
  };
  const dm: MessageEvent = {
    ...event,
    senderId: "guest",
    address: { ...event.address, conversationId: "D2" },
  };
  const sources = [
    event,
    { ...event, address: { ...event.address, conversationId: "D3" } },
    channel,
    dm,
    {
      ...channel,
      botMentioned: false,
      questionAnswered: true,
      address: { ...channel.address, conversationId: "C2" },
    },
  ];
  const ids: string[] = [];
  for (const [i, source] of sources.entries()) {
    const accepted = JSON.parse(
      await library.manage(source, `start-${i}`, start, 0, [`evidence-${i}`]),
    );
    expect(accepted.status).toBe("accepted");
    ids.push(accepted.id);
    const own = JSON.parse(
      await library.manage(source, "list", command("list", null), 0),
    );
    expect(own.sessions.map((s: { id: string }) => s.id)).toEqual([
      accepted.id,
    ]);
    expect(own.evidenceIds).toEqual([`evidence-${i}`]);
    for (const other of [
      { ...source, senderId: "someone-else" },
      {
        ...source,
        address: { ...source.address, conversationId: "elsewhere" },
      },
      { ...source, address: { ...source.address, threadId: "other-thread" } },
    ]) {
      expect(
        JSON.parse(
          await library.manage(other, "list", command("list", null), 0),
        ).sessions,
      ).toEqual([]);
      for (const action of ["inspect", "pause", "resume", "stop"] as const)
        await expect(
          library.manage(other, action, command(action, accepted.id), 0),
        ).rejects.toThrow();
      await expect(
        library.manage(other, `start-${i}`, start, 0),
      ).rejects.toThrow();
    }
    await library.manage(source, "stop", command("stop", accepted.id), 0);
    expect(
      JSON.parse(
        await library.manage(
          source,
          "inspect",
          command("inspect", accepted.id),
          0,
        ),
      ).status,
    ).toBe("stopped");
  }
  expect(new Set(ids).size).toBe(5);
  expect(audiences).toEqual([
    '["private","owner"]',
    '["private","owner"]',
    '["guest","slack","T1","C1","thread","guest"]',
    '["guest","slack","T1","D2","","guest"]',
    '["guest","slack","T1","C2","thread","guest"]',
  ]);
  for (const invalid of [
    { ...channel, botMentioned: false },
    { ...dm, metadata: undefined },
    { ...dm, address: { ...dm.address, accountId: "unconfigured" } },
  ])
    await expect(
      library.manage(invalid, "invalid", start, 0),
    ).rejects.toThrow();
});

it("continues sourced batches, deduplicates findings and preserves quotas through pause and resume", async (t) => {
  let now = 1000;
  let calls = 0;
  const registry = createJuneRegistry({
    owner,
    channels: {},
    mcpAvailable: true,
    model: { reply: async () => ({ text: "" }) },
    research: {
      pollMs: 20,
      now: () => now,
      model: settled(async (request) => {
        calls++;
        expect(request.system).not.toContain(event.text);
        expect(request.mcpReadScope).toEqual({
          connections: ["public-search"],
        });
        expect(request.researchAvailable).not.toBe(true);
        expect(request.messagingAvailable).not.toBe(true);
        expect(request.workspaces).toEqual([]);
        request.onMcpObservation?.(
          "https://museum.example/hours contact@museum.example https://archive.example/visit",
        );
        return {
          text: JSON.stringify({
            checkpoint:
              calls === 1
                ? "Next inspect the archive."
                : "Check nearby collections next.",
            done: false,
            findings:
              calls === 1
                ? [
                    {
                      title: "Museum",
                      detail: "Open Monday",
                      email: "contact@museum.example",
                      url: "https://museum.example/hours",
                    },
                    {
                      title: "Unsupported",
                      detail: "Do not retain a guessed address",
                      email: "invented@museum.example",
                      url: "https://museum.example/hours",
                    },
                    {
                      title: "Substring",
                      detail: "Not an observed email",
                      email: "tact@museum.example",
                      url: "https://museum.example/hours",
                    },
                    {
                      title: "URL prefix",
                      detail: "Not an observed URL",
                      email: null,
                      url: "https://archive.example/vis",
                    },
                  ]
                : [
                    {
                      title: "Museum duplicate",
                      detail: "Same contact",
                      email: "CONTACT@museum.example",
                      url: "https://museum.example/hours",
                    },
                    {
                      title: "Archive",
                      detail: "Open Tuesday",
                      email: null,
                      url: "https://archive.example/visit",
                    },
                  ],
          }),
        };
      }),
    },
  });
  const { client } = await setupTest(t, registry);
  const library = client.researchLibrary.getOrCreate([owner.id]);
  const begin = { ...start, intervalMinutes: 1, dailyBatches: 2 };
  const admitted = JSON.parse(
    await library.manage(event, "start-once", begin, 0),
  );
  const read = async () =>
    JSON.parse(
      await library.manage(
        event,
        "inspect",
        command("inspect", admitted.id),
        0,
      ),
    );
  await expect
    .poll(async () => (await read()).batches, { timeout: 15000 })
    .toBe(1);
  expect(
    JSON.parse(await library.manage(event, "start-once", begin, 0)).id,
  ).toBe(admitted.id);
  const first = await read();
  expect(first.findings).toEqual([
    {
      title: "Museum",
      detail: "Open Monday",
      email: "contact@museum.example",
      url: "https://museum.example/hours",
      observedAt: 1000,
    },
  ]);
  await library.manage(event, "pause", command("pause", admitted.id), 0);
  now += 60_000;
  expect((await read()).status).toBe("paused");
  expect(calls).toBe(1);
  await library.manage(event, "resume", command("resume", admitted.id), 0);
  await expect
    .poll(async () => (await read()).batches, { timeout: 15000 })
    .toBe(2);
  expect(
    (await read()).findings.map((finding: { title: string }) => finding.title),
  ).toEqual(["Museum", "Archive"]);
  now += 60_000;
  await library.manage(event, "pause-two", command("pause", admitted.id), 0);
  await library.manage(event, "resume-two", command("resume", admitted.id), 0);
  await expect.poll(async () => (await read()).reason).toBe("daily_limit");
  expect(calls).toBe(2);
  expect((await read()).nextAt).toBe(86_401_000);
  now = 86_401_000;
  await expect.poll(async () => (await read()).batches).toBe(3);
  expect((await read()).windowUsed).toBe(1);
  await library.manage(event, "stop", command("stop", admitted.id), 0);
  now += 86_400_000;
  expect((await read()).status).toBe("stopped");
  await expect(
    library.manage(event, "revive", command("resume", admitted.id), 0),
  ).rejects.toThrow();
  expect(calls).toBe(3);
  for (const source of [
    { ...event, senderId: "U2" },
    { ...event, direct: false, metadata: { channelType: "channel" as const } },
  ])
    expect(
      JSON.parse(await library.manage(source, "list", command("list", null), 0))
        .sessions,
    ).toEqual([]);
}, 60000);

it("backs off empty batches without shortening a long owner interval", async (t) => {
  let now = 1000;
  const registry = createJuneRegistry({
    owner,
    channels: {},
    model: { reply: async () => ({ text: "" }) },
    research: {
      pollMs: 20,
      now: () => now,
      model: settled(async () => ({
        text: JSON.stringify({
          checkpoint: "Try another source.",
          done: false,
          findings: [],
        }),
      })),
    },
  });
  const { client } = await setupTest(t, registry);
  const library = client.researchLibrary.getOrCreate([owner.id]);
  const { id } = JSON.parse(
    await library.manage(event, "long", { ...start, intervalMinutes: 720 }, 0),
  );
  const read = async () =>
    JSON.parse(await library.manage(event, "read", command("inspect", id), 0));
  await expect.poll(async () => (await read()).batches).toBe(1);
  expect((await read()).nextAt).toBe(43_201_000);
  now = 43_201_000;
  await expect.poll(async () => (await read()).batches).toBe(2);
  await library.manage(event, "stop", command("stop", id), 0);
});

it("pages retained findings without oversized inspection observations", async (t) => {
  let now = 1000;
  let batch = 0;
  const registry = createJuneRegistry({
    owner,
    channels: {},
    model: { reply: async () => ({ text: "" }) },
    research: {
      pollMs: 20,
      now: () => now,
      model: settled(async (request) => {
        batch++;
        const findings = [0, 1].map((i) => ({
          title: `Source ${batch}-${i}`,
          detail: "Official public hours",
          email: null,
          url: `https://museum.example/${batch}/${i}/${"x".repeat(1100)}`,
        }));
        request.onMcpObservation?.(JSON.stringify(findings));
        return {
          text: JSON.stringify({
            checkpoint: "Next source",
            done: batch === 4,
            findings,
          }),
        };
      }),
    },
  });
  const { client } = await setupTest(t, registry);
  const library = client.researchLibrary.getOrCreate([owner.id]);
  const { id } = JSON.parse(
    await library.manage(
      event,
      "pages",
      { ...start, goal: "g".repeat(3000), intervalMinutes: 1 },
      0,
    ),
  );
  const read = (offset = 0) =>
    library.manage(event, "read", { ...command("inspect", id), offset }, 0);
  for (let count = 1; count <= 4; count++) {
    await expect.poll(async () => JSON.parse(await read()).batches).toBe(count);
    now += 60_000;
  }
  let offset: number | null = 0;
  const titles: string[] = [];
  while (offset !== null) {
    const text = await read(offset);
    expect(text.length).toBeLessThanOrEqual(8000);
    const page = JSON.parse(text);
    titles.push(
      ...page.findings.map((finding: { title: string }) => finding.title),
    );
    offset = page.nextOffset;
  }
  expect(titles).toEqual([
    "Source 1-0",
    "Source 1-1",
    "Source 2-0",
    "Source 2-1",
    "Source 3-0",
    "Source 3-1",
    "Source 4-0",
    "Source 4-1",
  ]);
});

it.for([
  "confirmed_stopped",
  "cancelled",
  "unknown",
  "forgotten",
  "unknown_forgotten",
] as const)(
  "withholds late results and blocks resume until settlement: %s",
  async (outcome, t) => {
    const forgotten = outcome.endsWith("forgotten");
    const unknown = outcome.startsWith("unknown");
    const answer = Promise.withResolvers<CompanionReply>();
    const settlement = Promise.withResolvers<"confirmed_stopped" | "unknown">();
    const lifecycle = createLifecycle();
    const store = new EvidenceStore(":memory:", randomBytes(32));
    t.onTestFinished(() => store.close());
    const registry = createJuneRegistry({
      owner,
      channels: {},
      lifecycle,
      memory: { store, source: () => undefined },
      model: { reply: async () => ({ text: "" }) },
      research: {
        pollMs: 20,
        model: {
          reply: async () => {
            throw new Error("Use lifecycle invocation");
          },
          beginReply: (request) => {
            request.onMcpObservation?.(
              "https://museum.example/hours contact@museum.example",
            );
            return { answer: answer.promise, settlement: settlement.promise };
          },
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const library = client.researchLibrary.getOrCreate([owner.id]);
    const { id } = JSON.parse(await library.manage(event, outcome, start, 0));
    const session = client.researchSession.getOrCreate([owner.id, id]);
    await expect
      .poll(() => session.inspect())
      .toMatchObject({ inFlight: true });
    if (forgotten) {
      store.deleteSource("deleted-context");
      await library.invalidate(store.deletionRevision());
    } else {
      await library.manage(event, "pause", command("pause", id), 0);
      await expect(
        library.manage(event, "resume", command("resume", id), 0),
      ).rejects.toThrow();
    }
    if (outcome === "cancelled") answer.reject(new Error("aborted"));
    else
      answer.resolve({
        text: JSON.stringify({
          checkpoint: "late data",
          done: false,
          findings: [
            {
              title: "Museum",
              detail: "Open",
              email: "contact@museum.example",
              url: "https://museum.example/hours",
            },
          ],
        }),
      });
    expect(await lifecycle.drain(50)).toBe(false);
    expect(lifecycle.active).toBe(1);
    settlement.resolve(unknown ? "unknown" : "confirmed_stopped");
    await expect.poll(() => lifecycle.active).toBe(0);
    expect(await lifecycle.drain(50)).toBe(!unknown);
    lifecycle.resume();
    const report = await session.inspect();
    expect(JSON.stringify(report)).not.toContain("late data");
    expect(JSON.stringify(report)).not.toContain("contact@museum.example");
    expect(report.status).toBe(
      forgotten ? "revoked" : unknown ? "needs_review" : "paused",
    );
    await library.recover();
    expect(await library.isSettled()).toBe(!unknown);
    if (unknown && !forgotten)
      await expect(
        library.manage(event, "retry", command("resume", id), 0),
      ).rejects.toThrow();
    else if (!forgotten) {
      expect(report).toMatchObject({ inFlight: false });
      await library.manage(event, "resume-settled", command("resume", id), 0);
      await library.manage(event, "stop", command("stop", id), 0);
    } else {
      expect(
        JSON.parse(
          await library.manage(
            event,
            "list",
            command("list", null),
            store.deletionRevision(),
          ),
        ).sessions,
      ).toEqual([]);
    }
  },
);

it("returns page-matched provenance even when the worker already has many dependencies", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const registry = createJuneRegistry({
    owner,
    channels: {},
    memory: { store, source: () => undefined },
    model: { reply: async () => ({ text: "" }) },
    research: {
      pollMs: 20,
      model: settled(async () => ({
        text: '{"checkpoint":"done","done":true,"findings":[]}',
      })),
    },
  });
  const { client } = await setupTest(t, registry);
  const library = client.researchLibrary.getOrCreate([owner.id]);
  for (let i = 0; i < 6; i++) {
    await library.manage(
      event,
      `start-${i}`,
      { ...start, goal: `Goal ${i}` },
      0,
      Array.from({ length: 80 }, (_, j) => `source-${i}-${j}`),
    );
  }
  const unrelated = Array.from(
    { length: 200 },
    (_, j) => `worker-context-${j}`,
  );
  const first = JSON.parse(
    await library.manage(event, "list", command("list", null), 0, unrelated),
  );
  expect(first.sessions.map((s: { goal: string }) => s.goal)).toEqual([
    "Goal 0",
    "Goal 1",
    "Goal 2",
    "Goal 3",
    "Goal 4",
  ]);
  expect(first.evidenceIds).toHaveLength(400);
  expect(first.evidenceIds).toContain("source-4-79");
  expect(first.evidenceIds).not.toContain("source-5-0");
  const last = JSON.parse(
    await library.manage(
      event,
      "last",
      { ...command("list", null), offset: first.nextOffset },
      0,
      unrelated,
    ),
  );
  expect(last.evidenceIds).toHaveLength(80);
  expect(last.sessions[0].goal).toBe("Goal 5");
  expect(last.evidenceIds).toContain("source-5-0");
});

it("suspends rather than revokes retained sessions when research is disabled", async (t) => {
  let calls = 0;
  const research = {
    pollMs: 20,
    model: settled(async () => {
      calls++;
      return {
        text: '{"checkpoint":"Next source","done":false,"findings":[]}',
      };
    }),
  };
  const deps: Dependencies = {
    owner,
    channels: {},
    model: { reply: async () => ({ text: "" }) },
    research,
  };
  const { client } = await setupTest(t, createJuneRegistry(deps));
  const library = client.researchLibrary.getOrCreate([owner.id]);
  const { id } = JSON.parse(await library.manage(event, "enable", start, 0));
  const session = client.researchSession.getOrCreate([owner.id, id]);
  await expect.poll(() => session.inspect()).toMatchObject({ batches: 1 });
  deps.research = undefined;
  await library.recover();
  await expect
    .poll(() => session.inspect())
    .toMatchObject({ status: "paused", reason: "integration_disabled" });
  deps.research = research;
  await library.recover();
  expect(await session.inspect()).toMatchObject({
    status: "paused",
    checkpoint: "Next source",
  });
  expect(calls).toBe(1);
  await library.manage(event, "stop", command("stop", id), 0);
});

it("forgets research payloads while disabled without erasing unknown IO holds", async (t) => {
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  const deps: Dependencies = {
    owner,
    channels: {},
    memory: { store, source: () => undefined },
    model: { reply: async () => ({ text: "" }) },
    research: {
      pollMs: 20,
      model: { reply: async () => ({ text: "Unconfirmed provider response" }) },
    },
  };
  const registry = createJuneRegistry(deps);
  let snapshot = () => "{}";
  const config = registry.config.use.researchLibrary.config;
  if (!("createVars" in config) || !config.createVars)
    throw new Error("Missing library initialization");
  const createVars = config.createVars;
  config.createVars = (c, input) => {
    snapshot = () => JSON.stringify(c.state);
    return createVars(c, input);
  };
  const { client } = await setupTest(t, registry);
  const library = client.researchLibrary.getOrCreate([owner.id]);
  const { id } = JSON.parse(
    await library.manage(
      event,
      "private",
      { ...start, goal: "Private fixture goal" },
      0,
      ["gone"],
    ),
  );
  const session = client.researchSession.getOrCreate([owner.id, id]);
  await expect
    .poll(() => session.inspect())
    .toMatchObject({ status: "needs_review" });
  expect(snapshot()).toContain("Private fixture goal");
  deps.research = undefined;
  store.deleteSource("gone");
  await client.conversation.getOrCreate(["private", owner.id]).forget("gone");
  expect(JSON.parse(snapshot()).sessions[id]).toBeNull();
  expect(await session.inspect()).toEqual({ status: "revoked" });
  expect(await library.isSettled()).toBe(false);
});

it("lets June delegate private start and inspection without background messages", async (t) => {
  const sent: OutboundMessage[] = [];
  let id: string | undefined;
  const registry = createJuneRegistry({
    owner,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        receive: async () => ({ response: new Response(), events: [] }),
        send: async (message) => {
          sent.push(message);
          return { status: "sent", messageId: String(sent.length) };
        },
      },
    },
    model: {
      reply: async (request) => {
        expect(request.agentRole).toBe("interaction");
        if (request.system.includes("Execution completion")) {
          expect(request.researchAvailable).not.toBe(true);
          return {
            text: request.system.includes("Museum is open")
              ? "Museum is open."
              : "Research admitted privately.",
          };
        }
        return {
          text: "",
          execution: [
            {
              agent: "public-research",
              action: "run",
              task: id ? "inspect" : "start",
            },
          ],
        };
      },
    },
    execution: {
      model: {
        reply: async (request) => {
          const last = request.messages.at(-1)?.content;
          if (last === "start" || last === "inspect") {
            expect(request.researchAvailable).toBe(true);
            return {
              text: "",
              research:
                last === "start" ? start : command("inspect", id ?? null),
            };
          }
          const receipt = last?.match(/\{"id":"([a-f0-9]{64})"/);
          id ??= receipt?.[1];
          return {
            text: last?.includes("Open Monday")
              ? "Museum is open."
              : "Research admitted privately.",
          };
        },
      },
    },
    research: {
      pollMs: 20,
      model: settled(async (request) => {
        request.onMcpObservation?.("https://museum.example/hours");
        return {
          text: JSON.stringify({
            checkpoint: "Finished",
            done: true,
            findings: [
              {
                title: "Museum",
                detail: "Open Monday",
                email: null,
                url: "https://museum.example/hours",
              },
            ],
          }),
        };
      }),
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(["private", owner.id]);
  const texts = () =>
    sent.flatMap((message) =>
      message.content.type === "text" ? [message.content.text] : [],
    );
  await june.send("inbox", { type: "event", event });
  await expect
    .poll(texts, { timeout: 15000 })
    .toEqual(["Research admitted privately."]);
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  await expect
    .poll(
      async () =>
        (
          await client.researchSession
            .getOrCreate([owner.id, id ?? ""])
            .inspect()
        ).status,
    )
    .toBe("completed");
  expect(texts()).toEqual(["Research admitted privately."]);
  await june.send("inbox", {
    type: "event",
    event: {
      ...event,
      id: "inspect-request",
      messageId: "2.001",
      text: "Inspect my private research.",
    },
  });
  await expect
    .poll(texts, { timeout: 15000 })
    .toEqual(["Research admitted privately.", "Museum is open."]);
  expect(sent.every((message) => message.address.conversationId === "D1")).toBe(
    true,
  );
}, 60000);
