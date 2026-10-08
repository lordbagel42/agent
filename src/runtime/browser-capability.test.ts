import { describe, expect, it, vi } from "vitest";
import type { BrowserCompanion } from "../browser/companion.js";
import type { MessageEvent, ModelRequest } from "../core/contracts.js";
import { routeEvent } from "../core/routing.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { type CapabilityContext, runCapability } from "./capabilities.js";
import {
  currentExecutionCapabilities,
  executionCapabilities,
} from "./execution-context.js";
import { buildModelRequest } from "./prompt.js";
import type { Dependencies } from "./registry.js";

const command = {
  action: "start" as const,
  url: "https://example.com/",
  goal: "Review the page",
};
const request: ModelRequest = {
  system: "June personality context",
  messages: [],
  workspaces: [],
  agentRole: "execution",
  browserTaskAvailable: true,
};
const taskTurns = [
  ["owner DM", "owner", "im"],
  ["owner channel", "owner", "channel"],
  ["guest DM", "guest", "im"],
  ["guest channel", "guest", "channel"],
  ["guest group DM", "guest", "mpim"],
] as const;

function fixture(
  senderId = "owner",
  channelType: NonNullable<MessageEvent["metadata"]>["channelType"] = "im",
) {
  const run = vi.fn().mockResolvedValue({
    status: "waiting_for_input",
    question: "Reply with the PIN",
    liveView: {
      available: true,
      url: "https://example.com/console/browser/task",
    },
  });
  const context: CapabilityContext = {
    event: {
      type: "message",
      id: "event",
      messageId: "message",
      senderId,
      direct: channelType === "im",
      botMentioned: true,
      text: "Review this page",
      occurredAt: 1,
      address: {
        channel: "slack",
        accountId: "a",
        conversationId: channelType === "im" ? "dm" : "channel",
      },
      metadata: { channelType, files: [{ id: "F1" }] },
    },
    scope: { key: ["private", "owner"], private: true },
    audience: '["private","owner"]',
    eventId: "event",
    operationId: "operation",
    origin: "event",
    phase: "reply",
    ownerTurn: senderId === "owner",
    deletionRevision: 0,
    personalityVersion: undefined,
    workspaces: [],
    signal: new AbortController().signal,
    valid: () => true,
    model: { reply: vi.fn().mockResolvedValue({ text: "Visual review" }) },
    deps: {
      owner: {
        id: "owner",
        identities: [{ channel: "slack", accountId: "a", senderId: "owner" }],
      },
      browserCompanion: { run } as unknown as BrowserCompanion,
    },
    ports: {} as CapabilityContext["ports"],
  };
  const scope = routeEvent(context.event, context.deps.owner);
  if (!scope) throw new Error("Missing task route");
  context.scope = scope;
  context.audience = JSON.stringify(scope.key);
  return { context, run };
}

