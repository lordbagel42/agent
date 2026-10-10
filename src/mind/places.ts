import type { Address, MessageEvent, Owner } from "../core/contracts.js";
import { isOwner } from "../core/social.js";

/** How widely a conversation's own notes may be shown. Unknown is private. */
export type PlaceKind = "dm" | "group" | "private" | "public" | "unknown";

export interface Place {
  /** Stable file-safe ID, e.g. slack-T123-C456. */
  id: string;
  kind: PlaceKind;
  label?: string;
}

const safe = (value: string) => value.replace(/[^A-Za-z0-9]/g, "");

export function placeId(
  address: Pick<Address, "accountId" | "conversationId">,
) {
  return `slack-${safe(address.accountId)}-${safe(address.conversationId)}`;
}

export function personId(accountId: string, senderId: string) {
  return `slack-${safe(accountId)}-${safe(senderId)}`;
}

/** Slack's channelType is authoritative; ID prefixes are a conservative fallback. */
export function placeKind(
  event: Pick<MessageEvent, "address" | "direct" | "metadata">,
): PlaceKind {
  switch (event.metadata?.channelType) {
    case "im":
      return "dm";
    case "mpim":
      return "group";
    case "group":
      return "private";
    case "channel":
      return "public";
  }
  if (event.direct || event.address.conversationId.startsWith("D")) return "dm";
  return "unknown";
}

export function placeOf(
  event: Pick<MessageEvent, "address" | "direct" | "metadata">,
): Place {
  const label = event.metadata?.channelName;
  return {
    id: placeId(event.address),
    kind: placeKind(event),
    ...(label ? { label } : {}),
  };
}

/** Raygen's one-to-one DM with June: the only place her journal is visible. */
export function isOwnerDm(event: MessageEvent, owner: Owner) {
  return isOwner(event, owner) && placeKind(event) === "dm";
}

export const KIND_DESCRIPTION: Record<PlaceKind, string> = {
  dm: "a one-to-one direct message",
  group: "a group direct message",
  private: "a private channel",
  public: "a public channel",
  unknown: "a conversation of unknown visibility (treat as private)",
};
