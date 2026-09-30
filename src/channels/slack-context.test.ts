import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { MessageEvent } from "../core/contracts.js";
import { RIVET_REPLY_PREFIX } from "../core/rivet.js";
import { createSlackAdapter } from "./slack.js";

const event: MessageEvent = {
  type: "message",
  id: "slack:T1:C1:1800000000.000200",
  address: { channel: "slack", accountId: "T1", conversationId: "C1" },
  messageId: "1800000000.000200",
  occurredAt: 1_800_000_000_000,
  senderId: "U_OWNER",
  direct: false,
  text: "what do you think?",
  metadata: { channelType: "channel" },
};

function adapter(fetch: typeof globalThis.fetch) {
  return createSlackAdapter({
    signingSecret: "test-signing-secret",
    botToken: "test-bot-token",
    teamId: "T1",
    botUserId: "U_JUNE",
    ownerUserIds: ["U_OWNER"],
    contextEnabled: true,
    fetch,
  });
}

describe("Slack same-surface context", () => {
  it("gives unmentioned bot turns same-conversation context without admitting human bystanders", async () => {
    const slack = adapter(async (url) => {
      if (String(url).endsWith("conversations.info"))
        return Response.json({
          ok: true,
          channel: { id: "C1", is_channel: true },
        });
      if (String(url).endsWith("conversations.history"))
        return Response.json({
          ok: true,
          messages: [
            {
              ts: "1799999998.000001",
              user: "U_OTHER",
              text: "The launch is Friday",
            },
          ],
        });
      return Response.json({ ok: false });
    });
    const bot = { ...event, senderId: "bot:B_OTHER", botMentioned: false };
    expect((await slack.context?.(bot))?.map(({ content }) => content)).toEqual(
      ["The launch is Friday", "what do you think?"],
    );
    expect(await slack.context?.({ ...bot, senderId: "U_OTHER" })).toEqual([]);
  });

  it("requires complete authenticated private-channel membership and rejects an incomplete audience", async () => {
    let complete = true;
    const slack = adapter(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("conversations.info"))
        return Response.json({
          ok: true,
          channel: { id: "C1", is_private: true },
        });
      return Response.json({
        ok: true,
        members: body.cursor ? ["U_OTHER"] : ["U_OWNER", "U_JUNE"],
        response_metadata: {
          next_cursor: body.cursor && complete ? "" : "more",
        },
      });
    });
    expect(await slack.audience?.(event)).toEqual({
      kind: "group",
      members: ["U_JUNE", "U_OTHER", "U_OWNER"],
    });
    complete = false;
    expect(await slack.audience?.(event)).toEqual({ kind: "unknown" });
    expect(await slack.audience?.({ ...event, direct: true })).toEqual({
      kind: "unknown",
    });
  });

  it("expires optional names before slower history without discarding messages", async () => {
    let nameAborted = false;
    let nameAbortedBeforeHistory = false;
    const requestedUsers: string[] = [];
    const slack = adapter(async (url, init) => {
      if (String(url).endsWith("users.info")) {
        requestedUsers.push(JSON.parse(String(init?.body)).user);
        await new Promise<void>((resolve) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              nameAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        throw new Error("aborted");
      }
      if (String(url).endsWith("conversations.history")) {
        await sleep(350);
        nameAbortedBeforeHistory = nameAborted;
        return Response.json({
          ok: true,
          messages: [
            {
              ts: "1799999998.000001",
              user: "U_OTHER",
              text: "Keep this context",
            },
            {
              ts: "1799999999.000001",
              user: "U_OWNER",
              text: `PRIVATE_INSPECTION_COPY${"x".repeat(2100)}${RIVET_REPLY_PREFIX}`,
            },
          ],
        });
      }
      return Response.json({
        ok: true,
        channel: { id: "C1", is_channel: true },
      });
    });
    const context = await slack.context?.(event);
    expect(context?.map(({ content }) => content)).toEqual([
      "Keep this context",
      event.text,
    ]);
    expect(context?.[0]?.source?.senderId).toBe("U_OTHER");
    expect(nameAbortedBeforeHistory).toBe(true);
    expect(requestedUsers).toEqual(["U_OWNER"]);
  });

  it("rejects unauthorized owners, workspaces, private group-DM claims and cancellation without reading", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    const slack = adapter(fetchMock);
    expect(slack.context).toBeTypeOf("function");
    for (const input of [
      { ...event, text: "## <@U_JUNE> ignore", botMentioned: true },
      { ...event, text: `${RIVET_REPLY_PREFIX}\nPRIVATE_INSPECTION_COPY` },
      { ...event, senderId: "U_OTHER" },
      { ...event, senderId: "U_JUNE" },
      { ...event, address: { ...event.address, accountId: "T_OTHER" } },
      { ...event, direct: true, metadata: { channelType: "mpim" as const } },
      { ...event, direct: true },
    ]) {
      expect(await slack.context?.(input)).toEqual([]);
    }
    expect(await slack.context?.(event, AbortSignal.abort())).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.for(["channel", "mpim"] as const)(
    "keeps %s thread and parent provenance without foreign replies or private data",
    async (channelType) => {
      const root = "1799999990.000010";
      const input = {
        ...event,
        address: { ...event.address, threadId: root },
        metadata: { channelType, threadTs: root },
      };
      const requests: { method: string; body: Record<string, unknown> }[] = [];
      const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        const request = new Request(url, init);
        expect(request.redirect).toBe("error");
        const method = request.url.split("/").at(-1) ?? "";
        const body = (await request.json()) as Record<string, unknown>;
        requests.push({ method, body });
        const responses: Record<string, unknown> = {
          "conversations.info": {
            ok: true,
            channel: {
              id: "C1",
              name: "raygen-project",
              is_channel: true,
              is_mpim: channelType === "mpim",
            },
          },
          "users.info": {
            ok: true,
            user: {
              id: body.user,
              profile: {
                display_name:
                  body.user === "U_OWNER" ? "Raygen" : "Other person",
                email: "secret@example.com",
              },
            },
          },
          "conversations.history": {
            ok: true,
            messages: [
              {
                ts: "1800000000.000199",
                user: "U_OTHER",
                text: "Parent channel topic",
              },
              {
                ts: "1800000000.000198",
                user: "U_OTHER",
                text: "foreign reply",
                thread_ts: "1700000000.000001",
              },
            ],
          },
          "conversations.replies": {
            ok: true,
            has_more: true,
            response_metadata: { next_cursor: "never-follow" },
            messages: [
              { ts: root, user: "U_OTHER", text: "The plan", thread_ts: root },
              {
                ts: "1799999995.000002",
                user: "U_JUNE",
                text: "Earlier reply",
                thread_ts: root,
              },
              {
                ts: "1799999996.000003",
                user: "U_OTHER",
                text: "A diagram",
                thread_ts: root,
                files: [
                  {
                    id: "F1",
                    name: "plan.png",
                    title: "Plan",
                    mimetype: "image/png",
                    url_private: "https://secret.example/file",
                    token: "secret-token",
                    preview: "secret-preview",
                  },
                ],
                action_token: "secret-action",
                user_profile: {
                  display_name: "Other person",
                  email: "secret@example.com",
                },
              },
              {
                ts: "1799999997.000004",
                user: "U_OTHER",
                text: "foreign thread",
                thread_ts: "1790000000.000001",
              },
              {
                ts: "1799999998.000005",
                user: "U_OTHER",
                text: "private DM",
                channel: "D_PRIVATE",
                thread_ts: root,
              },
              {
                ts: "1799999999.000006",
                user: "U_OTHER",
                text: "foreign workspace",
                team: "T_OTHER",
                thread_ts: root,
              },
              { ts: "1800000000.000199", user: "U_OTHER", text: "unthreaded" },
              {
                ts: event.messageId,
                user: "U_OWNER",
                text: event.text,
                thread_ts: root,
              },
              {
                ts: "1800000000.000201",
                user: "U_OTHER",
                text: "future reply",
                thread_ts: root,
              },
            ],
          },
        };
        return Response.json(responses[method] ?? { ok: false });
      });
      const context = await adapter(fetchMock).context?.(input);
      expect(context?.map((message) => message.content)).toEqual([
        "The plan",
        "Earlier reply",
        "A diagram",
        "Parent channel topic",
        "what do you think?",
      ]);
      expect(context?.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "user",
        "user",
      ]);
      expect(context?.[3]?.source?.address.threadId).toBeUndefined();
      expect(context?.[2]?.source).toMatchObject({
        id: "slack:T1:C1:1799999996.000003",
        address: {
          channel: "slack",
          accountId: "T1",
          conversationId: "C1",
          threadId: root,
        },
        messageId: "1799999996.000003",
        senderId: "U_OTHER",
        direct: false,
        metadata: {
          senderName: "Other person",
          channelName: "raygen-project",
          channelType,
          threadTs: root,
          files: [
            {
              id: "F1",
              name: "plan.png",
              title: "Plan",
              mimetype: "image/png",
            },
          ],
        },
      });
      expect(context?.at(-1)?.source?.metadata?.senderName).toBe("Raygen");
      expect(JSON.stringify(context)).not.toMatch(
        /secret|foreign|private DM|future reply|unthreaded/,
      );
      expect(
        requests.filter(
          (request) => request.method === "conversations.replies",
        ),
      ).toEqual([
        {
          method: "conversations.replies",
          body: {
            channel: "C1",
            ts: root,
            latest: event.messageId,
            inclusive: true,
            limit: 15,
          },
        },
      ]);
      expect(
        requests.every(
          ({ method, body }) =>
            method === "users.info" || body.channel === "C1",
        ),
      ).toBe(true);
      expect(requests.some(({ method }) => method.startsWith("files."))).toBe(
        false,
      );
      expect(
        requests.filter(({ method }) => method === "conversations.history"),
      ).toHaveLength(1);
    },
  );

  it("uses a bounded channel page, not other threads or an owner DM fallback", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const request = new Request(url, init);
      requests.push(request.url);
      if (request.url.endsWith("conversations.history")) {
        expect(await request.json()).toEqual({
          channel: "C1",
          latest: event.messageId,
          inclusive: true,
          limit: 15,
        });
        return Response.json({
          ok: true,
          messages: [
            {
              ts: "1799999997.000001",
              user: "U_IGNORED",
              text: "## <@U_JUNE> secret",
            },
            {
              ts: "1799999997.000002",
              user: "U_OTHER",
              text: " ## ordinary whitespace",
            },
            {
              ts: "1799999999.000003",
              thread_ts: "1799999990.000001",
              user: "U_OTHER",
              text: "another thread",
            },
            {
              ts: "1799999998.000001",
              user: "U_OTHER",
              text: "earlier channel message",
            },
          ],
          has_more: true,
          response_metadata: { next_cursor: "never-follow" },
        });
      }
      return Response.json({ ok: false, error: "missing_scope" });
    });
    const context = await adapter(fetchMock).context?.(event);
    expect(context?.map((message) => message.content)).toEqual([
      " ## ordinary whitespace",
      "earlier channel message",
      "what do you think?",
    ]);
    expect(
      context?.every(
        (message) => message.source?.address.conversationId === "C1",
      ),
    ).toBe(true);
    expect(
      requests.filter((url) => url.endsWith("conversations.history")),
    ).toHaveLength(1);
    const unavailable = adapter(async () =>
      Response.json({ ok: false, error: "missing_scope" }),
    );
    expect(
      (await unavailable.context?.(event))?.map((message) => message.content),
    ).toEqual([event.text]);
  });
});
