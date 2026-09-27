import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { setupTest } from "../../tests/rivet.js";
import { createSlackIngressDiagnostics } from "../channels/slack-ingress.js";
import type {
  MessageEvent,
  ModelRequest,
  OutboundMessage,
} from "../core/contracts.js";
import { createHttpApp } from "../http/app.js";
import { parseReply, replyJsonSchema } from "../models/provider.js";
import { DiagnosticLog } from "./diagnostics.js";
import { createLatencyDiagnostics } from "./latency.js";
import { createJuneRegistry } from "./registry.js";

const owner = {
  id: "raygen",
  identities: [{ channel: "slack" as const, accountId: "T1", senderId: "U1" }],
};
const event: MessageEvent = {
  type: "message",
  id: "private-event",
  senderId: "U1",
  messageId: "1800000000.123456",
  occurredAt: Date.now(),
  direct: true,
  address: { channel: "slack", accountId: "T1", conversationId: "private-dm" },
  text: "private-content",
  metadata: { senderName: "private-name" },
};

test("persistent diagnostics exclude sensitive inputs and preserve original clocks without replay reconstruction", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-logs-"));
  const path = join(directory, "logs.sqlite");
  let log = new DiagnosticLog(path, "a".repeat(40));
  t.onTestFinished(async () => {
    log.close();
    await rm(directory, { recursive: true, force: true });
  });
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  t.onTestFinished(() => clock.mockRestore());
  const original = createLatencyDiagnostics(log);
  original.begin(event);
  const timing = original.providerTiming(event, "fast");
  clock.mockReturnValue(13);
  timing("submitted");
  clock.mockReturnValue(117);
  timing("terminal");
  clock.mockReturnValue(141);
  timing("validated");
  original.delivered(
    event,
    "text",
    { status: "sent", messageId: "1800000001.000001" },
    false,
  );
  original.mark(event, "finished");
  original.mark(event, "released");
  clock.mockReturnValue(211);
  timing("retired");
  const ingress = createSlackIngressDiagnostics((entry) => log.ingress(entry));
  const request = new Request(
    "https://private-url.test/?secret=private-secret",
    {
      method: "POST",
      headers: { authorization: "private-token" },
      body: "private-body",
    },
  );
  ingress.record(request, "signature_rejected");
  const before = log.snapshot();
  log.close();
  log = new DiagnosticLog(path, "b".repeat(40));
  const restarted = createLatencyDiagnostics(log);
  restarted.mark(event, "fast_started");
  restarted.providerTiming(event, "fast")("submitted");
  expect(restarted.snapshot().traces).toEqual([]);
  expect(log.snapshot().traces).toEqual(before.traces);
  expect(log.session.processId).not.toBe(before.processId);
  const report = restarted.report("recent", { ...event, id: "lookup" });
  expect(report).toContain("submitted→terminal 104.0ms; validation 24.0ms");
  expect(report).toContain("cleanup 70.0ms");
  expect(report).toContain(`revision ${"a".repeat(40)}`);
  expect(report).toContain("Slack E2E 876.5ms");
  expect(JSON.stringify(log.snapshot())).not.toMatch(
    /private-|1800000000\.123456/,
  );
  expect(log.report()).toContain("slack.signature_rejected");
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  for (const file of [path, `${path}-wal`])
    expect((await readFile(file)).includes(Buffer.from("private-"))).toBe(
      false,
    );
});

test("June reads persisted logs only for owner-private turns; HTTP, guest, channel and synthesis reads fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "june-log-access-"));
  const log = new DiagnosticLog(join(directory, "logs.sqlite"));
  t.onTestFinished(async () => {
    log.close();
    await rm(directory, { recursive: true, force: true });
  });
  const latency = createLatencyDiagnostics(log);
  const reads = vi.spyOn(log, "report");
  const sent: OutboundMessage[] = [];
  const requests: ModelRequest[] = [];
  let search = false;
  const registry = createJuneRegistry({
    owner,
    latency,
    channels: {
      slack: {
        channel: "slack",
        capabilities: { text: true, reactions: true, threads: true },
        async receive() {
          return { response: new Response(), events: [] };
        },
        async send(outbound) {
          sent.push(JSON.parse(JSON.stringify(outbound)));
          return { status: "sent", messageId: "sent" };
        },
      },
    },
    webSearch: {
      available: true,
      description: "fixture",
      async search() {
        return {
          status: "ready",
          results: [
            {
              title: "fixture",
              url: "https://example.com",
              snippet: "public evidence",
            },
          ],
        };
      },
    },
    model: {
      async reply(request) {
        requests.push(request);
        if (search && request.webSearchAvailable)
          return { text: "", webSearch: "public query" };
        if (request.latencyAvailable) {
          expect(request.system).toContain(
            "Only the configured owner user account may view logs",
          );
          expect(replyJsonSchema([], request).properties).toHaveProperty(
            "latency",
          );
          return parseReply('{"text":"","latency":"logs"}', [], request);
        }
        expect(replyJsonSchema([], request).properties).not.toHaveProperty(
          "latency",
        );
        // A nonconforming provider cannot bypass the host permission check.
        return { text: "", latency: "logs" };
      },
    },
  });
  const { client } = await setupTest(t, registry);
  const deliver = async (
    id: string,
    extra: Partial<MessageEvent> = {},
    key = ["private", "raygen"],
  ) => {
    const actor = client.conversation.getOrCreate(key);
    const completed = Object.values((await actor.snapshot()).events).filter(
      (entry) => entry.done,
    ).length;
    await actor.send("inbox", {
      type: "event",
      event: { ...event, id, messageId: id, text: "Show your logs", ...extra },
    });
    await expect
      .poll(
        async () =>
          Object.values((await actor.snapshot()).events).filter(
            (entry) => entry.done,
          ).length,
      )
      .toBe(completed + 1);
  };
  await deliver("owner-logs");
  expect(JSON.stringify(sent[0]?.content)).toContain("process_started");
  expect(JSON.stringify(sent[0]?.content).length).toBeLessThan(3500);
  expect(requests).toHaveLength(1);
  expect(reads).toHaveBeenCalledTimes(1);
  await deliver(
    "public-logs",
    { direct: false, address: { ...event.address, conversationId: "C1" } },
    ["slack", "T1", "C1", ""],
  );
  await deliver(
    "guest-logs",
    { senderId: "U2", metadata: { channelType: "im" } },
    ["guest", "slack", "T1", "private-dm", "", "U2"],
  );
  expect(JSON.stringify(sent.slice(1))).not.toContain("process_started");
  search = true;
  await deliver("synthesis-logs");
  expect(requests.at(-1)?.latencyAvailable).toBe(false);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(() => parseReply('{"text":"","latency":"logs"}', [])).toThrow();

  const token = "fixture-owner-token-at-least-32-characters";
  const app = createHttpApp({
    owner,
    latency,
    channels: {},
    operatorToken: token,
    async submit() {},
    async ready() {
      return true;
    },
    async inspectConversation() {},
    async inspectJob() {},
    async resumeJob() {
      return false;
    },
  });
  for (const authorization of ["", "Bearer wrong-token"])
    expect(
      (await app.request("/operator/logs", { headers: { authorization } }))
        .status,
    ).toBe(401);
  const response = await app.request("/operator/logs", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain("process_started");
});
