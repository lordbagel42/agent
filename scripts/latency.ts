// Operator CLI, never mounted as an HTTP writer. See docs/latency.md.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "rivetkit/client";
import { createSlackAdapter } from "../src/channels/slack.js";
import type { ModelProvider } from "../src/core/contracts.js";
import { createHttpApp } from "../src/http/app.js";
import {
  createLatencyDiagnostics,
  type LatencyTrace,
  latencyProbe,
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
    durableMs: time("finished") ?? null,
    turnMs: time("released") ?? time("finished") ?? null,
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
} else if (mode === "plan") {
  const count = Number(args[0] ?? 5);
  if (!Number.isInteger(count) || count < 1 || count > 20 || args.length > 1)
    throw new Error("Use plan [1–20 serial probes]");
  const probes = Array.from({ length: count }, () => randomUUID());
  await capture({ mode: "human-slack-probe-plan", probes });
  console.error(
    "Send these manually, one at a time, waiting for each pong. Do not batch-send or repeat a timed-out ping.",
  );
  for (const probe of probes) console.error(`ping ${probe}`);
} else if (mode === "watch" || mode === "collect") {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      revision: { type: "string" },
      "started-at": { type: "string" },
      "wait-seconds": { type: "string", default: "900" },
    },
  });
  if (values.revision !== undefined && !/^[a-f0-9]{40}$/.test(values.revision))
    throw new Error("Use the full running revision for --revision");
  const expectedStart =
    values["started-at"] === undefined
      ? undefined
      : Number(values["started-at"]);
  if (
    expectedStart !== undefined &&
    (!Number.isSafeInteger(expectedStart) || expectedStart <= 0)
  )
    throw new Error(
      "Use the diagnostics startedAt epoch milliseconds for --started-at",
    );
  const seconds = Number(values["wait-seconds"]);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
    throw new Error("Use --wait-seconds 1–3600");
  if (
    (mode === "watch" && positionals.length > 1) ||
    (mode === "collect" && (!positionals.length || positionals.length > 20))
  )
    throw new Error(
      "Use watch [UUID] or collect <UUID> [...], at most 20 probes",
    );
  if (positionals.length && (!values.revision || expectedStart === undefined))
    throw new Error(
      "An existing/planned UUID requires its original --revision and --started-at; do not adopt a new process for readback",
    );
  const probes = positionals.length
    ? positionals.map((id) => {
        const probe = latencyProbe(`ping ${id}`);
        if (!probe)
          throw new Error("Probe IDs must be UUIDv4 values from plan/watch");
        return probe;
      })
    : [randomUUID()];
  if (new Set(probes).size !== probes.length)
    throw new Error("Duplicate probe ID");
  const token = process.env.JUNE_OPERATOR_TOKEN;
  if (!token || token.length < 32)
    throw new Error(
      "Supply JUNE_OPERATOR_TOKEN privately, never as an argument",
    );
  const base = new URL(process.env.JUNE_URL ?? "http://127.0.0.1:3080");
  if (base.username || base.password || base.search || base.hash)
    throw new Error("Clean private service URL required");
  const read = async () => {
    const response = await fetch(new URL("/operator/latency", base), {
      redirect: "error",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`Diagnostics unavailable: HTTP ${response.status}`);
    return (await response.json()) as {
      revision?: string;
      startedAt: number;
      traces: LatencyTrace[];
    };
  };
  // Authenticate and pin the running revision BEFORE asking for a human message.
  let data = await read();
  const revision = values.revision ?? data.revision;
  const startedAt = data.startedAt;
  if (values.revision && data.revision !== values.revision)
    throw new Error(
      "Running revision differs from --revision; do not mix rollout samples",
    );
  if (expectedStart !== undefined && startedAt !== expectedStart)
    throw new Error(
      "Host restarted since --started-at; retained observations cannot establish the earlier baseline",
    );
  if (mode === "watch") {
    console.error(
      `Pinned revision: ${revision ?? "unknown"}; process startedAt: ${startedAt}`,
    );
    console.error(`Watch/readback for: ping ${probes[0]}`);
    console.error(
      `If not already sent, send it yourself from the allowlisted HUMAN Slack account. Waiting up to ${seconds}s; never send it twice.`,
    );
    console.error(
      `Late readback: pnpm exec tsx scripts/latency.ts collect ${probes[0]}${revision ? ` --revision ${revision}` : ""} --started-at ${startedAt}`,
    );
  }
  const deadline = Date.now() + seconds * 1000;
  const observed = new Map<string, LatencyTrace>();
  const settled = (trace: LatencyTrace | undefined) =>
    trace?.observations.some((o) => o.stage === "finished") &&
    trace.observations.some((o) => o.stage === "released");
  let interruption:
    | "host_changed"
    | "read_failed"
    | "ambiguous_probe"
    | undefined;
  let lastObservedAt: string | undefined;
  let unavailable: string[] = [];
  for (;;) {
    if (data.startedAt !== startedAt || data.revision !== revision) {
      interruption = "host_changed";
      break;
    }
    lastObservedAt = new Date().toISOString();
    unavailable = [];
    for (const probe of probes) {
      const matches = data.traces.filter((t) => t.probe === probe);
      const match = matches[0];
      const previous = observed.get(probe);
      if (
        matches.length > 1 ||
        (match && previous && match.id !== previous.id)
      ) {
        interruption = "ambiguous_probe";
        break;
      }
      if (match) observed.set(probe, match);
      else unavailable.push(probe); // Retain earlier partial observations on eviction.
    }
    if (
      interruption ||
      probes.every((probe) => settled(observed.get(probe))) ||
      mode === "collect" ||
      Date.now() >= deadline
    )
      break;
    await sleep(1000);
    try {
      data = await read();
    } catch {
      interruption = "read_failed";
      break;
    }
  }
  const traces = [...observed.values()];
  const pending = probes.filter((probe) => !settled(observed.get(probe)));
  const failed = traces.some(
    (trace) =>
      settled(trace) &&
      !trace.deliveries.some((d) => d.status === "sent" && d.pong),
  );
  await capture({
    mode: "human-slack-probe",
    outcome: interruption
      ? "interrupted"
      : failed
        ? "failed"
        : pending.length
          ? "pending"
          : "complete",
    revision,
    startedAt,
    retrievedAt: new Date().toISOString(),
    lastObservedAt,
    interruption,
    probes,
    pending,
    unavailable: interruption ? probes : unavailable,
    traces,
  });
  if (interruption)
    console.error(
      `Observation interrupted (${interruption}); saved only earlier same-process evidence. Do not resend.`,
    );
  else if (failed)
    console.error(
      "A completed turn lacks a matching accepted pong. No resend was attempted.",
    );
  else if (pending.length)
    console.error(
      "Pending means unseen, incomplete, evicted or lost on restart—not proof of no reply. Collect the same UUID later; do not resend.",
    );
  process.exitCode = interruption || failed ? 1 : pending.length ? 2 : 0;
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
          ?.observations.some((o) => o.stage === "released")
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
    "pnpm exec tsx scripts/latency.ts local [1–20 samples] [--threaded]\npnpm exec tsx scripts/latency.ts plan [1–20 probes]\npnpm exec tsx scripts/latency.ts watch [--wait-seconds 900] [--revision SHA]\npnpm exec tsx scripts/latency.ts watch <UUID> --revision SHA --started-at MS [--wait-seconds 900]\npnpm exec tsx scripts/latency.ts collect <UUID> [...] --revision SHA --started-at MS\npnpm exec tsx scripts/latency.ts report <capture.json> [...]",
  );
}
