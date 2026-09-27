// Operator CLI, never mounted as an HTTP writer. See docs/latency.md.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createClient } from "rivetkit/client";
import { createSlackAdapter } from "../src/channels/slack.js";
import type { ModelProvider } from "../src/core/contracts.js";
import { createHttpApp } from "../src/http/app.js";
import {
  createLatencyDiagnostics,
  type LatencyTrace,
} from "../src/runtime/latency.js";
import { createLifecycle } from "../src/runtime/lifecycle.js";
import {
  createJuneRegistry,
  type JuneClientRegistry,
} from "../src/runtime/registry.js";
import { freeEnginePort, stopTestEngine } from "../tests/rivet.js";

async function capture(data: unknown) {
  const json = JSON.stringify(data, null, 2);
  if (process.env.JUNE_LATENCY_OUTPUT)
    await writeFile(process.env.JUNE_LATENCY_OUTPUT, json, {
      flag: "wx",
      mode: 0o600,
    });
  else console.log(json);
}

function summarize(trace: LatencyTrace) {
  const time = (stage: string) =>
    trace.observations.find((o) => o.stage === stage)?.ms;
  const span = (start: string, end: string) => {
    const a = time(start),
      b = time(end);
    return a === undefined || b === undefined ? null : b - a;
  };
  return {
    id: trace.id,
    probe: trace.probe,
    threaded: trace.threaded,
    transportMs: trace.transportMs ?? null,
    ingressMs: time("accepted") ?? null,
    httpAckMs: time("http_ack") ?? null,
    // Enqueue completion can race dequeue; submission_started is the honest
    // lower boundary, so this includes actor lookup and durable submission.
    queueMs: span("submission_started", "dequeued"),
    admissionMs: span("dequeued", "admitted"),
    prepareMs: span("admitted", "context_started"),
    contextMs: span("context_started", "context_ready"),
    modelIntentMs: span("context_ready", "fast_started"),
    modelMs: span("fast_started", "fast_finished"),
    postModelMs: span("fast_finished", "text_started"),
    sendMs: span("text_started", "text_sent"),
    typingAckMs: time("typing_accepted") ?? null,
    textualAckMs: time("ack_sent") ?? null,
    finalMs: time("text_sent") ?? null,
    turnMs: time("finished") ?? null,
    deliveries: trace.deliveries,
  };
}

