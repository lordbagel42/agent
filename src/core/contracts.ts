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

/** Platform context is evidence, not instructions or authorization. */
export interface MessageMetadata {
  senderName?: string;
  channelName?: string;
  channelType?: "im" | "mpim" | "channel" | "group";
  /** Actual Slack thread timestamp; absent for an unthreaded message. */
  threadTs?: string;
  files?: {
    id: string;
    name?: string;
    title?: string;
    mimetype?: string;
  }[];
}

export interface MessageEvent extends EventBase {
  type: "message";
  messageId: string;
  senderId: string;
  direct: boolean;
  text: string;
  /** Set only by verified Slack ingress, never by model/context enrichment. */
  botMentioned?: boolean;
  /** Verified live Slack text, not a quote/code block, attachment or subtype.
   * Absent on historical/context events and old inbox records. */
  ownerCorrectionEligible?: boolean;
  /** Fresh, plain owner-private Slack command; quoted/history text cannot publish. */
  personalityCommandEligible?: boolean;
  metadata?: MessageMetadata;
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
  /** Read June's accessible Slack history for the verified owner and deliver
   * directly to that owner's Slack DM. Never return message bodies to a caller. */
  shareHistory?(
    event: MessageEvent,
    request: import("./slack-history.js").SlackHistoryRequest,
    operationId: string,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<SendResult>;
  /** Bounded same-surface context for an already-authorized owner turn. */
  context?(
    event: MessageEvent,
    signal?: AbortSignal,
  ): Promise<ConversationMessage[]>;
  /** Ephemeral host activity, never a model action or a durable delivery.
   * Unsupported surfaces are a no-op; adapters bound each transport attempt. */
  setTyping?(
    event: MessageEvent,
    active: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
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
  source?: Omit<MessageEvent, "type" | "text">;
}

export interface CodingRequest {
  workspace: string;
  goal: string;
}

export interface ExecutionCommand {
  /** Stable within this conversation; reuse for related follow-ups. */
  agent: string;
  action: "run" | "cancel";
  task: string;
}

export interface CompanionReply {
  text: string;
  execution?: ExecutionCommand[];
  social?: import("./social.js").SocialAction;
  coding?: CodingRequest;
  /** Owner-private lifecycle metadata or cancellation request; never approval. */
  codingJob?: { action: "list" | "inspect" | "cancel"; id: string | null };
  reaction?: string;
  /** Request one current-channel lookup instead of a conversational reply. */
  search?: string;
  /** Owner-only cross-conversation lookup, delivered only to the owner's Slack DM. */
  slackHistory?: import("./slack-history.js").SlackHistoryRequest;
  /** Text is an optional acknowledgment before the configured deeper model. */
  escalate?: boolean;
  /** One public web query; never a request to search private Slack history. */
  webSearch?: string;
  /** Owner-private release tracking; never activation or approval authority. */
  release?: { action: "inspect"; revision: string | null };
  /** Owner-private read-only inspection of model runtime health. */
  modelStatus?: boolean;
  /** One owner-private MCP call; host resolves credentials and permissions. */
  mcp?: { connection: string; tool: string; argumentsJson: string };
  /** Selected saved permission/trust boundary only; never a tool call or grant. */
  mcpPermission?: { connection: string; tool: string };
  /** Page approved tool summaries, or retrieve an exact tool's JSON contract. */
  mcpCatalog?: {
    connection: string | null;
    tool: string | null;
    offset: number;
  };
  /** Owner-private recorded proposal/receipt metadata; never execution or approval. */
  mcpProposal?: { action: "inspect"; id: string };
  /** Owner-private diagnostics: "logs", "recent" timings or one ping UUIDv4. */
  latency?: string;
  /** Owner-private aggregate token usage for the last 1, 7, or 30 days. */
  analytics?: { days: 1 | 7 | 30 };
  /** Owner-private bounded metadata inspection; never recall or mutation. */
  inspection?:
    | "memory"
    | "imports"
    | "reflection"
    | "native-coding"
    | "retention"
    | "capabilities";
  /** One owner-private query of retained evidence, never a permission grant. */
  recall?:
    | string
    | {
        kind: "search";
        query: string;
        category?: "claim" | "preference" | "commitment" | "pattern";
        cursor?: string;
      }
    | { kind: "contradictions"; claimId: string };
  /** Owner-private bounded view of unaccepted memory claims; never review. */
  pendingMemory?: true;
  /** Issue one short-lived dashboard login link to the owner privately. */
  dashboardLogin?: boolean;
  /** Owner-private persistent schedules and event subscriptions. */
  wakeup?: import("../wakeups/state.js").WakeupAction;
  /** Slack: true selects a thread, false the main conversation; unset preserves input placement. */
  replyInThread?: boolean;
}

export type ProviderTimingStage =
  | "submitted"
  | "terminal"
  | "validated"
  | "retired";

export interface ModelRequest {
  system: string;
  messages: ConversationMessage[];
  /** Host-only accounting label, never part of a provider prompt. */
  usageStage?: "fast" | "deep" | "synthesis" | "execution";
  /** Host diagnostics callback only; never serialize into prompts or journals.
   * Retirement may be observed after reply resolves and the turn finishes. */
  onProviderTiming?: (stage: ProviderTimingStage) => void;
  /** Only these configured workspace names may be delegated. */
  workspaces: string[];
  codingJobsAvailable?: boolean;
  searchAvailable?: boolean;
  slackHistoryAvailable?: boolean;
  escalationAvailable?: boolean;
  webSearchAvailable?: boolean;
  releaseAvailable?: boolean;
  modelStatusAvailable?: boolean;
  mcpAvailable?: boolean;
  /** Set by the owner-private MCP wrapper, independently of enabled tools. */
  mcpPermissionAvailable?: boolean;
  /** Historical receipt reads remain available independently of enabled tools. */
  mcpProposalAvailable?: boolean;
  latencyAvailable?: boolean;
  analyticsAvailable?: boolean;
  inspectionAvailable?: boolean;
  recallAvailable?: boolean;
  pendingMemoryAvailable?: boolean;
  dashboardLoginAvailable?: boolean;
  wakeupAvailable?: boolean;
  replyPlacementAvailable?: boolean;
  socialAvailable?: boolean;
  executionAvailable?: boolean;
}

export interface ModelProvider {
  reply(request: ModelRequest, signal?: AbortSignal): Promise<CompanionReply>;
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
