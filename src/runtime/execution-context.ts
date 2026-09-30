import type { MessageEvent } from "../core/contracts.js";
import { isOwnerRivetDm } from "../core/rivet.js";
import { routeEvent } from "../core/routing.js";
import { isOwner } from "../core/social.js";
import type { PromptCapabilities } from "./prompt.js";
import type { Dependencies } from "./registry.js";

/** Host-created authority, not model-supplied task prose. Session identity and
 * delivery placement must never replace the authenticated privacy audience. */
export interface ExecutionContext {
  version: 1;
  scopeKey: string[];
  audience: string;
  conversationKey: string[];
  originEventId: string;
  deletionRevision: number;
  sourceIds: string[];
  contextSourceIds: string[];
  personality: string;
  capabilities: PromptCapabilities;
}

/** A ceiling captured when June delegates. Recompute and intersect at use; a
 * queued request cannot acquire a capability enabled after its admission. */
export function executionCapabilities(
  deps: Dependencies,
  event: MessageEvent,
): PromptCapabilities {
  const scope = routeEvent(event, deps.owner);
  if (!scope || !isOwner(event, deps.owner)) return {};
  const privateTurn = scope.private;
  return {
    agentWebhooksAvailable: privateTurn && !!deps.agents,
    workspaces:
      privateTurn && deps.coding ? Object.keys(deps.coding.workspaces) : [],
    codingJobsAvailable: privateTurn,
    searchAvailable: !!deps.channels[event.address.channel]?.search,
    slackHistoryAvailable:
      event.address.channel === "slack" && !!deps.channels.slack?.shareHistory,
    webSearchAvailable: !!deps.webSearch?.available,
    javascriptAvailable: true,
    emojiSearchAvailable: privateTurn && !!deps.emojiSearch?.available,
    repositoryAvailable: !!deps.repository,
    releaseAvailable: !!deps.release,
    modelStatusAvailable: privateTurn && !!deps.modelStatus,
    mcpAvailable: privateTurn && deps.mcpAvailable === true,
    latencyAvailable: privateTurn && !!deps.latency,
    telemetryAvailable: privateTurn && !!deps.telemetry,
    analyticsAvailable: privateTurn && !!deps.analytics,
    inspectionAvailable: privateTurn && !!deps.inspection,
    appsAvailable: privateTurn && !!deps.apps,
    artifactsAvailable: !!deps.artifacts,
    importCancelAvailable: privateTurn && !!deps.importCancel,
    memoryAvailable: privateTurn && !!deps.memory,
    recallAvailable: privateTurn && !!deps.memory,
    pendingMemoryAvailable: privateTurn && !!deps.memory,
    personalitySuggestionAvailable: privateTurn && !!deps.memory?.personality,
    jevObservationAvailable:
      privateTurn && !!deps.jev && Buffer.byteLength(event.text) <= 4096,
    reflectionAvailable: privateTurn && !!deps.reflection,
    reflectionRequestAvailable:
      privateTurn && !!deps.memory && !!deps.reflection,
    reflectionReviewAvailable:
      privateTurn && !!deps.memory && !!deps.reflection?.evidenceCurrent,
    reflectionMemoryAvailable:
      privateTurn && !!deps.memory && !!deps.reflection,
    reflectionPersonalitySuggestionAvailable:
      privateTurn &&
      !!deps.memory?.personality &&
      !!deps.reflection &&
      (event.address.channel !== "slack" ||
        event.metadata?.channelType === "im"),
    skillEvaluationRequestAvailable:
      privateTurn && !!deps.memory && !!deps.reflection,
    skillCodingProposalAvailable:
      privateTurn && !!deps.memory && !!deps.reflection && !!deps.coding,
    juryAvailable: privateTurn && !!deps.memory && !!deps.jury,
    e2bAvailable: privateTurn && deps.e2b?.available === true,
    browserTaskAvailable: privateTurn && !!deps.browserCompanion,
    webEmbedAvailable:
      privateTurn &&
      event.address.channel === "slack" &&
      !!deps.channels.slack?.webEmbedOrigins?.length,
    webEmbedOrigins: privateTurn
      ? [...(deps.channels.slack?.webEmbedOrigins ?? [])]
      : [],
    rivetAvailable: isOwnerRivetDm(event, deps.owner) && !!deps.rivet,
    browserProposalAvailable: privateTurn && !!deps.browserProposal,
    personalityPreviewAvailable: privateTurn,
    forgetPreviewAvailable: privateTurn && !!deps.memory,
    personalityEvaluateAvailable: privateTurn && !!deps.personalityEvaluation,
    dashboardLoginAvailable: privateTurn && !!deps.dashboardLogin,
    socialAvailable: event.address.channel === "slack" && !!deps.social,
    wakeupAvailable:
      privateTurn && event.address.channel === "slack" && !!deps.wakeups,
    workflowAvailable: privateTurn && !!deps.workflows,
  };
}

export function currentExecutionCapabilities(
  deps: Dependencies,
  event: MessageEvent,
  ceiling: PromptCapabilities,
): PromptCapabilities {
  const available = executionCapabilities(deps, event);
  return {
    ...Object.fromEntries(
      Object.entries(available)
        .filter(([name, value]) => name.endsWith("Available") && value === true)
        .map(([name]) => [name, Reflect.get(ceiling, name) === true]),
    ),
    workspaces: (ceiling.workspaces ?? []).filter((name) =>
      available.workspaces?.includes(name),
    ),
    webSearchProvider: deps.webSearch?.description,
    webEmbedAvailable:
      available.webEmbedAvailable === true &&
      ceiling.webEmbedAvailable === true &&
      !!ceiling.webEmbedOrigins?.some((origin) =>
        available.webEmbedOrigins?.includes(origin),
      ),
    webEmbedOrigins:
      ceiling.webEmbedOrigins?.filter((origin) =>
        available.webEmbedOrigins?.includes(origin),
      ) ?? [],
    wakeupSources: deps.wakeups?.sources,
    workflowTools: deps.workflows
      ? Object.entries(deps.workflows.tools).map(([name, tool]) => ({
          name,
          description: tool.description,
        }))
      : [],
    jevQuestion: deps.jev?.question,
  };
}
