import type { ChannelEvent, Owner } from "./contracts.js";

export interface Scope {
  key: string[];
  private: boolean;
}

export function routeEvent(
  event: ChannelEvent,
  owner: Owner,
): Scope | undefined {
  const { address } = event;
  const senderId =
    event.type === "receipt" ? address.conversationId : event.senderId;
  if (
    !owner.identities.some(
      (identity) =>
        identity.channel === address.channel &&
        identity.accountId === address.accountId &&
        identity.senderId === senderId,
    )
  ) {
    return undefined;
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
