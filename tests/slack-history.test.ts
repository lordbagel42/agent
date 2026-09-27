import { expect, it, vi } from "vitest";
import { createSlackAdapter } from "../src/channels/slack.js";
import type { MessageEvent, ModelRequest } from "../src/core/contracts.js";
import { routeEvent } from "../src/core/routing.js";
import { PRIVATE_SLACK_HISTORY_PREFIX } from "../src/core/slack-history.js";
import { parseReply, replyJsonSchema } from "../src/models/provider.js";
import { createJuneRegistry } from "../src/runtime/registry.js";
import { setupTest } from "./rivet.js";

const owner = {
  id: "raygen",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const event: MessageEvent = {
  type: "message",
  id: "lookup",
  messageId: "1800000000.000100",
  occurredAt: 1_800_000_000_000,
  senderId: "U1",
  direct: false,
  address: {
    channel: "slack",
    accountId: "T1",
    conversationId: "C1",
    threadId: "1800000000.000001",
  },
  text: "Show me your DMs with <@U2>",
  botMentioned: true,
  metadata: { channelType: "channel", threadTs: "1800000000.000001" },
};
const lookup = { target: "<@U2>", threadTs: null, cursor: null };
const secret =
  "PRIVATE_FIXTURE do not put this in public context <@U3> & <!channel>";

function fixture(
  override?: (method: string, body: Record<string, unknown>) => unknown,
) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const posted: Record<string, unknown>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const request = new Request(url, init);
    const method = request.url.split("/").at(-1) ?? "";
    const body = request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(await request.text()))
      : ((await request.json()) as Record<string, unknown>);
    expect(request.headers.get("authorization")).toBe("Bearer bot-fixture");
    calls.push({ method, body });
    const changed = override?.(method, body);
    if (changed !== undefined) return Response.json(changed);
    if (method === "auth.test")
      return Response.json({
        ok: true,
        team_id: "T1",
        user_id: "UBOT",
        bot_id: "B1",
      });
    if (method === "users.list")
      return Response.json({ ok: true, members: [{ id: "U2", name: "alex" }] });
    if (method === "users.info")
      return Response.json({
        ok: true,
        user: { id: body.user, name: body.user },
      });
    if (method === "conversations.list")
      return Response.json({
        ok: true,
        channels: body.cursor
          ? [{ id: "D2", is_im: true, user: "U2" }]
          : [{ id: "D1", is_im: true, user: "U1" }],
        response_metadata: { next_cursor: body.cursor ? "" : "DM_PAGE_2" },
      });
    if (method === "conversations.info")
      return Response.json({
        ok: true,
        channel:
          body.channel === "D1"
            ? { id: "D1", is_im: true, user: "U1" }
            : body.channel === "D2"
              ? { id: "D2", is_im: true, user: "U2" }
              : { id: body.channel, is_channel: true, is_member: true },
      });
    if (
      method === "conversations.history" ||
      method === "conversations.replies"
    )
      return Response.json({
        ok: true,
        has_more: true,
        response_metadata: { next_cursor: "HISTORY_PAGE_2" },
        messages:
          body.channel === "D1"
            ? [{ user: "UBOT", ts: "1799999999.000001", text: posted[0]?.text }]
            : [
                { user: "U2", ts: "1799999999.000002", text: secret },
                {
                  user: "UBOT",
                  ts: "1799999999.000003",
                  text: "June's actual reply",
                },
              ],
      });
    if (method === "chat.postMessage") {
      posted.push(body);
      return Response.json({
        ok: true,
        ts: "1800000001.000001",
        channel: body.channel,
      });
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const adapter = createSlackAdapter({
    teamId: "T1",
    botUserId: "UBOT",
    botToken: "bot-fixture",
    signingSecret: "fixture",
    ownerUserIds: ["U1"],
    contextEnabled: true,
    fetch,
  });
  delete adapter.setTyping;
  return { adapter, calls, posted, fetch };
}

it("rejects other people, workspaces and platforms before any Slack read", async () => {
  const f = fixture();
  for (const input of [
    { ...event, senderId: "U2" },
    { ...event, senderId: "UBOT" },
    { ...event, address: { ...event.address, accountId: "T2" } },
    { ...event, address: { ...event.address, channel: "whatsapp" as const } },
  ]) {
    expect(
      await f.adapter.shareHistory?.(input, lookup, "op", () => true),
    ).toMatchObject({ status: "rejected", code: "history_owner_required" });
  }
  expect(
    await f.adapter.shareHistory?.(event, lookup, "op", () => false),
  ).toMatchObject({ status: "rejected" });
  expect(f.fetch).not.toHaveBeenCalled();
});

