import type { MessageEvent } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { isOwner } from "../core/social.js";
import { availableMetadataCapabilityIds } from "./capability-mounts.js";
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
  if (!scope) return {};
  return {
    capabilityIds: availableMetadataCapabilityIds(deps),
    settingsAvailable: !!deps.settings,
    debugShareResolveAvailable: !!deps.debugShare?.resolve,
    agentWebhooksAvailable: !!deps.agents,
    workspaces: deps.coding ? Object.keys(deps.coding.workspaces) : [],
    codingJobsAvailable: true,
    searchAvailable: !!deps.channels[event.address.channel]?.search,
    slackHistoryAvailable:
      event.address.channel === "slack" && !!deps.channels.slack?.shareHistory,
    webSearchAvailable: !!deps.webSearch?.available,
    javascriptAvailable: true,
    emojiSearchAvailable: !!deps.emojiSearch?.available,
    readImageAvailable:
      event.address.channel === "slack" &&
      !!event.metadata?.files?.length &&
      !!deps.channels.slack?.readImage,
    readVideoAvailable:
      event.address.channel === "slack" &&
      !!event.metadata?.files?.length &&
      !!deps.channels.slack?.readVideo,
    repositoryAvailable: !!deps.repository,
    releaseAvailable: !!deps.release,
    modelStatusAvailable: !!deps.modelStatus,
    ampThreadsAvailable: !!deps.ampThreads,
    mcpAvailable: deps.mcpAvailable === true,
    latencyAvailable: !!deps.latency,
    telemetryAvailable: !!deps.telemetry,
    analyticsAvailable: !!deps.analytics,
    inspectionAvailable: !!deps.inspection,
    appsAvailable: !!deps.apps,
    artifactsAvailable: !!deps.artifacts,
    importCancelAvailable: !!(deps.importCancel || deps.importTask),
    memoryAvailable: !!deps.memory,
    recallAvailable: !!deps.memory,
    pendingMemoryAvailable: !!deps.memory,
    personalitySuggestionAvailable: !!deps.memory?.personality,
    jevObservationAvailable:
      !!deps.jev && Buffer.byteLength(event.text) <= 4096,
    reflectionAvailable: !!deps.reflection,
    reflectionRequestAvailable: !!deps.memory && !!deps.reflection,
    reflectionReviewAvailable:
      !!deps.memory && !!deps.reflection?.evidenceCurrent,
    reflectionMemoryAvailable: !!deps.memory && !!deps.reflection,
    reflectionPersonalitySuggestionAvailable:
      !!deps.memory?.personality && !!deps.reflection,
    skillEvaluationRequestAvailable: !!deps.memory && !!deps.reflection,
    skillCodingProposalAvailable:
      !!deps.memory && !!deps.reflection && !!deps.coding,
    juryAvailable: !!deps.memory && !!deps.jury,
    e2bAvailable: deps.e2b?.available === true,
    environmentAvailable: deps.environments?.available === true,
    browserTaskAvailable: !!deps.browserCompanion,
    researchAvailable: !!deps.research,
    webEmbedAvailable:
      event.address.channel === "slack" &&
      !!deps.channels.slack?.webEmbedOrigins?.length,
    webEmbedOrigins: [...(deps.channels.slack?.webEmbedOrigins ?? [])],
    rivetAvailable: !!deps.rivet,
    browserProposalAvailable: !!deps.browserProposal,
    personalityPreviewAvailable: true,
    forgetPreviewAvailable: !!deps.memory,
    personalityEvaluateAvailable: !!deps.personalityEvaluation,
    // A dashboard login issues an authentication credential, not a task action.
    dashboardLoginAvailable:
      isOwner(event, deps.owner) && scope.private && !!deps.dashboardLogin,
    socialAvailable: event.address.channel === "slack" && !!deps.social,
    wakeupAvailable: event.address.channel === "slack" && !!deps.wakeups,
    workflowAvailable: !!deps.workflows,
  };
}

export function currentExecutionCapabilities(
  deps: Dependencies,
  event: MessageEvent,
  ceiling: PromptCapabilities,
): PromptCapabilities {
  const available = executionCapabilities(deps, event);
  return {
    capabilityIds: (ceiling.capabilityIds ?? []).filter((id) =>
      available.capabilityIds?.includes(id),
    ),
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
