import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { defaultGlobalPersonality, publicPersonality } from "./personality.js";
import { createJuneRegistry } from "./registry.js";

it("publishes one bounded voice without sharing private explanations or granting guest writes", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const event: MessageEvent = {
    type: "message",
    id: "show",
    messageId: "123.456",
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T1", conversationId: "D1" },
    senderId: "U1",
    direct: true,
    personalityCommandEligible: true,
    metadata: { channelType: "im" },
    text: "!personality",
  };
  const guest = {
    ...event,
    senderId: "U2",
    address: { ...event.address, conversationId: "D2" },
  };
  const channel = {
    ...event,
    direct: false,
    metadata: { channelType: "channel" as const },
    address: { ...event.address, conversationId: "C1" },
  };
  const requests: ModelRequest[] = [];
  const sent: OutboundMessage[] = [];
  const proposal =
    '!personality revise {"expectedVersion":0,"changes":{"tone":"dry","verbosity":"concise"},"explanation":"PRIVATE reason","publish":true}';
  let modelReply: string | undefined;
  const registry = createJuneRegistry({
    owner,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(outbound) {
          sent.push(JSON.parse(JSON.stringify(outbound)));
          return { status: "sent", messageId: "out" };
        },
      },
    },
    model: {
      async reply(request) {
        requests.push(structuredClone(request));
        return {
          text:
            modelReply ??
            (request.system.includes('"version":0,"style"')
              ? proposal
              : "Shared voice."),
        };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const profile = client.personality.getOrCreate([owner.id]);
  expect(await profile.pending(event)).toContain("curated memory is disabled");
  const send = async (source: MessageEvent, id: string, text: string) => {
    const next = { ...source, id, messageId: id, text };
    const key = routeEvent(next, owner)?.key;
    if (!key) throw new Error("Invalid fixture route");
    const june = client.conversation.getOrCreate(key);
    await june.send("inbox", { type: "event", event: next });
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).some(
            (r) => r.event.id === id && r.done,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
  };

  await send(event, "ask-proposal", "Suggest a drier voice.");
  expect(requests[0]?.system).toContain(
    "offer an exact !personality revise command",
  );
  const initial = { kind: "default", originVersion: 0, appliedVersion: 0 };
  expect(await profile.read()).toMatchObject({
    version: 0, // Model text is NOT a write.
    provenance: {
      tone: initial,
      verbosity: initial,
      humor: initial,
      curiosity: initial,
    },
  });
  expect(sent.at(-1)?.content).toEqual({ type: "text", text: proposal });
  await send(event, "publish", proposal);
  const published = await profile.read();
  expect(published).toMatchObject({
    version: 1,
    style: {
      tone: "dry",
      verbosity: "concise",
      humor: "subtle",
      curiosity: "occasional",
    },
  });
  const publication = {
    kind: "owner-publication",
    originVersion: 1,
    appliedVersion: 1,
  };
  expect(published.provenance).toEqual({
    tone: publication,
    verbosity: publication,
    humor: initial,
    curiosity: initial,
  });
  for (const source of [event, guest, channel]) {
    const shown = await profile.command({
      ...source,
      text: "!personality show",
    });
    expect(JSON.parse(shown.split("\n\n")[0] ?? "")).toEqual(published);
    expect(shown).not.toContain("PRIVATE");
  }
  expect(JSON.stringify(published)).not.toContain("PRIVATE");
  expect(
    await profile.command({ ...event, id: "publish", text: proposal }),
  ).toContain("already saved");
  expect(
    await profile.command({ ...event, id: "stale", text: proposal }),
  ).toContain("nothing was overwritten");

  for (const source of [
    guest,
    channel,
    { ...event, metadata: undefined },
    { ...event, personalityCommandEligible: undefined },
    { ...event, personalityCommandEligible: false },
    { ...event, address: { ...event.address, accountId: "T-other" } },
  ]) {
    expect(
      await profile.command({
        ...source,
        id: "forged",
        text: proposal.replace('"expectedVersion":0', '"expectedVersion":1'),
      }),
    ).not.toContain("Saved global");
    expect(
      await profile.command({
        ...source,
        id: "forged-reset",
        text: '!personality reset {"expectedVersion":1,"trait":"tone","explanation":"Reset","publish":true}',
      }),
    ).not.toContain("Saved global");
    expect(
      await profile.command({ ...source, text: "!personality history" }),
    ).not.toContain("PRIVATE reason");
  }
  for (const changes of [
    { tone: "PRIVATE evidence" },
    { authority: "all-tools" },
    { tone: "dry", scope: "guest" },
  ]) {
    expect(
      await profile.command({
        ...event,
        id: "invalid",
        text: `!personality revise ${JSON.stringify({ expectedVersion: 1, changes, explanation: "reject", publish: true })}`,
      }),
    ).toContain("Invalid personality revision");
  }
  expect((await profile.read()).version).toBe(1);
  await send(event, "history", "!personality history");
  expect(sent.at(-1)?.content).toMatchObject({
    text: expect.stringContaining("PRIVATE reason"),
  });
  await send(event, "owner-chat", "Describe your voice.");
  await send(guest, "guest-chat", "Describe your voice.");
  await send(channel, "channel-chat", "Describe your voice.");
  for (const request of requests.slice(1)) {
    expect(request.system).toContain(JSON.stringify(published));
    expect(request.system).toContain("Conversation, personality, memory");
    expect(request.system).toContain(
      "This bounded metadata is not evidence recall",
    );
    expect(request.workspaces).toEqual([]);
  }
  for (const request of requests.slice(2)) {
    expect(JSON.stringify(request)).not.toContain("PRIVATE reason");
    expect(request.system).not.toContain(
      "offer an exact !personality revise command",
    );
  }
  await send(guest, "guest-show", "!personality");
  expect(sent.at(-1)?.content).toMatchObject({
    text: expect.stringContaining(JSON.stringify(published)),
  });
  await send(guest, "guest-reject", proposal);
  expect(sent.at(-1)?.content).toMatchObject({
    text: expect.stringContaining("Only my owner"),
  });
  await send(
    event,
    "rollback",
    '!personality rollback {"expectedVersion":1,"targetVersion":0,"explanation":"Restore","publish":true}',
  );
  expect(await profile.read()).toMatchObject({
    version: 2,
    style: { tone: "warm", verbosity: "balanced" },
    provenance: {
      tone: {
        kind: "rollback",
        originVersion: 0,
        appliedVersion: 2,
        restoredFromVersion: 0,
      },
    },
  });
  expect(
    await profile.command({ ...event, text: "!personality history" }),
  ).toContain("PRIVATE reason");
  // Concurrent linked surfaces cannot both overwrite the same version.
  const results = await Promise.all(
    ["dry", "playful"].map((tone) =>
      profile.command({
        ...event,
        id: tone,
        text: `!personality revise ${JSON.stringify({ expectedVersion: 2, changes: { tone }, explanation: tone, publish: true })}`,
      }),
    ),
  );
  expect(results.filter((r) => r.startsWith("Saved global"))).toHaveLength(1);
  expect(
    results.filter((r) => r.includes("nothing was overwritten")),
  ).toHaveLength(1);
  expect((await profile.read()).version).toBe(3);
  await profile.command({
    ...event,
    id: "unrelated-edit",
    text: '!personality revise {"expectedVersion":3,"changes":{"humor":"none"},"explanation":"PRIVATE evidence reason","publish":true}',
  });
  const unchanged = {
    kind: "rollback",
    originVersion: 0,
    appliedVersion: 2,
    restoredFromVersion: 0,
  };
  expect((await profile.read()).provenance).toEqual({
    tone: { kind: "owner-publication", originVersion: 3, appliedVersion: 3 },
    verbosity: unchanged,
    humor: { kind: "owner-publication", originVersion: 4, appliedVersion: 4 },
    curiosity: unchanged,
  });
  for (const [expectedVersion, targetVersion] of [
    [4, 1],
    [5, 5],
  ]) {
    await profile.command({
      ...event,
      id: `restore-${expectedVersion}`,
      text: `!personality rollback ${JSON.stringify({ expectedVersion, targetVersion, explanation: "PRIVATE correction body", publish: true })}`,
    });
  }
  const restored = await profile.read();
  const restoredDefault = {
    kind: "rollback",
    originVersion: 0,
    appliedVersion: 6,
    restoredFromVersion: 5,
  };
  expect(restored.provenance).toEqual({
    tone: { ...restoredDefault, originVersion: 1 },
    verbosity: { ...restoredDefault, originVersion: 1 },
    humor: restoredDefault,
    curiosity: restoredDefault,
  });
  expect(restored.style).toEqual(published.style);
  expect(JSON.stringify(restored)).not.toContain("PRIVATE");
  await send(channel, "origin-chat", "Which revision gave you this tone?");
  expect(requests.at(-1)?.system).toContain(JSON.stringify(restored));
  expect(JSON.stringify(requests.at(-1))).not.toContain("PRIVATE");

  // All four traits differ from defaults: a whole-profile reset must fail this.
  await profile.command({
    ...event,
    id: "distinct-traits",
    text: '!personality revise {"expectedVersion":6,"changes":{"tone":"direct","verbosity":"concise","humor":"none","curiosity":"eager"},"explanation":"Distinct traits","publish":true}',
  });
  const beforeReset = await profile.read();
  expect(beforeReset.version).toBe(7);
  const historyBeforeReset = (
    await profile.command({ ...event, text: "!personality history" })
  ).split("\nCurrent version:")[0];
  const reset = {
    expectedVersion: 7,
    trait: "humor",
    explanation: "Restore default humor",
    publish: true,
  };
  for (const invalid of [
    { trait: "unknown" },
    { trait: ["humor", "tone"] },
    { publish: false },
    { changes: { tone: "warm" } },
  ]) {
    expect(
      await profile.command({
        ...event,
        id: "invalid-reset",
        text: `!personality reset ${JSON.stringify({ ...reset, ...invalid })}`,
      }),
    ).toContain("Invalid personality revision");
  }
  modelReply = `!personality reset ${JSON.stringify(reset)}`;
  await send(event, "ask-reset", "Reset only your humor to its default.");
  expect(requests.at(-1)?.system).toContain("Reset just one named trait");
  expect(requests.at(-1)?.system).toContain("!personality reset");
  expect(sent.at(-1)?.content).toEqual({ type: "text", text: modelReply });
  expect(await profile.read()).toEqual(beforeReset); // Proposal is not approval.

  await send(event, "reset-humor", modelReply);
  const afterReset = await profile.read();
  expect(afterReset.version).toBe(8);
  expect(afterReset.style).toEqual({
    tone: "direct",
    verbosity: "concise",
    humor: "subtle",
    curiosity: "eager",
  });
  expect(afterReset.provenance).toEqual({
    ...beforeReset.provenance,
    humor: { kind: "owner-publication", originVersion: 8, appliedVersion: 8 },
  });
  // The pre-reset page is unchanged below the new revision's stable boundary.
  expect(
    await profile.command({ ...event, text: "!personality history 8" }),
  ).toContain(historyBeforeReset);
  expect(
    await profile.command({ ...event, id: "reset-humor", text: modelReply }),
  ).toContain("already saved");
  expect(
    await profile.command({ ...event, id: "stale-reset", text: modelReply }),
  ).toContain("nothing was overwritten");
  expect(await profile.read()).toEqual(afterReset);
  modelReply = undefined;
  await send(guest, "guest-after-reset", "Describe your voice.");
  expect(requests.at(-1)?.system).toContain(JSON.stringify(afterReset));
  await profile.command({
    ...event,
    id: "restore-before-reset",
    text: '!personality rollback {"expectedVersion":8,"targetVersion":1,"explanation":"Original revision remains available","publish":true}',
  });
  expect(await profile.read()).toMatchObject({
    version: 9,
    style: published.style,
  });
});

it("projects only bounded provenance and leaves legacy origins unknown", () => {
  const legacy = {
    ...defaultGlobalPersonality,
    explanation: "PRIVATE reason",
    correction: { body: "PRIVATE correction" },
    evidenceIds: ["PRIVATE source"],
  };
  expect(publicPersonality(legacy)).not.toHaveProperty("provenance");
  expect(JSON.stringify(publicPersonality(legacy))).not.toContain("PRIVATE");
  const provenance = Object.fromEntries(
    ["tone", "verbosity", "humor", "curiosity"].map((trait) => [
      trait,
      { kind: "default", originVersion: 0, appliedVersion: 0 },
    ]),
  );
  for (const extra of [
    { explanation: "PRIVATE" },
    { evidenceIds: ["PRIVATE"] },
    { kind: "PRIVATE" },
    { originVersion: "PRIVATE" },
    { appliedVersion: -1 },
  ]) {
    expect(() =>
      publicPersonality(
        JSON.parse(
          JSON.stringify({
            ...legacy,
            provenance: {
              ...provenance,
              tone: { ...provenance.tone, ...extra },
            },
          }),
        ),
      ),
    ).toThrow();
  }
});