it("verifies paginated Enterprise Grid workspace grants and scopes discovery to that workspace", async () => {
  for (const target of ["alex", "D2", "C2"]) {
    const f = fixture((method, body) => {
      if (method === "auth.test")
        return {
          ok: true,
          team_id: "E1",
          enterprise_id: "E1",
          is_enterprise_install: true,
          user_id: "UBOT",
          bot_id: "B1",
        };
      if (method === "auth.teams.list")
        return {
          ok: true,
          teams: [{ id: body.cursor ? "T1" : "T2" }],
          response_metadata: { next_cursor: body.cursor ? "" : "TEAM_PAGE_2" },
        };
      if (
        ["users.list", "conversations.list", "users.conversations"].includes(
          method,
        )
      ) {
        if (body.team_id !== "T1")
          return { ok: false, error: "team_access_not_granted" };
        if (method === "users.conversations")
          return {
            ok: true,
            channels: [{ id: target }],
          };
      }
      return undefined;
    });
    expect(
      await f.adapter.shareHistory?.(
        event,
        { ...lookup, target },
        "op",
        () => true,
      ),
    ).toMatchObject({ status: "sent" });
    expect(f.posted[0]?.channel).toBe("D1");
    expect(f.posted[0]?.text).toContain("PRIVATE_FIXTURE");
    expect(
      f.calls
        .filter((call) => call.method === "auth.teams.list")
        .map((call) => call.body.cursor),
    ).toEqual([undefined, "TEAM_PAGE_2"]);
  }
});

it("rejects enterprise tokens without the configured workspace or workspace-scoped source membership", async () => {
  for (const scenario of [
    "wrong-bot",
    "no-grant",
    "incomplete-grants",
    "foreign-dm",
    "foreign-channel",
  ]) {
    const f = fixture((method) => {
      if (method === "auth.test")
        return {
          ok: true,
          team_id: "E1",
          enterprise_id: "E1",
          is_enterprise_install: true,
          user_id: scenario === "wrong-bot" ? "UOTHER" : "UBOT",
          bot_id: "B1",
        };
      if (method === "auth.teams.list")
        return {
          ok: true,
          teams: [{ id: scenario.includes("grant") ? "T2" : "T1" }],
          response_metadata: {
            next_cursor: scenario === "incomplete-grants" ? "MORE" : "",
          },
        };
      if (method === "users.conversations")
        return { ok: true, channels: [{ id: "COTHER" }] };
      return undefined;
    });
    expect(
      await f.adapter.shareHistory?.(
        event,
        {
          ...lookup,
          target: scenario === "foreign-channel" ? "C2" : "D2",
        },
        "op",
        () => true,
      ),
    ).toMatchObject({ status: "rejected" });
    expect(f.posted).toEqual([]);
    expect(
      f.calls.some((call) =>
        ["conversations.history", "conversations.replies"].includes(
          call.method,
        ),
      ),
    ).toBe(false);
    if (scenario === "incomplete-grants")
      expect(
        f.calls.filter((call) => call.method === "auth.teams.list"),
      ).toHaveLength(5);
  }
});

