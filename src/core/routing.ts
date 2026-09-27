import type { ChannelEvent, Owner } from "./contracts.js";
import { isOwner } from "./social.js";

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
    if (
      event.type !== "message" ||
      address.channel !== "slack" ||
      !owner.identities.some(
        (identity) =>
          identity.channel === "slack" &&
          identity.accountId === address.accountId,
      ) ||
      !["im", "channel", "group"].includes(event.metadata?.channelType ?? "") ||
      event.direct !== (event.metadata?.channelType === "im") ||
      (!event.direct && !event.botMentioned)
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