const [mode = "help", ...args] = process.argv.slice(2);
if (mode === "report") {
  for (const file of args) {
    const data = JSON.parse(await readFile(file, "utf8"));
    console.log(
      JSON.stringify(
        { file, ...data, traces: data.traces.map(summarize) },
        null,
        2,
      ),
    );
  }
} else if (mode === "watch") {
  const token = process.env.JUNE_OPERATOR_TOKEN;
  if (!token || token.length < 32)
    throw new Error(
      "Supply JUNE_OPERATOR_TOKEN privately, never as an argument",
    );
  const base = new URL(process.env.JUNE_URL ?? "http://127.0.0.1:3080");
  if (base.username || base.password || base.search || base.hash)
    throw new Error("Clean private service URL required");
  const probe = randomUUID();
  console.error(
    `Send this yourself from the allowlisted HUMAN Slack account: ping ${probe}`,
  );
  console.error(
    "Do not send it using a bot, Amp Slack tool, or fabricated callback. Waiting up to 3 minutes.",
  );
  const deadline = Date.now() + 180_000;
  let startedAt: number | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/operator/latency", base), {
      redirect: "error",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`Diagnostics unavailable: HTTP ${response.status}`);
    const data = (await response.json()) as {
      revision?: string;
      startedAt: number;
      traces: LatencyTrace[];
    };
    if (startedAt !== undefined && data.startedAt !== startedAt)
      throw new Error(
        "Host restarted; observations are incomplete, do not resend automatically",
      );
    startedAt = data.startedAt;
    const trace = data.traces.find((t) => t.probe === probe);
    if (trace?.observations.some((o) => o.stage === "finished")) {
      await capture({
        mode: "human-slack-probe",
        revision: data.revision,
        startedAt,
        traces: [trace],
      });
      assert(
        trace.deliveries.some((d) => d.status === "sent" && d.pong),
        "No matching accepted pong; never automatically resend",
      );
      break;
    }
    await sleep(500);
  }
  if (Date.now() >= deadline)
    throw new Error("Probe timed out; no resend was attempted");
} else if (mode === "local") {
  // No inherited endpoints, shared state, or real Slack transports, even if the
  // caller has production variables. The optional model module is explicit.
  for (const name of Object.keys(process.env))
    if (name.startsWith("RIVET")) delete process.env[name];
  const count = Number(args[0] ?? 6);
  if (!Number.isInteger(count) || count < 1 || count > 20)
    throw new Error("Use 1–20 serial samples");
  const threaded = args.includes("--threaded");
  const directory = await mkdtemp(join(tmpdir(), "june-latency-"));
  const port = await freeEnginePort();
  process.env.RIVETKIT_STORAGE_PATH = directory;
  process.env.RIVET_INSPECTOR_DISABLE = "1";
  const latency = createLatencyDiagnostics();
  const lifecycle = createLifecycle();
  const owner = {
    id: "latency-fixture",
    identities: [
      { channel: "slack" as const, accountId: "T1", senderId: "U1" },
    ],
  };
  const signingSecret = randomUUID();
  const operatorToken = randomUUID();
  let outbound = 0;
  let expected = "";
  const delays = { context: 50, model: 100, typing: 200, send: 30 };
  const model: ModelProvider = process.env.JUNE_LATENCY_PROVIDER_MODULE
    ? (
        await import(
          pathToFileURL(resolve(process.env.JUNE_LATENCY_PROVIDER_MODULE)).href
        )
      ).model
    : {
        async reply() {
          await sleep(delays.model);
          return { text: `pong ${expected}` };
        },
      };
  const adapter = createSlackAdapter({
    signingSecret,
    botToken: "fixture-only",
    teamId: "T1",
    botUserId: "B1",
    ownerUserIds: ["U1"],
    contextEnabled: true,
    latency,
    async fetch(url, init) {
      const method = String(url).split("/").at(-1);
      if (method === "assistant.threads.setStatus") {
        await sleep(delays.typing);
        return Response.json({ ok: true });
      }
      if (method === "chat.postMessage") {
        await sleep(delays.send);
        const body = JSON.parse(String(init?.body));
        assert.equal(
          body.text.trim().toLowerCase(),
          `pong ${expected}`,
          "Provider did not produce a matching pong",
        );
        outbound++;
        return Response.json({
          ok: true,
          ts: `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1000).padStart(3, "0")}000`,
        });
      }
      await sleep(delays.context);
      if (method === "conversations.info")
        return Response.json({ ok: true, channel: { id: "D1", is_im: true } });
      if (method === "users.info")
        return Response.json({
          ok: true,
          user: { id: "U1", profile: { display_name: "Fixture" } },
        });
      return Response.json({ ok: true, messages: [] });
    },
  });
  const registry = createJuneRegistry({
    owner,
    channels: { slack: adapter },
    model,
    latency,
    lifecycle,
  });
  Object.assign(registry.config, {
    startEngine: true,
    startServices: false,
    enginePort: port,
    engineHost: "127.0.0.1",
    namespace: "default",
    token: "default",
    noWelcome: true,
    envoy: { poolName: "default" },
  });
  const client = createClient<JuneClientRegistry>({
    endpoint: `http://127.0.0.1:${port}`,
    namespace: "default",
    token: "default",
    poolName: "default",
  });
  const app = createHttpApp({
    owner,
    channels: { slack: adapter },
    operatorToken,
    latency,
    lifecycle,
    async submit(scope, event) {
      await client.conversation
        .getOrCreate(scope.key)
        .send("inbox", { type: "event", event });
    },
    ready: async () => true,
    inspectConversation: async () => ({}),
    inspectJob: async () => undefined,
    resumeJob: async () => false,
  });
  try {
    await registry.start();
    const readyDeadline = Date.now() + 20_000;
    while (!(await registry.routes.health()).ok) {
      assert(Date.now() < readyDeadline, "Engine did not become ready");
      await sleep(50);
    }
    // Privacy boundary: unauthenticated readers and bot-authored callbacks do
    // not get/create a timing trace or initiate a model call.
    assert.equal((await app.request("/operator/latency")).status, 401);
    for (let i = 0; i < count; i++) {
      expected = randomUUID();
      const ts = `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1000).padStart(3, "0")}000`;
      const payload = {
        type: "event_callback",
        team_id: "T1",
        event_id: randomUUID(),
        event_time: Math.floor(Date.now() / 1000),
        event: {
          type: "message",
          user: "U1",
          channel: "D1",
          channel_type: "im",
          ts,
          ...(threaded ? { thread_ts: "1700000000.000001" } : {}),
          text: `ping ${expected}`,
        },
      };
      const post = async (body: string) => {
        const timestamp = String(Math.floor(Date.now() / 1000));
        return app.request("/webhooks/slack", {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`,
          },
        });
      };
      const encoded = JSON.stringify(payload);
      if (i === 0) {
        const bot = JSON.stringify({
          ...payload,
          event: { ...payload.event, bot_id: "B-other", app_id: "A-other" },
        });
        assert.equal((await post(bot)).status, 200);
        assert.equal(latency.snapshot().traces.length, 0);
      }
      assert.equal((await post(encoded)).status, 200);
      const deadline = Date.now() + 90_000;
      while (
        !latency
          .snapshot()
          .traces.find((t) => t.probe === expected)
          ?.observations.some((o) => o.stage === "finished")
      ) {
        assert(Date.now() < deadline, "Local pipeline timed out");
        await sleep(10);
      }
      const trace = latency.snapshot().traces.find((t) => t.probe === expected);
      assert(trace);
      assert(trace.deliveries.some((d) => d.status === "sent" && d.pong));
      assert.equal(outbound, i + 1);
      console.error(
        JSON.stringify({
          sample: i + 1,
          state: i === 0 ? "cold-actor" : "warm-actor",
          ...summarize(trace),
        }),
      );
    }
    await capture({
      mode: "local-pipeline-fixture",
      model: process.env.JUNE_LATENCY_PROVIDER_MODULE
        ? "explicit-provider-module"
        : "fake",
      delays,
      coldSamples: 1,
      warmSamples: count - 1,
      ...latency.snapshot(),
    });
  } finally {
    await client.dispose();
    await registry.shutdown();
    await stopTestEngine(directory, port);
    await rm(directory, { recursive: true, force: true });
  }
  // Like main.ts, exit after graceful shutdown: Rivet native handles can remain.
  process.exit(0);
} else {
  console.log(
    "pnpm exec tsx scripts/latency.ts local [1–20 samples] [--threaded]\npnpm exec tsx scripts/latency.ts watch\npnpm exec tsx scripts/latency.ts report <capture.json> [...]",
  );
}
