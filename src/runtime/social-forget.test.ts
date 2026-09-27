import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import type {
  ChannelAdapter,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
  Owner,
} from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { RAYGEN_SLACK_ID } from "../core/social.js";
import { createMemoryRoutes } from "../http/memory.js";
import { slackSource } from "../imports/index.js";
import { EvidenceStore } from "../memory/store.js";
import { createJuneRegistry } from "./registry.js";
import { SocialPermissions } from "./social.js";

const owner: Owner = {
  id: "raygen",
  identities: [
    { channel: "slack", accountId: "T1", senderId: RAYGEN_SLACK_ID },
  ],
};
const scope = JSON.stringify(["private", owner.id]);
const secret = "synthetic forgotten orchid 731";
const retained = "unrelated retained birch 942";
const event: MessageEvent = {
  type: "message",
  id: "owner",
  messageId: "123.000001",
  occurredAt: Date.now(),
  direct: true,
  senderId: RAYGEN_SLACK_ID,
  text: "share the orchid",
  address: { channel: "slack", accountId: "T1", conversationId: "DOWNER" },
};
const guest: MessageEvent = {
  ...event,
  id: "guest",
  messageId: "123.000002",
  direct: false,
  botMentioned: true,
  metadata: { channelType: "channel" },
  senderId: "UGUEST",
  text: "What was shared?",
  address: { ...event.address, conversationId: "C1" },
};
const access = {
  kind: "request_access" as const,
  userId: "UGUEST",
  conversationId: "C1",
  topic: secret,
  sharedContext: secret,
  tools: ["webSearch" as const],
  via: "dm" as const,
};
const source = (message: MessageEvent, audience: string) =>
  slackSource({
    workspace: "T1",
    channel: message.address.conversationId,
    ts: message.messageId,
    author: message.senderId,
    text: message.text,
    workspaceUrl: "https://fixture.slack.com/",
    audiences: [audience],
  });

