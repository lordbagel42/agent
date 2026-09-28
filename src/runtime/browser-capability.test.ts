import { describe, expect, it, vi } from "vitest";
import type { BrowserCompanion } from "../browser/companion.js";
import type { ModelRequest } from "../core/contracts.js";
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
function fixture() {
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
      senderId: "owner",
      direct: true,
      text: "Review this page",
      occurredAt: 1,
      address: { channel: "slack", accountId: "a", conversationId: "dm" },
      metadata: { channelType: "im" },
    },
    scope: { key: ["owner"], private: true },
    audience: "owner",
    eventId: "event",
    operationId: "operation",
    origin: "event",
    phase: "reply",
    ownerTurn: true,
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
  return { context, run };
}
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
    expect(guest.browserTaskAvailable).toBe(false);
    expect(guest.system).toContain("Browser work is unavailable in this turn");
  });
  it("denies guests, synthesis, wakeups and stale requests", async () => {
    for (const change of [
      { ownerTurn: false },
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
  it("returns the private task question/liveView and reviews actual images without tools", async () => {
    const { context, run } = fixture();
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
      { evidenceId: "frame", mimeType: "image/png", data: new Uint8Array([1]) },
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
  });
});
