import type { ChannelEvent, Owner } from "./contracts.js";
import { isOwner } from "./social.js";

/** Plain DEBUG/DEBUGSHARE, optionally followed by a reason that may span lines. */
export const DEBUG_COMMAND = /^(DEBUG|DEBUGSHARE)(?:[ \r\n]+([\s\S]*))?$/;

export interface Scope {
  key: string[];
  private: boolean;
}

export function routeEvent(
  event: ChannelEvent,
  owner: Owner,
  filterIgnoredMessages = true,
): Scope | undefined {
  const { address } = event;
  if (
    filterIgnoredMessages &&
    address.channel === "slack" &&
    event.type === "message" &&
    event.text.startsWith("##")
  )
    return undefined;
  if (!isOwner(event, owner)) {
    const debug =
      event.type === "message" &&
      event.sessionCommandEligible === true &&
      DEBUG_COMMAND.test(event.text);
    if (
      event.type !== "message" ||
      address.channel !== "slack" ||
      !owner.identities.some(
        (identity) =>
          identity.channel === "slack" &&
          identity.accountId === address.accountId,
      ) ||
      !["im", "channel", "group", "mpim"].includes(
        event.metadata?.channelType ?? "",
      ) ||
      event.direct !== (event.metadata?.channelType === "im") ||
      (!event.direct &&
        event.metadata?.channelType !== "mpim" &&
        !event.botMentioned &&
        !event.questionAnswered &&
        !(
          event.threadFollowup === true &&
          address.threadId &&
          address.threadId !== event.messageId
        ) &&
        !debug &&
        !event.senderId.startsWith("bot:"))
    )
      return undefined;
    // Guests never join the owner's actor/queue, even in the same thread.
    return {
      key: [
        "guest",
        "slack",
        address.accountId,
        address.conversationId,
        address.threadId ?? "",
        event.senderId,
      ],
      private: false,
    };
  }
  if (
    address.channel === "whatsapp" ||
    (event.type === "message" && event.direct)
  ) {
    return { key: ["private", owner.id], private: true };
  }
  // Slack reaction events don't include their parent thread or DM classification.
  // Keep them in a surface-scoped audit stream; never infer private authority.
  return {
    key: [
      address.channel,
      address.accountId,
      address.conversationId,
      address.threadId ?? "",
    ],
    private: false,
  };
}
