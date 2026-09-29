import type { Identity, SendResult } from "../core/contracts.js";

/** No channel from model input; open a DM for the stored, verified creator. */
export function slackArtifactSecret(
  teamId: string,
  token: string,
  fetchImpl = globalThis.fetch,
) {
  return async (
    identity: Identity,
    operationId: string,
    text: string,
    current: () => boolean,
  ): Promise<SendResult> => {
    if (
      identity.channel !== "slack" ||
      identity.accountId !== teamId ||
      !current()
    )
      return {
        status: "rejected",
        code: "artifact_dm_denied",
        retryable: false,
      };
    const call = async (method: string, body: object) =>
      fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    try {
      const opened = await call("conversations.open", {
        users: identity.senderId,
      });
      const dm = (await opened.json()) as {
        ok?: boolean;
        channel?: { id?: string };
      };
      if (
        !opened.ok ||
        dm.ok !== true ||
        !/^D[A-Z0-9]+$/.test(dm.channel?.id ?? "") ||
        !current()
      )
        return {
          status: "rejected",
          code: "artifact_dm_unavailable",
          retryable: false,
        };
      const response = await call("chat.postMessage", {
        channel: dm.channel?.id,
        text,
        client_msg_id: operationId,
        mrkdwn: false,
        parse: "none",
        unfurl_links: false,
        unfurl_media: false,
      });
      if (response.status >= 500)
        return { status: "unknown", code: "artifact_dm_unknown" };
      const result = (await response.json()) as { ok?: boolean; ts?: string };
      if (response.ok && result.ok === true && typeof result.ts === "string")
        return { status: "sent", messageId: result.ts };
      return result.ok === false
        ? { status: "rejected", code: "artifact_dm_rejected", retryable: false }
        : { status: "unknown", code: "artifact_dm_unknown" };
    } catch {
      return { status: "unknown", code: "artifact_dm_unknown" };
    }
  };
}
