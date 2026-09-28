import type { PersonalityPreview } from "../runtime/personality.js";

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
  /** Verified fresh plain Slack backup command; absent on old/context events. */
  memoryBackupEligible?: boolean;
  /** Verified fresh plain owner Slack session control, never imported context. */
  sessionCommandEligible?: boolean;
  /** Fresh, plain owner-DM deployment approval; never set by history/model text. */
  appDeploymentEligible?: boolean;
  /** Fresh, plain owner-private Slack command; absent on quotes and old inboxes. */
  forgetCommandEligible?: boolean;
  /** Fresh plain owner-DM PIN reply; never imported history or quoted text. */
  browserPinEligible?: boolean;
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
    | {
        type: "text";
        text: string;
        replyTo?: string;
        plainText?: true;
        webEmbed?: import("./web-embed.js").WebEmbed;
        question?: import("./question.js").Question;
      }
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

export type ChannelAudience =
  | { kind: "owner" }
  | { kind: "public" }
  | { kind: "group"; members: string[] }
  | { kind: "unknown" };

export interface ChannelAdapter {
  readonly channel: Channel;
  readonly capabilities: { text: true; reactions: true; threads: boolean };
  readonly webEmbedOrigins?: readonly string[];
  /** Fresh authenticated audience evidence; unknown must withhold imports. */
  audience?(
    event: MessageEvent,
    signal?: AbortSignal,
  ): Promise<ChannelAudience>;
  /** Verify raw bytes before decoding. Never enqueue an unauthenticated event. */
  receive(
    request: Request,
    /** Set only by authenticated durable intake, never from public headers. */
    intake?: { receivedAt: number },
  ): Promise<{ response: Response; events: ChannelEvent[] }>;
  send(message: OutboundMessage): Promise<SendResult>;
  /** Use only for the initiating message. Credentials and results stay volatile. */
  search?(
    event: MessageEvent,
    query: string,
    canStartAction?: () => boolean,
  ): Promise<ChannelSearchResult>;
  /** Read June's accessible Slack history for the verified owner and deliver
   * directly to that owner's Slack DM. Never return message bodies to a caller. */
  shareHistory?(
    event: MessageEvent,
    request: import("./slack-history.js").SlackHistoryRequest,
    operationId: string,
    isCurrent: () => boolean | Promise<boolean>,
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
  /** Host-created Dynamic Apps build, never a deployment grant. */
  appId?: string;
}

export interface ExecutionCommand {
  /** Stable within this conversation; reuse for related follow-ups. */
  agent: string;
  action: "run" | "cancel";
  task: string;
}

export interface CompanionReply {
  text: string;
  /** Alternative to text: ordered conversational messages, not tool actions. */
  messages?: string[];
  /** Native conversational choices, not authorization for a protected action. */
  question?: import("./question.js").Question;
  /** Exceptional conversational interruption; never bypasses action permissions. */
  interrupt?: boolean;
  /** Persist the current conversation/thread's typing preference; absent leaves it unchanged. */
  typingEnabled?: boolean;
  execution?: ExecutionCommand[];
  workflow?: import("../workflows/contracts.js").WorkflowCommand;
  /** Capability-free QuickJS computation, separate from privileged workflows. */
  javascript?: { source: string; inputJson: string };
  emojiSearch?: { query: string; limit?: number };
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
  /** Opt-in owner-private disposable external code execution. */
  e2b?: import("../tools/e2b.js").E2BRequest;
  /** Owner-private browser work, owned by the durable execution worker. */
  browserTask?: import("../browser/contracts.js").BrowserCommand;
  webEmbed?: import("./web-embed.js").WebEmbed;
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
  /** Owner-private receipt metadata or one-use transient Puck reply; never execution. */
  mcpProposal?: { action: "inspect" | "result"; id: string };
  /** Owner-private diagnostics: "logs", "recent" timings or one ping UUIDv4. */
  latency?: string;
  /** Owner-private aggregate token usage for the last 1, 7, or 30 days. */
  analytics?: { days: 1 | 7 | 30 };
  /** Owner-private bounded metadata inspection; never recall or mutation. */
  inspection?:
    | "tombstones"
    | "capability-matrix"
    | "memory"
    | "imports"
    | "reflection"
    | "native-coding"
    | "inference"
    | "forgetting"
    | "operations"
    | "debug-shares"
    | "capacity"
    | "retention"
    | "capabilities"
    | "credentials"
    | "slack-search"
    | "snapshot-retention"
    | "mcp-connections"
    | "personality"
    | "backup"
    | "mcp-enrollment"
    | { target: "imports"; selection: string | null; offset: number }
    | { target: "import-approval"; selection: string };
  /** One owner-private query of retained evidence, never a permission grant. */
  recall?:
    | string
    | { kind: "dependents"; sourceId: string }
    | { kind: "claim"; claimId: string }
    | {
        kind: "sessions";
        query: string;
        observedFrom?: number;
        observedTo?: number;
      }
    | { kind: "session"; sessionId: string; afterSequence?: number }
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
  /** Stage from one retained reflection publication, never its generated text as evidence. */
  reflectionPersonalitySuggestion?: import("../reflection/global-proposal.js").ReflectionPersonalitySuggestion;
  /** Observe only the current owner-private message with a fixed Jev rubric. */
  jevObservation?: boolean;
  /** Read existing private hypotheses through an effect-free model continuation. */
  reflectionReview?: import("./reflection-review.js").ReflectionReview;
  /** Request bounded owner-private reflection, not immediate evaluation or delivery. */
  reflectionRequest?: {
    evidenceIds: string[];
    mode: "idle" | "deep";
    /** Omitted by older replies; defaults to reflection. No additional sources/tools. */
    kind?: "reflection" | "curiosity";
  };
  /** Explicit owner-private advisory evaluation of existing scoped evidence. */
  jury?: import("../reflection/jury.js").JuryRequest;
  /** Propose exact evaluated behavior for separate coding approval, never run it. */
  skillCodingProposal?: { candidateId: string; workspace: string };
  /** Stage an existing reflection as a pending hypothesis, never accept it. */
  reflectionMemory?: { id: string; subjectSourceId: string };
  /** Owner one-to-one Slack DM only; volatile read-only Rivet inspection. */
  rivet?: import("./rivet.js").RivetRequest;
  /** List named mutations (null), or propose one for separate exact human approval. */
  browserProposal?: { operation: string | null };
  /** Owner-private diff only; publishing still requires an owner command. */
  personalityPreview?: PersonalityPreview;
  /** Exact owner-private forgetting impact; never deletion or confirmation. */
  forgetPreview?: { sourceId: string };
  /** Owner-private held-out candidate suitability; never promotion or a send. */
  personalityEvaluate?: import("../runtime/personality-evaluation-preview.js").PersonalityEvaluateInput;
  /** Permanently cancel one configured history selection, owner-private only. */
  importCancel?: string;
  /** Evaluate one retained immutable skill proposal; never install or promote it. */
  skillEvaluationRequest?: {
    candidateId: string;
    heldOutEvidenceIds: string[];
  };
  /** Issue one short-lived dashboard login link to the owner privately. */
  dashboardLogin?: boolean;
  /** Owner-private persistent schedules and event subscriptions. */
  wakeup?: import("../wakeups/state.js").WakeupAction;
  apps?: import("../apps/client.js").AppsRequest;
  /** Slack: true selects a thread, false the main conversation; unset preserves input placement. */
  replyInThread?: boolean;
}

export type ProviderTimingStage =
  | "submitted"
  | "terminal"
  | "validated"
  | "retired";

/** Host-authorized evidence only, never a model-authored action or remote URL. */
export interface ModelImageInput {
  evidenceId: string;
  mimeType: "image/jpeg" | "image/png";
  data: Uint8Array;
  mediaTimeSeconds?: number;
}

export interface ModelRequest {
  /** Host-enforced action boundary; omitted preserves legacy mixed-role turns. */
  agentRole?: "interaction" | "execution";
  system: string;
  messages: ConversationMessage[];
  /** Host-only scoped images: at most 8, 5 MiB each and 20 MiB total.
   * The caller authorizes evidence access; providers reject invalid inputs.
   * Never serialize bytes into text prompts, history, or journals. */
  images?: ModelImageInput[];
  /** Host-only accounting label, never part of a provider prompt. */
  usageStage?: "fast" | "deep" | "synthesis" | "execution";
  /** Host diagnostics callback only; never serialize into prompts or journals.
   * Retirement may be observed after reply resolves and the turn finishes. */
  onProviderTiming?: (stage: ProviderTimingStage) => void;
  /** Host-only control for model wrappers before dispatching intermediate tools. */
  onTypingPreference?: (enabled: boolean) => Promise<void>;
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
  appsAvailable?: boolean;
  recallAvailable?: boolean;
  pendingMemoryAvailable?: boolean;
  personalitySuggestionAvailable?: boolean;
  reflectionPersonalitySuggestionAvailable?: boolean;
  jevObservationAvailable?: boolean;
  reflectionReviewAvailable?: boolean;
  reflectionRequestAvailable?: boolean;
  juryAvailable?: boolean;
  e2bAvailable?: boolean;
  browserTaskAvailable?: boolean;
  webEmbedAvailable?: boolean;
  webEmbedOrigins?: readonly string[];
  skillCodingProposalAvailable?: boolean;
  reflectionMemoryAvailable?: boolean;
  rivetAvailable?: boolean;
  browserProposalAvailable?: boolean;
  personalityPreviewAvailable?: boolean;
  forgetPreviewAvailable?: boolean;
  personalityEvaluateAvailable?: boolean;
  importCancelAvailable?: boolean;
  skillEvaluationRequestAvailable?: boolean;
  dashboardLoginAvailable?: boolean;
  wakeupAvailable?: boolean;
  replyPlacementAvailable?: boolean;
  turnTakingAvailable?: boolean;
  typingControlAvailable?: boolean;
  socialAvailable?: boolean;
  executionAvailable?: boolean;
  workflowAvailable?: boolean;
  javascriptAvailable?: boolean;
  emojiSearchAvailable?: boolean;
}

/** Prospective inference liveness only, never proof of delivery/tool outcome or
 * permission to replay. A local timeout, abort or process exit is not remote
 * settlement. Historical invocation markers cannot be upgraded to this receipt. */
export type ModelSettlement = "not_started" | "confirmed_stopped" | "unknown";

export interface ModelInvocation {
  readonly answer: Promise<CompanionReply>;
  /** All native calls are terminal and locally retired, or explicitly unknown.
   * Never intentionally rejects; a rejected/missing receipt is unknown. */
  readonly settlement: Promise<ModelSettlement>;
}

export interface ModelProvider {
  /** Optional host-only lifecycle contract. Return the handle before dispatch;
   * answer timing matches reply, while settlement can arrive later. Wrappers
   * must cover every child, including caught failures and no-call paths. */
  beginReply?(...args: Parameters<ModelProvider["reply"]>): ModelInvocation;
  /** Host-only live validity check for downstream tool/provider admission.
   * Keep it out of requests, prompts and journals; wrappers must forward it. */
  reply(
    request: ModelRequest,
    signal?: AbortSignal,
    isCurrent?: () => boolean,
    /** Host-only pre-dispatch guard, never serialized. Does not cancel or
     * discard already-started actions; wrappers must retain their evidence. */
    canStartAction?: () => boolean,
    /** Durable tool accounting, separate from inference settlement. Never sent
     * to a provider. Dispatch waits for the started receipt to persist. */
    observeEffect?: (
      kind: "mcp" | "web",
      outcome: "started" | "confirmed" | "not_started" | "unknown",
    ) => Promise<void>,
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
