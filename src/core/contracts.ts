/** Platform IDs stay opaque; never parse message timestamps as numbers. */
export type Channel = "slack" | "whatsapp";

export interface Address {
  channel: Channel;
  accountId: string;
  conversationId: string;
  threadId?: string;
}

interface EventBase {
  id: string;
  address: Address;
  occurredAt: number;
}

export interface MessageEvent extends EventBase {
  type: "message";
  messageId: string;
  senderId: string;
  direct: boolean;
  text: string;
}

export interface ReactionEvent extends EventBase {
  type: "reaction";
  messageId: string;
  senderId: string;
  emoji: string;
  removed: boolean;
}

export interface ReceiptEvent extends EventBase {
  type: "receipt";
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
}

export type ChannelEvent = MessageEvent | ReactionEvent | ReceiptEvent;

export interface OutboundMessage {
  /** Stable application operation ID, reused across safe retries. */
  id: string;
  address: Address;
  /** Timestamp of the latest user message, for WhatsApp's service window. */
  lastInboundAt: number;
  content:
    | { type: "text"; text: string; replyTo?: string }
    | { type: "reaction"; messageId: string; emoji: string; remove?: boolean };
}

export type SendResult =
  | { status: "sent"; messageId: string }
  | {
      status: "rejected";
      code: string;
      retryable: boolean;
      retryAfterMs?: number;
    }
  | { status: "unknown"; code: string };

/** Ephemeral search output: never persist, journal, log, or add to model memory. */
export type ChannelSearchResult =
  | { status: "ready"; text: string }
  | {
      status: "private_ready";
      /** Keeps snippets inside a one-use closure. The transport rechecks the
       * current grant and exact destination immediately before sending. */
      consume(event: MessageEvent): string | undefined;
    }
  | {
      status: "unavailable";
      code: "authorization_required" | "rate_limited" | "unavailable";
    };

export interface ChannelAdapter {
  readonly channel: Channel;
  readonly capabilities: { text: true; reactions: true; threads: boolean };
  /** Verify raw bytes before decoding. Never enqueue an unauthenticated event. */
  receive(
    request: Request,
  ): Promise<{ response: Response; events: ChannelEvent[] }>;
  send(message: OutboundMessage): Promise<SendResult>;
  /** Use only for the initiating message. Credentials and results stay volatile. */
  search?(event: MessageEvent, query: string): Promise<ChannelSearchResult>;
}

export interface Identity {
  channel: Channel;
  accountId: string;
  senderId: string;
}

export interface Owner {
  id: string;
  identities: Identity[];
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CodingRequest {
  workspace: string;
  goal: string;
}

export interface CompanionReply {
  text: string;
  coding?: CodingRequest;
  reaction?: string;
  /** Request one current-channel lookup instead of a conversational reply. */
  search?: string;
}

export interface ModelRequest {
  system: string;
  messages: ConversationMessage[];
  /** Only these configured workspace names may be delegated. */
  workspaces: string[];
  searchAvailable?: boolean;
}

export interface ModelProvider {
  reply(request: ModelRequest): Promise<CompanionReply>;
}

export interface CodingResult {
  threadId: string;
  report: string;
}

export interface CodingRuntime {
  run(input: {
    prompt: string;
    cwd: string;
    threadId?: string;
    signal: AbortSignal;
    onThread: (threadId: string) => Promise<void>;
  }): Promise<CodingResult>;
}