it("fails closed on wrong bot identity, nonmember channels, ambiguous names and changed DM recipients", async () => {
  for (const scenario of [
    "identity",
    "membership",
    "name",
    "recipient",
    "revoked",
  ] as const) {
    let current = true;
    let destinationReads = 0;
    const f = fixture((method, body) => {
      if (scenario === "identity" && method === "auth.test")
        return { ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" };
      if (
        scenario === "membership" &&
        method === "conversations.info" &&
        body.channel === "C2"
      )
        return { ok: true, channel: { id: "C2", is_member: false } };
      if (scenario === "name" && method === "users.list")
        return {
          ok: true,
          members: [
            { id: "U2", name: "alex" },
            { id: "U3", name: "alex" },
          ],
        };
      if (
        scenario === "recipient" &&
        method === "conversations.info" &&
        body.channel === "D1" &&
        ++destinationReads > 1
      )
        return { ok: true, channel: { id: "D1", is_im: true, user: "U3" } };
      if (scenario === "revoked" && method === "conversations.history")
        current = false;
      return undefined;
    });
    expect(
      await f.adapter.shareHistory?.(
        event,
        {
          ...lookup,
          target:
            scenario === "membership"
              ? "C2"
              : scenario === "name"
                ? "alex"
                : "U2",
        },
        "op",
        () => current,
      ),
    ).toMatchObject({ status: "rejected" });
    expect(f.posted).toEqual([]);
    if (["identity", "membership", "name"].includes(scenario))
      expect(
        f.calls.some((call) => call.method === "conversations.history"),
      ).toBe(false);
  }
});

it("returns only a receipt, privately delivers both sides, and excludes transcripts from later context", async () => {
  const f = fixture();
  expect(
    await f.adapter.shareHistory?.(
      event,
      lookup,
      "stable-operation",
      () => true,
    ),
  ).toEqual({ status: "sent", messageId: "1800000001.000001" });
  expect(f.posted).toHaveLength(1);
  expect(f.posted[0]).toMatchObject({
    channel: "D1",
    client_msg_id: "stable-operation",
    unfurl_links: false,
    unfurl_media: false,
  });
  expect(f.posted[0]).not.toHaveProperty("thread_ts");
  const text = String(f.posted[0]?.text);
  expect(text.startsWith(PRIVATE_SLACK_HISTORY_PREFIX)).toBe(true);
  expect(text).toContain("PRIVATE_FIXTURE");
  expect(text).toContain("June's actual reply");
  expect(text).toContain("&lt;@U3&gt; &amp; &lt;!channel&gt;");
  expect(text).toContain("HISTORY_PAGE_2");
  expect(
    f.calls.find((call) => call.method === "conversations.history")?.body,
  ).toEqual({ channel: "D2", limit: 15 });
  const context = await f.adapter.context?.({
    ...event,
    direct: true,
    address: { ...event.address, conversationId: "D1", threadId: undefined },
    metadata: { channelType: "im" },
    text: "Thanks",
  });
  expect(JSON.stringify(context)).not.toContain("PRIVATE_FIXTURE");
  expect(context?.map((message) => message.content)).toEqual(["Thanks"]);
});

it("preserves uncertainty after Slack's partial-success send errors", async () => {
  for (const error of ["internal_error", "fatal_error"]) {
    const f = fixture((method) =>
      method === "chat.postMessage" ? { ok: false, error } : undefined,
    );
    expect(
      await f.adapter.shareHistory?.(event, lookup, "op", () => true),
    ).toEqual({
      status: "unknown",
      code: "history_send_uncertain",
    });
    expect(
      f.calls.filter((call) => call.method === "chat.postMessage"),
    ).toHaveLength(1);
  }
});

it("reads only the selected thread and cursor, without falling back to another source", async () => {
  const root = "1799999999.000001";
  const f = fixture((method) =>
    method === "conversations.replies"
      ? {
          ok: true,
          messages: [
            { ts: root, user: "U2", text: "Root" },
            {
              ts: "1799999999.000002",
              thread_ts: root,
              user: "UBOT",
              text: "Included reply",
            },
            {
              ts: "1799999999.000003",
              thread_ts: "1799999990.000001",
              user: "U2",
              text: "OTHER_THREAD_SECRET",
            },
            {
              ts: "1799999999.000004",
              thread_ts: root,
              channel: "C3",
              user: "U2",
              text: "OTHER_CHANNEL_SECRET",
            },
          ],
        }
      : undefined,
  );
  await f.adapter.shareHistory?.(
    event,
    { target: "C2", threadTs: root, cursor: "NEXT" },
    "op",
    () => true,
  );
  expect(
    f.calls.find((call) => call.method === "conversations.replies")?.body,
  ).toEqual({ channel: "C2", ts: root, cursor: "NEXT", limit: 15 });
  expect(String(f.posted[0]?.text)).toContain("Included reply");
  expect(String(f.posted[0]?.text)).not.toContain("SECRET");
  expect(f.calls.some((call) => call.method === "conversations.history")).toBe(
    false,
  );
});

it("runs June's owner-channel directive once, without retaining contents or exposing the tool to guests", async (t) => {
  const f = fixture();
  delete f.adapter.context;
  const requests: ModelRequest[] = [];
  const registry = createJuneRegistry({
    owner,
    channels: { slack: f.adapter },
    model: {
      async reply(request) {
        requests.push(request);
        if (request.slackHistoryAvailable) {
          expect(replyJsonSchema([], request).properties).toHaveProperty(
            "slackHistory",
          );
          return parseReply(
            JSON.stringify({
              text: "",
              slackHistory: lookup,
              replyInThread: false,
            }),
            [],
            request,
          );
        }
        expect(replyJsonSchema([], request).properties).not.toHaveProperty(
          "slackHistory",
        );
        // A provider ignoring the schema still cannot give another user access.
        return { text: "", slackHistory: lookup };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(
    routeEvent(event, owner)?.key ?? [],
  );
  await june.send("inbox", { type: "event", event });
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).filter((row) => row.done)
          .length,
      { timeout: 10000 },
    )
    .toBe(1);
  expect(
    f.posted.filter((post) => String(post.text).includes("PRIVATE_FIXTURE")),
  ).toHaveLength(1);
  expect(f.posted[0]?.channel).toBe("D1");
  expect(f.posted[1]).toMatchObject({
    channel: "C1",
    text: "I sent the available history to your Slack DM.",
  });
  expect(JSON.stringify(await june.snapshot())).not.toContain(
    "PRIVATE_FIXTURE",
  );
  expect(JSON.stringify(requests)).not.toContain("PRIVATE_FIXTURE");
  await june.send("inbox", { type: "event", event });
  const guest = {
    ...event,
    id: "guest",
    senderId: "U2",
    messageId: "1800000000.000101",
  };
  const guestActor = client.conversation.getOrCreate(
    routeEvent(guest, owner)?.key ?? [],
  );
  await guestActor.send("inbox", { type: "event", event: guest });
  await expect
    .poll(
      async () =>
        Object.values((await guestActor.snapshot()).events).filter(
          (row) => row.done,
        ).length,
      { timeout: 10000 },
    )
    .toBe(1);
  expect(requests.at(-1)?.slackHistoryAvailable).toBe(false);
  expect(
    f.calls.filter((call) => call.method === "conversations.history"),
  ).toHaveLength(1);
  expect(JSON.stringify(await guestActor.snapshot())).not.toContain(
    "PRIVATE_FIXTURE",
  );
});