function fixture(t: { onTestFinished(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "social-forget-"));
  const store = new EvidenceStore(
    join(root, "evidence.sqlite"),
    randomBytes(32),
  );
  const evidence = source(
    { ...event, text: secret, messageId: "100.000001" },
    scope,
  );
  store.appendSource(evidence);
  store.appendSource(
    source({ ...event, text: retained, messageId: "100.000002" }, scope),
  );
  const sent: OutboundMessage[] = [];
  const slack: ChannelAdapter = {
    channel: "slack",
    capabilities: { text: true, threads: true, reactions: true },
    async receive() {
      return { response: new Response(), events: [] };
    },
    async send(message) {
      sent.push(JSON.parse(JSON.stringify(message)));
      return { status: "sent", messageId: "out" };
    },
  };
  const options = {
    file: join(root, "social.sqlite"),
    owner,
    teamId: "T1",
    botUserId: "UBOT",
    slack,
    deletionRevision: () => store.deletionRevision(),
  };
  const social = new SocialPermissions(options);
  t.onTestFinished(() => {
    social.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { social, store, evidence, sent, slack, options };
}

it.for([false, true])(
  "forgets owner and guest projections/history with platform context=$0, retaining fresh input and independent evidence",
  async (platformContext, t) => {
    const { social, store, evidence, sent, slack } = fixture(t);
    const requests: ModelRequest[] = [];
    const extracted: string[] = [];
    if (platformContext)
      slack.context = async (current) => {
        const { type: _type, text, ...origin } = current;
        return [
          {
            role: "assistant",
            content: secret,
            source: {
              ...origin,
              id: "copied-slack-reply",
              messageId: "101.000001",
              senderId: "UBOT",
            },
          },
          { role: "user", content: text, source: origin },
        ];
      };
    const registry = createJuneRegistry({
      owner,
      social,
      memory: {
        store,
        source,
        async extract(_scope, ids) {
          extracted.push(...ids);
        },
      },
      channels: { slack },
      model: {
        async reply(request) {
          requests.push(structuredClone(request));
          return requests.length === 1
            ? { text: "", social: access }
            : {
                text: request.system.includes(secret) ? secret : "clean reply",
              };
        },
      },
    });
    const { client } = await setupTest(t, registry);
    const ownerActor = client.conversation.getOrCreate(["private", owner.id]);
    const guestActor = client.conversation.getOrCreate(
      routeEvent(guest, owner)?.key ?? [],
    );
    await ownerActor.send("inbox", { type: "event", event });
    await expect.poll(() => sent.length).toBe(2);
    const id = social.view(event).match(/[a-f0-9]{24}/)?.[0];
    await social.decide({ ...event, text: `!allow ${id}` });
    await guestActor.send("inbox", { type: "event", event: guest });
    await expect.poll(() => sent.length).toBe(3);
    expect(requests[1]?.system).toContain(secret);
    await expect
      .poll(async () => JSON.stringify((await guestActor.snapshot()).history))
      .toContain(secret);
    const pending = await social.propose(
      { ...event, id: "outreach" },
      { kind: "outreach", userId: "UOTHER", text: secret },
    );
    const outreachId = pending.match(/[a-f0-9]{24}/)?.[0];
    const routes = createMemoryRoutes({
      store,
      audience: () => scope,
      async forget(_scope, id) {
        social.forget();
        await ownerActor.forget(id);
      },
    });
    const response = await routes.request("/forget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: evidence.id, confirmed: true }),
    });
    expect(response.status).toBe(200);
    expect(
      await social.decide({ ...event, text: `!allow ${outreachId}` }),
    ).toContain("revoked");
    expect(social.view(event)).not.toContain(secret);
    expect(social.view(guest)).not.toContain(secret);
    await ownerActor.send("inbox", {
      type: "event",
      event: {
        ...event,
        id: "after",
        messageId: "124.000001",
        text: "birch",
      },
    });
    await expect.poll(() => requests.length).toBe(3);
    await guestActor.send("inbox", {
      type: "event",
      event: { ...guest, id: "guest-after", messageId: "124.000002" },
    });
    await expect.poll(() => requests.length).toBe(4);
    expect(JSON.stringify(requests.slice(2))).not.toContain(secret);
    expect(JSON.stringify(requests[2]?.messages)).toContain("birch");
    expect(JSON.stringify(requests[3]?.messages)).toContain(guest.text);
    expect(requests[2]?.system).toContain(retained);
    expect(
      store.retrieve(scope, "birch").sources.some((s) => s.text === retained),
    ).toBe(true);
    await expect.poll(() => extracted).toContain("slack:T1:DOWNER:124.000001");
    await ownerActor.send("inbox", {
      type: "event",
      event: {
        ...event,
        id: "second-after",
        messageId: "125.000001",
        text: "fresh owner followup",
      },
    });
    await expect.poll(() => requests.length).toBe(5);
    await guestActor.send("inbox", {
      type: "event",
      event: {
        ...guest,
        id: "second-guest-after",
        messageId: "125.000002",
        text: "fresh guest followup",
      },
    });
    await expect.poll(() => requests.length).toBe(6);
    expect(JSON.stringify(requests.slice(2))).not.toContain(secret);
    expect(JSON.stringify(requests[4]?.messages)).toContain(
      "fresh owner followup",
    );
    expect(JSON.stringify(requests[5]?.messages)).toContain(
      "fresh guest followup",
    );
    expect(JSON.stringify((await ownerActor.snapshot()).history)).toContain(
      "fresh owner followup",
    );
    expect(JSON.stringify((await guestActor.snapshot()).history)).toContain(
      "fresh guest followup",
    );
    await expect.poll(() => extracted).toContain("slack:T1:DOWNER:125.000001");
  },
);

it("reconciles legacy social copies after a tombstone/callback crash and preserves dedupe across restart", async (t) => {
  const { social, store, evidence, sent, options } = fixture(t);
  const pending = await social.propose(event, access);
  const id = pending.match(/[a-f0-9]{24}/)?.[0];
  await social.decide({ ...event, text: `!allow ${id}` });
  await social.propose(
    { ...event, id: "outreach" },
    { kind: "outreach", userId: "UOTHER", text: secret },
  );
  await social.propose(
    { ...event, id: "post" },
    { kind: "post", conversationId: "C2", threadId: null, text: secret },
  );
  const db = new DatabaseSync(options.file);
  db.exec("DROP TABLE social_privacy"); // pre-upgrade ledger, no provenance
  store.deleteSource(evidence.id); // process dies before host callback
  const reopened = new SocialPermissions(options);
  try {
    expect(reopened.view(event)).not.toContain(secret);
    expect(reopened.view(guest)).toBe("[]");
    expect(
      JSON.stringify(db.prepare("SELECT * FROM social_proposals").all()),
    ).not.toContain(secret);
    expect(
      JSON.stringify(db.prepare("SELECT * FROM social_deliveries").all()),
    ).not.toContain(secret);
    const count = sent.length;
    await reopened.propose(event, access);
    await reopened.propose(
      { ...event, id: "post" },
      { kind: "post", conversationId: "C2", threadId: null, text: secret },
    );
    expect(sent).toHaveLength(count);
    const fresh = await reopened.propose(
      { ...event, id: "fresh" },
      { ...access, topic: retained, sharedContext: retained },
    );
    await reopened.decide({
      ...event,
      text: `!allow ${fresh.match(/[a-f0-9]{24}/)?.[0]}`,
    });
    expect(reopened.view(guest)).toContain(retained);
    const requests: ModelRequest[] = [];
    const registry = createJuneRegistry({
      owner,
      social: reopened,
      memory: { store, source },
      channels: {
        slack: {
          ...options.slack,
          async context(current) {
            const { type: _type, text: _text, ...origin } = current;
            return [
              {
                role: "assistant",
                content: secret,
                source: {
                  ...origin,
                  id: "old-copy",
                  messageId: "101.000002",
                  senderId: "UBOT",
                },
              },
            ];
          },
        },
      },
      model: {
        async reply(request) {
          requests.push(structuredClone(request));
          return { text: "" };
        },
      },
    });
    const { client } = await setupTest(t, registry);
    for (const current of [event, guest]) {
      const actor = client.conversation.getOrCreate(
        routeEvent(current, owner)?.key ?? [],
      );
      await actor.send("inbox", {
        type: "event",
        event: { ...current, id: `restart-${current.id}`, text: "birch" },
      });
      await expect
        .poll(
          async () =>
            Object.values((await actor.snapshot()).events).filter(
              (row) => row.done,
            ).length,
        )
        .toBe(1);
    }
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain(secret);
    expect(requests[0]?.system).toContain(retained);
  } finally {
    reopened.close();
    db.close();
  }
});

it.for(["before-dispatch", "during-send"] as const)(
  "blocks forgotten outreach $0 and cannot restore a late delivery payload",
  async (when, t) => {
    const { social, store, evidence, slack, sent, options } = fixture(t);
    const pending = await social.propose(event, {
      kind: "outreach",
      userId: "UOTHER",
      text: secret,
    });
    const id = pending.match(/[a-f0-9]{24}/)?.[0];
    const finish = Promise.withResolvers<{
      status: "sent";
      messageId: string;
    }>();
    t.onTestFinished(() =>
      finish.resolve({ status: "sent", messageId: "late" }),
    );
    slack.send = async (message) => {
      sent.push(structuredClone(message));
      return finish.promise;
    };
    const decision = social.decide({ ...event, text: `!allow ${id}` });
    if (when === "during-send") await expect.poll(() => sent.length).toBe(2);
    store.deleteSource(evidence.id);
    social.forget();
    finish.resolve({ status: "sent", messageId: "late" });
    await decision;
    expect(sent).toHaveLength(when === "during-send" ? 2 : 1);
    expect(await social.decide({ ...event, text: `!allow ${id}` })).toContain(
      "revoked",
    );
    const db = new DatabaseSync(options.file);
    try {
      const rows = db.prepare("SELECT value FROM social_deliveries").all();
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toContain(secret);
      expect(JSON.parse(String(rows[1]?.value)).result.code).toBe("forgotten");
    } finally {
      db.close();
    }
  },
);
