import { AGENT_QUESTION_PREFIX } from "../core/agent-question.js";
import type { ChannelAdapter, Owner } from "../core/contracts.js";
import type { QuestionDelivery } from "./questions.js";

/** Destinations come only from owner configuration, never from an MCP caller. */
export function slackQuestionDelivery(
  owner: Owner,
  teamId: string,
  token: string,
  adapter: ChannelAdapter,
  botUserId: string,
  fetchImpl = globalThis.fetch,
): QuestionDelivery {
  const recipient = owner.identities.find(
    (identity) => identity.channel === "slack" && identity.accountId === teamId,
  );
  if (!recipient) throw new Error("question_slack_owner_missing");
  const call = async (method: string, body: object) => {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams(
        Object.entries(body).map(([key, value]) => [key, String(value)]),
      ).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? await response.json() : undefined;
  };
  return {
    recipient,
    async open() {
      const body = (await call("conversations.open", {
        users: recipient.senderId,
      })) as
        | {
            ok?: boolean;
            channel?: { id?: string };
          }
        | undefined;
      const id = body?.channel?.id;
      if (
        body?.ok !== true ||
        typeof id !== "string" ||
        !/^D[A-Z0-9]+$/.test(id)
      )
        throw new Error("question_dm_unavailable");
      return id;
    },
    async questionAt(channel, thread) {
      try {
        const body = (await call("conversations.replies", {
          channel,
          ts: thread,
          limit: 1,
        })) as
          | {
              ok?: boolean;
              messages?: Array<{ ts?: string; user?: string; text?: string }>;
            }
          | undefined;
        const root = body?.messages?.find((message) => message.ts === thread);
        if (body?.ok !== true || !root || typeof root.text !== "string")
          return undefined;
        if (
          root.user !== botUserId ||
          !root.text.startsWith(AGENT_QUESTION_PREFIX)
        )
          return null;
        return root.text.slice(AGENT_QUESTION_PREFIX.length).split("\n")[0];
      } catch {
        return undefined;
      }
    },
    send: (message) => adapter.send(message),
  };
}