describe("execution task capability ceilings", () => {
  it.each(taskTurns)(
    "offers configured task capabilities in %s",
    (_name, sender, channel) => {
      const { context } = fixture(sender, channel);
      // Only configuration presence is inspected here; no service is invoked.
      const deps = {
        ...context.deps,
        model: context.model,
        channels: {
          slack: {
            search: vi.fn(),
            shareHistory: vi.fn(),
            readImage: vi.fn(),
            readVideo: vi.fn(),
            webEmbedOrigins: ["https://example.com"],
          },
        },
        coding: { workspaces: { app: {} } },
        settings: {},
        debugShare: { resolve: vi.fn() },
        agents: {},
        webSearch: { available: true },
        emojiSearch: { available: true },
        repository: {},
        release: vi.fn(),
        modelStatus: vi.fn(),
        ampThreads: {},
        mcpAvailable: true,
        latency: {},
        telemetry: {},
        analytics: vi.fn(),
        inspection: vi.fn(),
        apps: {},
        artifacts: {},
        importCancel: vi.fn(),
        memory: { personality: {} },
        jev: {},
        reflection: { evidenceCurrent: vi.fn() },
        jury: {},
        e2b: { available: true },
        environments: { available: true },
        research: {},
        rivet: {},
        browserProposal: vi.fn(),
        personalityEvaluation: {},
        dashboardLogin: {},
        social: {},
        wakeups: {},
        workflows: {},
      } as unknown as Dependencies;
      const ceiling = executionCapabilities(deps, context.event);
      expect(ceiling).toEqual({
        settingsAvailable: true,
        debugShareResolveAvailable: true,
        agentWebhooksAvailable: true,
        workspaces: ["app"],
        codingJobsAvailable: true,
        searchAvailable: true,
        slackHistoryAvailable: true,
        webSearchAvailable: true,
        javascriptAvailable: true,
        emojiSearchAvailable: true,
        readImageAvailable: true,
        readVideoAvailable: true,
        repositoryAvailable: true,
        releaseAvailable: true,
        modelStatusAvailable: true,
        ampThreadsAvailable: true,
        mcpAvailable: true,
        latencyAvailable: true,
        telemetryAvailable: true,
        analyticsAvailable: true,
        inspectionAvailable: true,
        appsAvailable: true,
        artifactsAvailable: true,
        importCancelAvailable: true,
        memoryAvailable: true,
        recallAvailable: true,
        pendingMemoryAvailable: true,
        personalitySuggestionAvailable: true,
        jevObservationAvailable: true,
        reflectionAvailable: true,
        reflectionRequestAvailable: true,
        reflectionReviewAvailable: true,
        reflectionMemoryAvailable: true,
        reflectionPersonalitySuggestionAvailable: true,
        skillEvaluationRequestAvailable: true,
        skillCodingProposalAvailable: true,
        juryAvailable: true,
        e2bAvailable: true,
        environmentAvailable: true,
        browserTaskAvailable: true,
        researchAvailable: true,
        webEmbedAvailable: true,
        webEmbedOrigins: ["https://example.com"],
        rivetAvailable: true,
        browserProposalAvailable: true,
        personalityPreviewAvailable: true,
        forgetPreviewAvailable: true,
        personalityEvaluateAvailable: true,
        dashboardLoginAvailable: sender === "owner" && channel === "im",
        socialAvailable: true,
        wakeupAvailable: true,
        workflowAvailable: true,
      });
      expect(
        executionCapabilities(deps, {
          ...context.event,
          metadata: { channelType: channel },
        }),
      ).toMatchObject({ readImageAvailable: false, readVideoAvailable: false });
    },
  );

  it("intersects captured grants with current configuration and denies report-only escalation", () => {
    const { context } = fixture("guest", "channel");
    const deps = {
      ...context.deps,
      model: context.model,
      channels: {
        slack: {
          webEmbedOrigins: ["https://kept.example", "https://new.example"],
        },
      },
      coding: { workspaces: { kept: {}, added: {} } },
      mcpAvailable: true,
    } as unknown as Dependencies;
    const ceiling = {
      browserTaskAvailable: true,
      environmentAvailable: true,
      mcpAvailable: false,
      workspaces: ["kept", "removed"],
      webEmbedAvailable: true,
      webEmbedOrigins: ["https://kept.example", "https://removed.example"],
    };
    const current = currentExecutionCapabilities(deps, context.event, ceiling);
    expect(current).toMatchObject({
      browserTaskAvailable: true,
      mcpAvailable: false,
      workspaces: ["kept"],
      webEmbedAvailable: true,
      webEmbedOrigins: ["https://kept.example"],
    });
    expect(current.environmentAvailable).not.toBe(true);
    delete deps.browserCompanion;
    expect(
      currentExecutionCapabilities(deps, context.event, ceiling)
        .browserTaskAvailable,
    ).not.toBe(true);
    const reportOnly = currentExecutionCapabilities(deps, context.event, {});
    expect(
      Object.entries(reportOnly).filter(
        ([name, value]) => name.endsWith("Available") && value,
      ),
    ).toEqual([]);
    expect(reportOnly.workspaces).toEqual([]);
    expect(reportOnly.webEmbedOrigins).toEqual([]);
    const unadmitted = { ...context.event, botMentioned: false };
    expect(executionCapabilities(deps, unadmitted)).toEqual({});
    expect(
      currentExecutionCapabilities(deps, unadmitted, ceiling).workspaces,
    ).toEqual([]);
    expect(
      executionCapabilities(deps, {
        ...context.event,
        address: { ...context.event.address, accountId: "unrecognized" },
      }),
    ).toEqual({});
  });
});

