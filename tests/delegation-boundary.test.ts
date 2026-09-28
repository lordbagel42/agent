import { randomBytes } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createSlackSearch } from "../src/channels/slack-search.js";
import type {
  CompanionReply,
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../src/core/contracts.js";
import { EvidenceStore } from "../src/memory/store.js";
import { executionKey } from "../src/runtime/execution.js";
import { conversationInputId } from "../src/runtime/inbox.js";
import { createLatencyDiagnostics } from "../src/runtime/latency.js";
import { createJuneRegistry } from "../src/runtime/registry.js";
import { setupTest } from "./rivet.js";

test("delegated tools are read before reporting and private credentials never enter model history or replay", async (t) => {
  const owner = {
    id: "owner",
    identities: [{ channel: "slack" as const, accountId: "T", senderId: "U" }],
  };
  const sent: OutboundMessage[] = [];
  const turns: ModelRequest[] = [];
  const work: ModelRequest[] = [];
  let unknownLinkDelivery = false;
  const logs = vi.fn(() => "RAW_TRACE provider_ms=9700 typing_ms=80");
  const issue = vi.fn(() => ({
    url: "https://june.example/PRIVATE_SINGLE_USE_TOKEN",
    expiresAt: "2030-01-01T00:00:00Z",
  }));
  const registry = createJuneRegistry({
    owner,
    latency: { ...createLatencyDiagnostics(), report: logs },
    dashboardLogin: { issue, redact: (text) => text },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          if (
            unknownLinkDelivery &&
            message.content.type === "text" &&
            message.content.text.includes("PRIVATE_SINGLE_USE_TOKEN")
          )
            return { status: "unknown", code: "lost_response" };
          return { status: "sent", messageId: `sent-${sent.length}` };
        },
      },
    },
    model: {
      async reply(request): Promise<CompanionReply> {
        // Timing hooks are functions, not prompt data.
        turns.push({ ...request, onProviderTiming: undefined });
        if (request.system.includes("Execution completion"))
          return {
            text: request.system.includes('"task":"login-unknown"')
              ? "I couldn't confirm that the sign-in link reached you."
              : request.system.includes('"task":"logs"') &&
                  request.system.includes("Inference took 9.7 seconds")
                ? "The provider took 9.7 seconds; typing started promptly."
                : "Redundant delivery confirmation must not be generated.",
          };
        const text = JSON.parse(request.messages.at(-1)?.content ?? "{}").text;
        if (text === "inline") return { text: "", latency: "logs" };
        return {
          text: "Checking.",
          execution: [{ agent: text, action: "run", task: text }],
        };
      },
    },
    execution: {
      model: {
        async reply(request): Promise<CompanionReply> {
          work.push(structuredClone(request));
          const last = request.messages.at(-1)?.content;
          if (last === "logs") return { text: "", latency: "logs" };
          if (last === "login" || last === "login-unknown")
            return { text: "", dashboardLogin: true };
          if (last?.includes("RAW_TRACE"))
            return {
              text: "Inference took 9.7 seconds; typing took 80ms.",
              dashboardLogin: false,
            };
          // Even a worker returning silence cannot attest an unknown send.
          return { text: "" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const scope = ["private", owner.id];
  const june = client.conversation.getOrCreate(scope);
  let message = 123;
  const source = (text: string): MessageEvent => ({
    id: text,
    type: "message",
    messageId: `${message++}.000001`,
    occurredAt: Date.now(),
    address: { channel: "slack", accountId: "T", conversationId: "D" },
    senderId: "U",
    direct: true,
    metadata: { channelType: "im" },
    text,
  });
  const texts = () =>
    sent.flatMap((m) => (m.content.type === "text" ? [m.content.text] : []));
  const logsEvent = source("logs");
  await june.send("inbox", { type: "event", event: logsEvent });
  await expect
    .poll(texts, { timeout: 15000 })
    .toContain("The provider took 9.7 seconds; typing started promptly.");
  expect(logs).toHaveBeenCalledTimes(1);
  expect(work).toHaveLength(2);
  expect(work[1]?.messages.at(-1)?.content).toContain("RAW_TRACE");
  expect(JSON.stringify(turns)).not.toContain("RAW_TRACE");
  expect(texts().join(" ")).not.toContain("RAW_TRACE");

  const loginEvent = source("login");
  await june.send("inbox", { type: "event", event: loginEvent });
  await expect
    .poll(texts, { timeout: 15000 })
    .toContain(
      "Here's your sign-in link: https://june.example/PRIVATE_SINGLE_USE_TOKEN\nIt expires in 10 minutes.",
    );
  await expect.poll(() => work.length, { timeout: 15000 }).toBe(4);
  expect(issue).toHaveBeenCalledTimes(1);
  expect(
    texts().filter((text) => text.includes("PRIVATE_SINGLE_USE_TOKEN")),
  ).toHaveLength(1);
  expect(work.at(-1)?.dashboardLoginAvailable).toBe(false);
  expect(work.at(-1)?.messages.at(-1)?.content).toContain(
    "host already delivered the dashboard response",
  );
  expect(JSON.stringify([...turns, ...work])).not.toContain(
    "PRIVATE_SINGLE_USE_TOKEN",
  );
  const state = await june.snapshot();
  expect(JSON.stringify(state)).not.toContain("PRIVATE_SINGLE_USE_TOKEN");
  const worker = client.execution.getOrCreate(
    executionKey(scope, state.agents?.login ?? ""),
  );
  const requestId = Object.keys(state.delegations ?? {}).find((id) =>
    id.endsWith(":login"),
  );
  expect(requestId).toBeDefined();
  expect(JSON.stringify(await worker.result(requestId ?? ""))).not.toContain(
    "PRIVATE_SINGLE_USE_TOKEN",
  );
  const completionId = conversationInputId({
    type: "execution_result",
    agentId: state.agents?.login ?? "",
    requestId: requestId ?? "",
    source: loginEvent,
  });
  await expect
    .poll(async () => (await june.snapshot()).events[completionId]?.done, {
      timeout: 15000,
    })
    .toBe(true);
  expect((await worker.result(requestId ?? ""))?.silent).toBe(true);
  expect(
    turns.filter((request) => request.system.includes("Execution completion")),
  ).toHaveLength(1); // Logs were synthesized; the empty login report was not.
  expect(texts().join(" ")).not.toContain("Redundant delivery confirmation");

  // Replay and an invalid interaction-model directive cannot repeat either tool.
  await june.send("inbox", { type: "event", event: logsEvent });
  await june.send("inbox", { type: "event", event: loginEvent });
  await june.send("inbox", { type: "event", event: source("inline") });
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).every(
          (entry) => entry.done,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  expect(logs).toHaveBeenCalledTimes(1);
  expect(issue).toHaveBeenCalledTimes(1);
  expect(turns.every((request) => request.agentRole === "interaction")).toBe(
    true,
  );
  expect(work.every((request) => request.agentRole === "execution")).toBe(true);

  // An unconfirmed private send still needs an answer, never silence or retry.
  unknownLinkDelivery = true;
  await june.send("inbox", { type: "event", event: source("login-unknown") });
  await expect
    .poll(texts, { timeout: 15000 })
    .toContain("I couldn't confirm that the sign-in link reached you.");
  expect(work.at(-1)?.messages.at(-1)?.content).toContain(
    "Delivery was not confirmed; do not repeat this operation.",
  );
  expect(work.at(-1)?.messages.at(-1)?.content).not.toContain(
    "host already delivered",
  );
  expect(issue).toHaveBeenCalledTimes(2);
  expect(JSON.stringify([...turns, ...work])).not.toContain(
    "PRIVATE_SINGLE_USE_TOKEN",
  );
  await expect
    .poll(
      async () =>
        Object.values((await june.snapshot()).events).every(
          (entry) => entry.done,
        ),
      { timeout: 15000 },
    )
    .toBe(true);
});

test("delegated forget confirmation requires the token-bearing completion to have been sent", async (t) => {
  const owner = {
    id: "owner",
    identities: [{ channel: "slack" as const, accountId: "T", senderId: "U" }],
  };
  const scope = ["private", owner.id];
  const audience = JSON.stringify(scope);
  const store = new EvidenceStore(":memory:", randomBytes(32));
  t.onTestFinished(() => store.close());
  store.appendSource({
    id: "target",
    audiences: [audience],
    platform: "slack",
    account: "T",
    conversation: "D",
    author: "U",
    observedAt: 1,
    text: "Private source",
    sourceUrl: "https://example.com/source",
  });
  const sent: OutboundMessage[] = [];
  let outcome: "sent" | "unknown" | "rejected" = "unknown";
  let report = "";
  const registry = createJuneRegistry({
    owner,
    memory: { store, source: () => undefined, forget: async () => {} },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          if (
            message.content.type === "text" &&
            message.content.text.includes("!forget-confirm")
          ) {
            if (outcome === "unknown")
              return { status: "unknown", code: "fixture" };
            if (outcome === "rejected")
              return { status: "rejected", code: "fixture", retryable: false };
          }
          return { status: "sent", messageId: `out${sent.length}` };
        },
      },
    },
    model: {
      async reply(request) {
        if (request.system.includes("Execution completion"))
          return { text: report };
        return {
          text: "Checking the impact.",
          execution: [{ agent: "forgetter", action: "run", task: "forget" }],
        };
      },
    },
    execution: {
      model: {
        async reply(request) {
          const last = request.messages.at(-1)?.content ?? "";
          if (last === "forget")
            return { text: "", forgetPreview: { sourceId: "target" } };
          report = last;
          return { text: report };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const june = client.conversation.getOrCreate(scope);
  let sequence = 0;
  const turn = async (text: string) => {
    const id = `input-${++sequence}`;
    await june.send("inbox", {
      type: "event",
      event: {
        id,
        type: "message",
        messageId: `${sequence}.000001`,
        occurredAt: Date.now(),
        address: { channel: "slack", accountId: "T", conversationId: "D" },
        senderId: "U",
        direct: true,
        metadata: { channelType: "im" },
        forgetCommandEligible: true,
        text,
      },
    });
    await expect
      .poll(
        async () =>
          Object.values((await june.snapshot()).events).some(
            (record) => record.event.id === id && record.done,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
  };
  for (const status of ["unknown", "rejected", "sent"] as const) {
    outcome = status;
    const previous = sent.length;
    await turn("Preview forgetting target");
    const preview = () =>
      sent
        .slice(previous)
        .find(
          (message) =>
            message.content.type === "text" &&
            message.content.text.includes("!forget-confirm"),
        )?.content;
    await expect
      .poll(
        () =>
          sent
            .slice(previous)
            .map((message) =>
              message.content.type === "text" ? message.content.text : "",
            )
            .join("\n"),
        { timeout: 15000 },
      )
      .toContain("!forget-confirm");
    const content = preview();
    const token =
      content?.type === "text"
        ? content.text.match(/!forget-confirm ([a-f0-9]{32})/)?.[1]
        : undefined;
    expect(token).toBeDefined();
    expect(store.isDeleted("target")).toBe(false);
    outcome = "sent";
    await turn(`!forget-confirm ${token}`);
    expect(store.isDeleted("target")).toBe(status === "sent");
    const state = await june.snapshot();
    expect(state.forgetConfirmations?.[token ?? ""]?.status).toBe(
      status === "sent" ? "completed" : "pending",
    );
  }
});

test("cancelling a worker during Slack identity verification prevents the subsequent search request", async (t) => {
  const owner = {
    id: "owner",
    identities: [
      { channel: "slack" as const, accountId: "T123ABC", senderId: "U123ABC" },
    ],
  };
  const identity = Promise.withResolvers<Response>();
  const fetch = vi.fn<typeof globalThis.fetch>(() => identity.promise);
  const expiresAt = Date.now() + 600000;
  const search = createSlackSearch({
    teamId: "T123ABC",
    botToken: "synthetic-bot-token",
    fetch,
    now: Date.now,
    privateSearch: {
      ownerId: "owner",
      userId: "U123ABC",
      getAuthorization: () => ({
        ownerId: "owner",
        userId: "U123ABC",
        teamId: "T123ABC",
        userToken: ["xoxp", "synthetic", "fixture"].join("-"),
        grantedScopes: ["search:read.public", "search:read.im"],
        expiresAt,
      }),
    },
  });
  const settleIdentity = () =>
    identity.resolve(
      new Response(
        JSON.stringify({ ok: true, team_id: "T123ABC", user_id: "U123ABC" }),
      ),
    );
  t.onTestFinished(settleIdentity);
  const event: MessageEvent = {
    id: "search",
    type: "message",
    messageId: "1800000000.000123",
    occurredAt: Date.now(),
    address: {
      channel: "slack",
      accountId: "T123ABC",
      conversationId: "D123ABC",
    },
    senderId: "U123ABC",
    direct: true,
    text: "Find launch notes",
  };
  search.capture(event, undefined);
  const registry = createJuneRegistry({
    owner,
    model: {
      async reply() {
        return {
          text: "Checking.",
          execution: [
            { agent: "searcher", action: "run", task: "Find launch notes" },
          ],
        };
      },
    },
    execution: {
      model: {
        async reply() {
          return { text: "", search: "launch" };
        },
      },
    },
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        search: search.search,
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send() {
          return { status: "sent", messageId: "synthetic-send" };
        },
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const scope = ["private", "owner"];
  const june = client.conversation.getOrCreate(scope);
  await june.send("inbox", { type: "event", event });
  await expect.poll(() => fetch.mock.calls.length, { timeout: 15000 }).toBe(1);
  const id = (await june.snapshot()).agents?.searcher;
  expect(id).toBeDefined();
  const worker = client.execution.getOrCreate(executionKey(scope, id ?? ""));
  await worker.cancel("cancel-search");
  settleIdentity();
  await expect
    .poll(async () => (await worker.summary()).pending, { timeout: 15000 })
    .toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toBe(
    "https://slack.com/api/auth.test",
  );
});
