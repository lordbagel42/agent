import type { PersonalityPreview } from "../runtime/personality.js";

/** Platform IDs stay opaque; never parse message timestamps as numbers. */
export type Channel = "slack" | "whatsapp" | "agent";

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
  /** Verified conversations.info record_type, never event-supplied metadata. */
  codeChannel?: boolean;
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
  /** Verified Slack reply in a subscribed or June-authored thread. Admission
   * only: not a direct mention, owner identity, or additional tool permission. */
  threadFollowup?: boolean;
  /** Verified, recipient-bound Slack question choice; conversational admission only. */
  questionAnswered?: boolean;
  /** Verified human Slack text with no attachment/file/subtype provenance. */
  agentQuestionAnswerEligible?: boolean;
  /** Host-only original deletion epoch when a held non-relay input resumes. */
  agentQuestionRevision?: number;
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
  /** Fresh plain owner-private release; never inferred from model/history text. */
  sentinelCommandEligible?: boolean;
  /** Verified fresh plain Slack backup command; absent on old/context events. */
  memoryBackupEligible?: boolean;
  /** Verified fresh plain Slack session control, never imported context.
   * DEBUG/DEBUGSHARE are open to everyone; other controls separately require the owner. */
  sessionCommandEligible?: boolean;
  /** Fresh, plain owner-DM deployment approval; never set by history/model text. */
  appDeploymentEligible?: boolean;
  /** Fresh, plain owner-private Slack command; absent on quotes and old inboxes. */
  forgetCommandEligible?: boolean;
  /** Fresh plain owner-DM PIN reply; never imported history or quoted text. */
  browserPinEligible?: boolean;
  /** Fresh plain creator/owner DM input; checked again by the artifact host. */
  artifactPinEligible?: boolean;
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
        artifact?: import("../artifacts/contracts.js").ArtifactPresentation;
        question?: import("./question.js").Question;
        /** Host-bound requester and surface, never selected by model output. */
        questionTarget?: { userId: string; channelType: string };
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
  readonly capabilities: { text: true; reactions: boolean; threads: boolean };
  readonly webEmbedOrigins?: readonly string[];
  /** Host cancellation fence; does not erase history or prove remote settlement. */
  sourceActive?(source: { address: Address; occurredAt: number }): boolean;
  watchSource?(source: { address: Address; occurredAt: number }):
    | {
        signal: AbortSignal;
        dispose(): void;
      }
    | undefined;
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
  /** Deliberately retrieve June's accessible Slack history for a task/audience.
   * Deliver via the host; never return message bodies to a model caller. */
  shareHistory?(
    event: MessageEvent,
    request: import("./slack-history.js").SlackHistoryRequest,
    operationId: string,
    isCurrent: () => boolean | Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<SendResult>;
  /** Read-only local public-search token presence, not verified provider access. */
  hasSearchToken?(event: MessageEvent): boolean;
  /** Bounded same-surface context for an admitted turn, not cross-audience history. */
  context?(
    event: MessageEvent,
    signal?: AbortSignal,
  ): Promise<ConversationMessage[]>;
  /** Ephemeral native image bytes from an attachment on this authorized event.
   * Never retain the result in actor state, text prompts, or journals. */
  readImage?(
    event: MessageEvent,
    fileId: string,
    signal: AbortSignal,
  ): Promise<
    | { status: "ready"; image: ModelImageInput }
    | { status: "unavailable"; code?: "files_read_required" }
  >;
  /** Ephemeral sampled video frames; same initiating-attachment boundary as images.
   * Decode in private temporary storage, remove it before returning, no audio. */
  readVideo?(
    event: MessageEvent,
    fileId: string,
    signal: AbortSignal,
  ): Promise<
    | { status: "ready"; images: ModelImageInput[] }
    | { status: "unavailable"; code?: "files_read_required" }
  >;
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
  /** One strict source-registered command; payload never carries host authority. */
  capability?: import("../capabilities/catalog.js").CapabilityCommand;
  settings?: import("../settings/contracts.js").SettingsCommand;
  debugShareResolve?: { id: string; confirmedResolved: true };
  artifact?: import("../artifacts/contracts.js").ArtifactCommand;
  /** Host-only output, never accepted from model JSON. */
  artifactPresentation?: import("../artifacts/contracts.js").ArtifactPresentation;
  text: string;
  /** Alternative to text: ordered conversational messages, not tool actions. */
  messages?: string[];
  /** Independently addressed Slack messages; June judges intent and audience. */
  sendMessages?: import("./messaging.js").DirectedMessage[];
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
  readImage?: { fileId: string; question: string };
  readVideo?: { fileId: string; question: string };
  /** Ask June's source specialist; only execution workers may consult it. */
  repository?: string;
  /** Specialist-only reads from the host's pinned public source snapshot. */
  repositoryRead?: import("../repository/contracts.js").RepositoryRead;
  /** Execution-worker read of June's mind, projected for the origin place. */
  mind?: import("../mind/contracts.js").MindQuery;
  /** Background reflection step; never accepted outside agentRole "mind". */
  mindStep?: import("../mind/contracts.js").MindStep;
  social?: import("./social.js").SocialAction;
  coding?: CodingRequest;
  /** Scoped reports, metadata/diff or cancellation; never replay authority. */
  codingJob?: {
    action: "list" | "inspect" | "diff" | "report" | "cancel";
    id: string | null;
  };
  reaction?: string;
  agentWebhook?: import("zod").infer<
    typeof import("../agent/actions.js").agentWebhookSchema
  >;
  /** Request one current-channel lookup instead of a conversational reply. */
  search?: string;
  /** Deliberate cross-conversation lookup; host delivery, not automatic model history. */
  slackHistory?: import("./slack-history.js").SlackHistoryRequest;
  /** Text is an optional acknowledgment before the configured deeper model. */
  escalate?: boolean;
  /** One public web query; never a request to search private Slack history. */
  webSearch?: string;
  /** Configured disposable external code execution, with task-scoped inputs. */
  e2b?: import("../tools/e2b.js").E2BRequest;
  /** Commands in this execution worker's host-selected isolated environment. */
  environment?: import("../environments/contracts.js").EnvironmentCommand;
  /** Browser work owned by the durable execution worker; PINs stay protected. */
  browserTask?: import("../browser/contracts.js").BrowserCommand;
  /** Source-scoped management of host-owned ongoing public/read-only research. */
  research?: import("../research/contracts.js").ResearchCommand;
  webEmbed?: import("./web-embed.js").WebEmbed;
  /** Read-only release tracking; never activation or recovery authority. */
  release?: { action: "inspect"; revision: string | null };
  /** Amp task work through the independent host dispatcher, not OAuth. */
  ampThread?: import("../runtime/amp-threads.js").AmpThreadCommand;
  /** Read-only model runtime inspection; not an independent health attestation. */
  modelStatus?: boolean;
  /** One MCP call; host resolves credentials, schemas and explicit disable controls. */
  mcp?: { connection: string; tool: string; argumentsJson: string };
  /** Selected saved permission/trust boundary only; never a tool call or grant. */
  mcpPermission?: { connection: string; tool: string };
  /** Page approved tool summaries, or retrieve an exact tool's JSON contract. */
  mcpCatalog?: {
    connection: string | null;
    tool: string | null;
    offset: number;
  };
  /** Receipt metadata or one-use transient Puck reply; never repeat execution. */
  mcpProposal?: { action: "inspect" | "result"; id: string };
  /** Sensitive diagnostics: "logs", "recent" timings or one ping UUIDv4. */
  latency?: string;
  /** Paginated OpenTelemetry observations, never replay authority. */
  telemetry?: import("../telemetry/index.js").TelemetryQuery;
  /** Aggregate token usage for the last 1, 7, or 30 days. */
  analytics?: { days: 1 | 7 | 30 };
  /** Host-idempotent local encrypted evidence-ledger backup; content-free receipt only. */
  memoryBackup?: true;
  /** Bounded metadata inspection; never recall or mutation. */
  inspection?:
    | "tombstones"
    | "sentinel"
    | "capability-matrix"
    | "memory"
    | "imports"
    | "reflection"
    | "native-coding"
    | "inference"
    | "forgetting"
    | "operations"
    | "debug-shares"
    | "debug-issues"
    | "sandboxes"
    | "agent-questions"
    | "debug-operations"
    | "debug-site-deployment"
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
    | import("../diagnostics/operation-reader.js").OperationInspection
    | { target: "imports"; selection: string | null; offset: number }
    | { target: "import-approval"; selection: string };
  /** One audience-scoped query of retained evidence, never a permission grant. */
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
  /** True lists pending claims read-only; an explicit decision reviews one exact
   * proposal in the authenticated audience. Never supplies audience authority. */
  pendingMemory?: true | { action: "accept" | "reject"; id: string };
  /** Privately stage evidence-grounded style only; never approve or publish. */
  personalitySuggestion?: import("../reflection/global-proposal.js").GlobalProposalInput;
  /** Stage from one retained reflection publication, never its generated text as evidence. */
  reflectionPersonalitySuggestion?: import("../reflection/global-proposal.js").ReflectionPersonalitySuggestion;
  /** Observe only the current message with a fixed Jev rubric. */
  jevObservation?: boolean;
  /** Read existing private hypotheses through an effect-free model continuation. */
  reflectionReview?: import("./reflection-review.js").ReflectionReview;
  /** Request bounded source-scoped reflection, not immediate evaluation or delivery. */
  reflectionRequest?: {
    evidenceIds: string[];
    mode: "idle" | "deep";
    /** Omitted by older replies; defaults to reflection. No additional sources/tools. */
    kind?: "reflection" | "curiosity";
  };
  /** Explicit advisory evaluation of existing scoped evidence. */
  jury?: import("../reflection/jury.js").JuryRequest;
  /** Submit exact evaluated behavior through the host's coding admission path. */
  skillCodingProposal?: { candidateId: string; workspace: string };
  /** Stage an existing reflection as a pending hypothesis, never accept it. */
  reflectionMemory?: { id: string; subjectSourceId: string };
  /** Volatile read-only Rivet inspection; not automatic cross-audience history. */
  rivet?: import("./rivet.js").RivetRequest;
  /** List named operations (null), or prepare one; credential controls remain separate. */
  browserProposal?: { operation: string | null };
  /** Version-bound global style change; host receipt establishes the outcome. */
  personalityPreview?: PersonalityPreview;
  /** Read impact, or select deletion using the exact current preview fingerprint. */
  forgetPreview?: { sourceId: string; apply?: string };
  /** Scoped held-out candidate suitability; never promotion or a send. */
  personalityEvaluate?: import("../runtime/personality-evaluation-preview.js").PersonalityEvaluateInput;
  /** A string cancels a selection; an object reviews or runs a bounded import task. */
  importCancel?: string | import("../runtime/import-task.js").ImportTaskCommand;
  /** Evaluate one retained immutable skill proposal; never install or promote it. */
  skillEvaluationRequest?: {
    candidateId: string;
    heldOutEvidenceIds: string[];
  };
  /** Issue one short-lived dashboard login link to the owner privately. */
  dashboardLogin?: boolean;
  /** Persistent schedules and event subscriptions bound to their saved scope. */
  wakeup?: import("../wakeups/state.js").WakeupAction;
  apps?: import("../apps/client.js").AppsRequest;
  /** Slack: defaults to incoming placement in one-to-one DMs, otherwise a reply thread; false selects the main conversation. */
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
  /** Captured host ceiling, intersected with current availability by the runtime.
   * Omitted IDs/turn deny modular actions, including legacy worker requests. */
  capabilityIds?: readonly string[];
  capabilityTurn?: import("../capabilities/contracts.js").CapabilityTurn;
  /** Host-only effect checks. Never serialize this callback to a provider. */
  effectGuard?: import("../sentinel/contracts.js").EffectGuard;
  settingsAvailable?: boolean;
  debugShareResolveAvailable?: boolean;
  agentConversation?: boolean;
  agentWebhooksAvailable?: boolean;
  artifactsAvailable?: boolean;
  /** Host-enforced action boundary; omitted preserves legacy mixed-role turns. */
  agentRole?: "interaction" | "execution" | "repository" | "mind";
  system: string;
  messages: ConversationMessage[];
  /** Host-only scoped images: at most 8, 5 MiB each and 20 MiB total.
   * The caller authorizes evidence access; providers reject invalid inputs.
   * Never serialize bytes into text prompts, history, or journals. */
  images?: ModelImageInput[];
  /** Host-only accounting label, never part of a provider prompt. */
  usageStage?: "fast" | "deep" | "synthesis" | "execution" | "reflection";
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
  ampThreadsAvailable?: boolean;
  modelStatusAvailable?: boolean;
  mcpAvailable?: boolean;
  /** Set by the MCP wrapper, independently of enabled tools. */
  mcpPermissionAvailable?: boolean;
  /** Historical receipt reads remain available independently of enabled tools. */
  mcpProposalAvailable?: boolean;
  /** Host-only read ceiling for MCP wrappers; never serialize into prompts.
   * Selected connections do not grant tools or bypass current permissions. */
  mcpReadScope?: { connections: string[] };
  /** Host-only transient MCP observation; never serialize into prompts/journals. */
  onMcpObservation?: (text: string) => void;
  /** Host-only sentinel evidence, including untrusted catalog pages. */
  onSentinelObservation?: (text: string) => void;
  latencyAvailable?: boolean;
  telemetryAvailable?: boolean;
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
  environmentAvailable?: boolean;
  browserTaskAvailable?: boolean;
  researchAvailable?: boolean;
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
  messagingAvailable?: boolean;
  socialAvailable?: boolean;
  executionAvailable?: boolean;
  workflowAvailable?: boolean;
  javascriptAvailable?: boolean;
  emojiSearchAvailable?: boolean;
  readImageAvailable?: boolean;
  readVideoAvailable?: boolean;
  repositoryAvailable?: boolean;
  repositoryReadAvailable?: boolean;
  /** Execution-worker read access to June's git-backed mind. */
  mindAvailable?: boolean;
  /** Background reflection steps only (agentRole "mind"). */
  mindStepAvailable?: boolean;
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
    /** Host-only synchronous admission assertion; throws if the frozen task's
     * authority is no longer current. Never serialize or send to the provider.
     * Call after all preparatory awaits, immediately before task submission
     * (including inside an SDK that awaits preparation). Keep signal checks.
     * Optional for legacy callers; the production coding actor always supplies
     * it. Rejection does not authorize retry, replacement or lease release.
     */
    assertCurrent?: () => void;
  }): Promise<CodingResult>;
}