describe("browser worker capability", () => {
  it("exposes and accepts browserTask only for enabled execution workers", () => {
    const reply = JSON.stringify({ text: "", browserTask: command });
    expect(parseReply(reply, [], request).browserTask).toEqual(command);
    for (const agentRole of [undefined, "interaction"] as const) {
      expect(
        replyJsonSchema([], { browserTaskAvailable: true, agentRole })
          .properties,
      ).not.toHaveProperty("browserTask");
      expect(() =>
        parseReply(reply, [], { browserTaskAvailable: true, agentRole }),
      ).toThrow();
    }
    expect(() =>
      parseReply(
        JSON.stringify({
          text: "",
          browserTask: command,
          browserProposal: { operation: null },
        }),
        [],
        { ...request, browserProposalAvailable: true },
      ),
    ).toThrow();
  });
  it("propagates the scoped capability ceiling and teaches interaction delegation", () => {
    const { context } = fixture();
    const deps = {
      ...context.deps,
      channels: {},
      model: context.model,
    } as Dependencies;
    const ceiling = executionCapabilities(deps, context.event);
    expect(ceiling.browserTaskAvailable).toBe(true);
    expect(
      currentExecutionCapabilities(deps, context.event, {})
        .browserTaskAvailable,
    ).toBe(false);
    const capabilities = currentExecutionCapabilities(
      deps,
      context.event,
      ceiling,
    );
    const input = {
      event: context.event,
      owner: deps.owner,
      history: [],
      now: new Date(),
      models: { current: { provider: "codex", model: "test" } },
      capabilities,
    };
    const interaction = buildModelRequest({
      ...input,
      agentRole: "interaction",
    });
    expect(interaction.system).toContain(
      "Delegate using the existing execution roster",
    );
    expect(replyJsonSchema([], interaction).properties).not.toHaveProperty(
      "browserTask",
    );
    const worker = buildModelRequest({ ...input, agentRole: "execution" });
    expect(worker.browserTaskAvailable).toBe(true);
    expect(replyJsonSchema([], worker).properties).toHaveProperty(
      "browserTask",
    );
    const guest = buildModelRequest({
      ...input,
      agentRole: "execution",
      event: { ...context.event, senderId: "guest" },
    });
    expect(guest.browserTaskAvailable).toBe(true);
    expect(replyJsonSchema([], guest).properties).toHaveProperty("browserTask");
  });
  it("denies synthesis, wakeups and stale requests", async () => {
    for (const change of [
      { phase: "synthesis" },
      { origin: "wakeup" },
      { valid: () => false },
    ] as const) {
      const { context, run } = fixture();
      await runCapability({ text: "", browserTask: command }, request, {
        ...context,
        ...change,
      });
      expect(run).not.toHaveBeenCalled();
    }
  });
  it.each(taskTurns)(
    "returns task results and reviews actual images without tools in %s",
    async (_name, sender, channel) => {
      const { context, run } = fixture(sender, channel);
      const result = await runCapability(
        { text: "", browserTask: command },
        request,
        context,
      );
      expect(JSON.parse(result.text)).toMatchObject({
        status: "waiting_for_input",
        question: "Reply with the PIN",
        liveView: { available: true },
      });
      const browserCall = run.mock.calls[0];
      expect(browserCall).toBeDefined();
      if (!browserCall) throw new Error("Missing browser call");
      const review = browserCall[1].review;
      const images = [
        {
          evidenceId: "frame",
          mimeType: "image/png",
          data: new Uint8Array([1]),
        },
      ];
      expect(
        await review("Untrusted report", images, new AbortController().signal),
      ).toBe("Visual review");
      const reviewRequest = vi.mocked(context.model.reply).mock.calls[0]?.[0];
      expect(reviewRequest).toBeDefined();
      if (!reviewRequest) throw new Error("Missing visual review");
      expect(reviewRequest.images).toBe(images);
      expect(reviewRequest.system).toContain(request.system);
      expect(reviewRequest.system).toContain("June");
      expect(
        Object.entries(reviewRequest).filter(
          ([key, value]) => key.endsWith("Available") && value,
        ),
      ).toEqual([]);
    },
  );
});
