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
  /** Verified live, unquoted Slack memory command; never inferred from fallback text. */
  memoryReviewEligible?: boolean;
  /** Verified fresh, plain owner-DM coding command; never set by history/model text. */
  codingCommandEligible?: boolean;
  /** Fresh, plain owner-private Slack review, never quoted or historical text. */
  reflectionReviewEligible?: boolean;
  /** Verified live plain command, never forwarded/quoted/history text.
   * The host separately requires an owner-private turn. */
  mcpCommandEligible?: boolean;
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
    | { type: "text"; text: string; replyTo?: string; plainText?: true }
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
  /** Read-only local public-search token presence, not verified provider access. */
  hasSearchToken?(event: MessageEvent): boolean;
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
  workflow?: import("../workflows/contracts.js").WorkflowCommand;
  social?: import("./social.js").SocialAction;
  coding?: CodingRequest;
  /** Owner-private reports, metadata/diff or cancellation; never approval. */
  codingJob?: {
    action: "list" | "inspect" | "diff" | "report" | "cancel";
    id: string | null;
  };
  reaction?: string;
  /** Request one current-channel lookup instead of a conversational reply. */
  search?: string;
  /** Owner-only cross-conversation lookup, delivered only to the owner's Slack DM. */
  slackHistory?: import("./slack-history.js").SlackHistoryRequest;
  /** Text is an optional acknowledgment before the configured deeper model. */
  escalate?: boolean;
  /** One public web query; never a request to search private Slack history. */
  webSearch?: string;
  /** Owner-authenticated release tracking; never activation or approval authority. */
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
    | "inference"
    | "operations"
    | "retention"
    | "capabilities"
    | "credentials"
    | "slack-search"
    | "snapshot-retention";
  /** One owner-private query of retained evidence, never a permission grant. */
  recall?:
    | string
    | { kind: "dependents"; sourceId: string }
    | {
        kind: "search";
        query: string;
        category?: "claim" | "preference" | "commitment" | "pattern";
        cursor?: string;
        entity?: string;
        /** Original source observation window [from, to), epoch milliseconds. */
        observedFrom?: number;
        observedTo?: number;
        /** Select only claims with known validity [validFrom, validTo) at this instant. */
        validAt?: number;
      }
    | { kind: "source"; sourceId: string }
    | { kind: "contradictions"; claimId: string }
    | { kind: "supersession"; claimId: string };
  /** Owner-private bounded view of unaccepted memory claims; never review. */
  pendingMemory?: true;
  /** Privately stage evidence-grounded style only; never approve or publish. */
  personalitySuggestion?: import("../reflection/global-proposal.js").GlobalProposalInput;
  /** Observe only the current owner-private message with a fixed Jev rubric. */
  jevObservation?: boolean;
  /** Request bounded owner-private reflection, not immediate evaluation or delivery. */
  reflectionRequest?: {
    evidenceIds: string[];
    mode: "idle" | "deep";
    /** Omitted by older replies; defaults to reflection. No additional sources/tools. */
    kind?: "reflection" | "curiosity";
  };
  /** Explicit owner-private advisory evaluation of existing scoped evidence. */
  jury?: import("../reflection/jury.js").JuryRequest;
  /** Owner one-to-one Slack DM only; volatile read-only Rivet inspection. */
  rivet?: import("./rivet.js").RivetRequest;
  /** List named mutations (null), or propose one for separate exact human approval. */
  browserProposal?: { operation: string | null };
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
  personalitySuggestionAvailable?: boolean;
  jevObservationAvailable?: boolean;
  reflectionRequestAvailable?: boolean;
  juryAvailable?: boolean;
  rivetAvailable?: boolean;
  browserProposalAvailable?: boolean;
  dashboardLoginAvailable?: boolean;
  wakeupAvailable?: boolean;
  replyPlacementAvailable?: boolean;
  socialAvailable?: boolean;
  executionAvailable?: boolean;
  workflowAvailable?: boolean;
}

export interface ModelProvider {
  /** Host-only live validity check for downstream tool/provider admission.
   * Keep it out of requests, prompts and journals; wrappers must forward it. */
  reply(
    request: ModelRequest,
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<CompanionReply>;
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
