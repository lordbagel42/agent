import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { GitHubIssue } from "../src/diagnostics/github-issues.js";
import { IssueTracker } from "../src/diagnostics/issue-tracker.js";
import type { OperationEvent } from "../src/diagnostics/operations.js";
import { createDebugSite } from "../src/diagnostics/server.js";
import { DiagnosticStore } from "../src/diagnostics/store.js";
import type { DebugSnapshot } from "../src/runtime/session-controls.js";

// Synthetic-only preview. Never reads June's config, secrets or runtime data.
const directory = mkdtempSync(join(tmpdir(), "june-debug-preview-"));
const store = new DiagnosticStore(join(directory, "archive.sqlite"));
const port = Number(process.env.PORT ?? 3092);
const origin =
  process.env.JUNE_DEBUG_PREVIEW_ORIGIN ?? `http://127.0.0.1:${port}`;
const capturedAt = "2026-10-04T16:42:08.000Z";
const receivedAt = Date.parse("2026-10-04T16:41:32.000Z");
const inputId = "b832e410a65f17b8d80c5042f6416d81";
const event = {
  type: "message",
  id: "synthetic-message",
  messageId: "1791132092.000001",
  address: { channel: "slack", accountId: "T_DEMO", conversationId: "D_DEMO" },
  senderId: "U_DEMO",
  occurredAt: receivedAt,
  direct: true,
  text: "Can you check why the build notification arrived twice?",
};
const snapshot: DebugSnapshot = {
  id: "e782a1c4-9d2f-4ace-a1c0-5f3e9d7b1142",
  sessionId: "session-demo-6a43b271",
  capturedAt,
  revision: "synthetic-preview",
  scope: ["private", "demo-owner"],
  reason:
    "[Demo] Reply paused after the model finished. Inspect the retained delivery and timing evidence.",
  reporter: {
    channel: "slack",
    accountId: "T_DEMO",
    senderId: "U_DEMO",
    isOwner: true,
  },
  snapshotOnly: true,
  data: {
    coordinator: {
      events: { [inputId]: { event, done: false } },
      history: [
        { id: inputId, role: "user", content: event.text, source: event },
        {
          id: `${inputId}:reply`,
          role: "assistant",
          content:
            "The saved receipt records an uncertain send. It should not be repeated without reconciling the outcome.",
        },
        {
          id: "synthetic-followup",
          role: "user",
          content: "What should I look for in the receipt?",
        },
        {
          id: "synthetic-followup:reply",
          role: "assistant",
          content:
            "Check the result, not just the phase. This synthetic receipt has:\n\nphase: settled\nresult.status: unknown\nresult.code: transport_interrupted\n\nThat does not confirm delivery. The original payload is available in Evidence → Deliveries.",
        },
      ],
      modelInvocations: { [`${inputId}:fast`]: "settled" },
      deliveries: {
        [`${inputId}:text:0`]: {
          phase: "settled",
          attempts: 1,
          outcomeObservedAt: receivedAt + 35780,
          result: { status: "unknown", code: "transport_interrupted" },
          message: {
            content: {
              type: "text",
              text: "I’m checking the retained receipts.",
            },
          },
        },
      },
      modelRequest: {
        model: "synthetic-model",
        system:
          "Synthetic instructions for preview only. All displayed records are illustrative, not a live incident.",
        messages: [{ role: "user", content: event.text }],
      },
      timings: {
        coverage: "current-process",
        traces: [
          {
            id: "trace-demo-01",
            inputId,
            receivedAt,
            revision: "synthetic-preview",
            channel: "slack",
            threaded: false,
            transportMs: 182,
            observations: [
              { stage: "accepted", ms: 0 },
              { stage: "dequeued", ms: 14 },
              { stage: "context_started", ms: 28 },
              { stage: "context_memory_ready", ms: 112 },
              { stage: "context_ready", ms: 620 },
              { stage: "fast_started", ms: 624 },
              {
                stage: "provider_submitted",
                ms: 655,
                providerCall: 0,
                providerPhase: "fast",
              },
              {
                stage: "provider_terminal",
                ms: 1842,
                providerCall: 0,
                providerPhase: "fast",
              },
              {
                stage: "provider_validated",
                ms: 1847,
                providerCall: 0,
                providerPhase: "fast",
              },
              { stage: "fast_finished", ms: 1854 },
              { stage: "text_started", ms: 1861 },
              { stage: "send_unknown", ms: 35780 },
            ],
            deliveries: [{ kind: "text", status: "unknown", ms: 35780 }],
          },
        ],
      },
    },
    activity: {
      sessionId: "activity-demo",
      history: [
        { eventId: inputId, role: "user", content: event.text },
        {
          eventId: inputId,
          role: "assistant",
          content: "[Synthetic delivery summary: outcome unknown.]",
        },
      ],
      turns: [
        {
          eventId: inputId,
          receivedAt,
          inference: "confirmed_stopped",
          effects: "settled",
          hold: "delivery",
          deliveries: [],
        },
      ],
    },
    activityCapturedAt: capturedAt,
  },
  exclusions: [
    "All records in this preview are synthetic. No private June data is loaded.",
    "Credentials, process environment, unrelated conversations and raw service logs are not collected.",
    "Timing observations cover exactly matched inputs in the current process buffer; historical unjoinable traces are excluded.",
    "Provider-internal traffic and volatile tool outputs are not retained. Redaction is not a guarantee of complete secret removal.",
  ],
};
store.put(snapshot);
for (let index = 1; index <= 52; index++)
  store.put({
    ...snapshot,
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    capturedAt: new Date(
      Date.parse(capturedAt) - index * 3600000,
    ).toISOString(),
    reason:
      index === 1
        ? `[Demo] Long reporter reason that must stay bounded above the evidence. ${"Synthetic reporter detail. ".repeat(40)}`
        : index % 3 === 0
          ? "[Demo] Delivery receipt review"
          : index % 3 === 1
            ? "[Demo] Context loading investigation"
            : "[Demo] Historical capture · no model request",
    data:
      index === 52
        ? {
            history: Array.from({ length: 83 }, (_, i) => ({
              role: "user",
              content: `${"Synthetic long record. ".repeat(60)}${i === 82 ? "tail-evidence-needle <script>never execute</script>" : i}`,
            })),
          }
        : {
            history: [
              { role: "user", content: "Synthetic historical message" },
            ],
          },
  });

// Fixed synthetic metadata, including failures that remain matchable after
// reconciliation. These fixtures do not launch Amp or contact any live service.
const operationTime = Date.parse("2026-10-05T16:00:00.000Z");
const currentThread = "T-10000000-0000-4000-8000-000000000001";
const pastThread = "T-10000000-0000-4000-8000-000000000002";
const revision = "a".repeat(40);
const targetRevision = "b".repeat(40);
function putOperation(
  operationId: string,
  sequence: number,
  value: Omit<OperationEvent, "id" | "operationId" | "sequence">,
) {
  store.putOperation({
    id: `${operationId}:${sequence}`,
    operationId,
    sequence,
    ...value,
  });
}
putOperation("recovery:synthetic-current", 1, {
  source: "recovery",
  observedAt: operationTime,
  occurredAt: operationTime - 5000,
  status: "pending",
  failure: true,
  phase: "readiness",
  reason: "health_failed",
  revision: targetRevision,
  relatedOperationId: "deployment:synthetic-current",
});
putOperation("recovery:synthetic-current", 2, {
  source: "recovery",
  observedAt: operationTime + 120000,
  occurredAt: operationTime + 119000,
  status: "claimed",
  failure: false,
  phase: "readiness",
  reason: "recovery_claimed",
  threadId: currentThread,
  revision: targetRevision,
  attempt: 3,
  relatedOperationId: "deployment:synthetic-current",
});
const pastTime = operationTime - 86400000;
putOperation("recovery:synthetic-reconciled", 1, {
  source: "recovery",
  observedAt: pastTime,
  occurredAt: null,
  status: "pending",
  failure: true,
  phase: "readiness",
  reason: "health_failed",
  revision,
});
putOperation("recovery:synthetic-reconciled", 2, {
  source: "recovery",
  observedAt: pastTime + 60000,
  occurredAt: pastTime + 59000,
  status: "running",
  failure: false,
  phase: "readiness",
  threadId: pastThread,
  revision,
});
putOperation("recovery:synthetic-reconciled", 3, {
  source: "recovery",
  observedAt: pastTime + 600000,
  occurredAt: pastTime + 599000,
  status: "completed",
  failure: false,
  phase: "readiness",
  threadId: pastThread,
  revision,
});
putOperation("recovery:synthetic-reconciled", 4, {
  source: "recovery",
  observedAt: pastTime + 900000,
  occurredAt: pastTime + 899000,
  status: "reconciled",
  failure: false,
  phase: "readiness",
  reason: "readiness_confirmed",
  threadId: pastThread,
  revision,
  snapshotId: snapshot.id,
});
putOperation("recovery:synthetic-different-phase", 1, {
  source: "recovery",
  observedAt: pastTime - 60000,
  occurredAt: null,
  status: "failed",
  failure: true,
  phase: "prepare",
  reason: "health_failed",
  revision,
});
putOperation("deployment:synthetic-current", 1, {
  source: "deployment",
  observedAt: operationTime - 1000,
  occurredAt: operationTime - 5000,
  status: "blocked",
  failure: true,
  phase: "readiness",
  reason: "health_failed",
  revision: targetRevision,
  attempt: 3,
  retryAt: operationTime + 600000,
  relatedOperationId: "recovery:synthetic-current",
});
putOperation("debugshare:synthetic-completed", 1, {
  source: "debugshare",
  observedAt: operationTime - 600000,
  occurredAt: operationTime - 601000,
  status: "completed",
  failure: false,
  phase: "investigation",
  snapshotId: snapshot.id,
  threadId: "T-10000000-0000-4000-8000-000000000003",
});
putOperation("amp-task:synthetic-queued", 1, {
  source: "amp-task",
  observedAt: operationTime - 300000,
  occurredAt: operationTime - 301000,
  status: "queued",
  failure: false,
  phase: "dispatch",
});
putOperation("coding:synthetic-unknown", 1, {
  source: "coding",
  observedAt: operationTime - 400000,
  occurredAt: null,
  status: "unknown",
  failure: true,
  phase: "execution",
  reason: "outcome_unknown",
});
// A linked DEBUGSHARE whose launch never recorded a thread.
putOperation("debugshare:synthetic-no-thread", 1, {
  source: "debugshare",
  observedAt: operationTime - 200000,
  occurredAt: operationTime - 201000,
  status: "queued",
  failure: false,
  phase: "dispatch",
  snapshotId: snapshot.id,
});
putOperation("debugshare:synthetic-no-thread", 2, {
  source: "debugshare",
  observedAt: operationTime - 140000,
  occurredAt: null,
  status: "unknown",
  failure: true,
  phase: "dispatch",
  reason: "launch_unconfirmed",
  snapshotId: snapshot.id,
});
// Two separate operations that recorded the same thread stay separate.
const sharedThread = "T-10000000-0000-4000-8000-000000000004";
putOperation("amp-task:synthetic-shared-thread", 1, {
  source: "amp-task",
  observedAt: operationTime - 900000,
  occurredAt: operationTime - 901000,
  status: "completed",
  failure: false,
  phase: "execution",
  threadId: sharedThread,
});
putOperation("coding:synthetic-shared-thread", 1, {
  source: "coding",
  observedAt: operationTime - 800000,
  occurredAt: operationTime - 801000,
  status: "running",
  failure: false,
  phase: "execution",
  threadId: sharedThread,
  revision: targetRevision,
});
// An earlier deployment that recorded a terminal outcome.
putOperation("deployment:synthetic-previous", 1, {
  source: "deployment",
  observedAt: pastTime - 7200000,
  occurredAt: pastTime - 7201000,
  status: "activating",
  failure: false,
  phase: "activate",
  revision,
});
putOperation("deployment:synthetic-previous", 2, {
  source: "deployment",
  observedAt: pastTime - 7000000,
  occurredAt: pastTime - 7001000,
  status: "completed",
  failure: false,
  phase: "activate",
  revision,
});
// More than one index page and more than the ten-related-operation cap. The
// readiness incident above still has exactly two matching operations.
for (let index = 1; index <= 52; index++) {
  const id = `recovery:synthetic-dispatch-${String(index).padStart(2, "0")}`;
  const at = pastTime - index * 3600000;
  putOperation(id, 1, {
    source: "recovery",
    observedAt: at,
    occurredAt: null,
    status: "pending",
    failure: true,
    phase: "dispatch",
    reason: "launch_failed",
  });
  putOperation(id, 2, {
    source: "recovery",
    observedAt: at + 60000,
    occurredAt: at + 59000,
    status: "reconciled",
    failure: false,
    phase: "dispatch",
    reason: "receipt_reconciled",
    threadId: `T-20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  });
}
// A stale controller with enough immutable observations to exercise timeline
// pagination. No UI health signal is derived from its historical status.
for (let sequence = 1; sequence <= 103; sequence++)
  putOperation("controller:synthetic-preview", sequence, {
    source: "controller",
    observedAt: operationTime - (103 - sequence) * 1000,
    occurredAt: operationTime - (103 - sequence) * 1000 - 100,
    status: "blocked",
    failure: false,
    controller: {
      activeRevision: revision,
      observedRevision: targetRevision,
      targetRevision,
      controllerRevision: "c".repeat(40),
      blocked: true,
      operatorHold: true,
      phase: "readiness",
      recoveryIncident: "recovery:synthetic-current",
      recoveryThreadId: currentThread,
      recoveryOwner: currentThread,
      retryAttempts: 3,
      retryAt: operationTime + 600000,
      queuedRevisions: [targetRevision, "d".repeat(40)],
      omittedQueueCount: 0,
    },
  });

let clock = Date.parse("2026-10-07T12:00:00.000Z");
const remote: GitHubIssue[] = [
  "[Demo] Preserve reply placement after a restart",
  "[Demo] Link captures to GitHub issues",
  "[Demo] Investigate a delayed notification",
].map((title, index) => ({
  number: 41 + index,
  title,
  body: "Synthetic issue content. No real GitHub request or Amp launch.",
  state: "open",
  stateReason: null,
  authorId: index === 2 ? 2 : 1,
  createdAt: "2026-10-07T12:01:00.000Z",
  updatedAt: "2026-10-07T12:01:00.000Z",
  url: `https://github.com/lordbagel42/agent/issues/${41 + index}`,
}));
function issue(number: number) {
  const found = remote.find((item) => item.number === number);
  if (!found) throw new Error("Missing synthetic issue");
  return found;
}
const tracker = new IssueTracker({
  store,
  origin,
  creatorId: 1,
  now: () => clock,
  github: {
    ownerId: async () => 1,
    list: async () => remote,
    get: async (number) => structuredClone(issue(number)),
    create: async (title, body) => {
      const number = Math.max(...remote.map((item) => item.number)) + 1;
      const created = {
        ...issue(41),
        number,
        title,
        body,
        createdAt: new Date(clock).toISOString(),
        updatedAt: new Date(clock).toISOString(),
        url: `https://github.com/lordbagel42/agent/issues/${number}`,
      };
      remote.push(created);
      return created;
    },
    comments: async () => [],
    comment: async () => ({ id: 1 }),
    close: async (number) => {
      issue(number).state = "closed";
      return structuredClone(issue(number));
    },
    shipped: async () => true,
  },
});
tracker.track({
  action: "track",
  source: `debug:${snapshot.id}`,
  snapshotOnly: true,
});
await tracker.sourceReceipt({
  source: "recovery:17",
  phase: "running",
  threadId: "T-30000000-0000-4000-8000-000000000001",
});
clock += 120000;
await tracker.sync();
for (const [index, phase] of ["unknown", "returned"].entries()) {
  const claimId = `10000000-0000-4000-8000-00000000000${index}`;
  await tracker.claim(claimId);
  await tracker.receipt(41 + index, {
    claimId,
    phase: phase as "unknown" | "returned",
    threadId: `T-10000000-0000-4000-8000-00000000000${index}`,
  });
}
await tracker.run({
  action: "complete",
  number: 42,
  key: "20000000-0000-4000-8000-000000000001",
  commit: "a".repeat(40),
  body: "Synthetic completion; no real code publication.",
});
const app = createDebugSite({
  origin,
  store,
  assets: resolve("dist/debug-site/public"),
  revision: "synthetic-preview",
  viewerToken: "june-debug-synthetic-preview-viewer",
  ingestToken: "june-debug-synthetic-preview-uploader",
  issues: { token: "june-debug-synthetic-preview-issues", tracker },
});
const server = serve({
  fetch: async (request) => {
    const response = await app.fetch(request);
    if (!response.headers.get("Content-Type")?.startsWith("text/html"))
      return response;
    const html = (await response.text()).replace(
      "<body>",
      '<body><div class="synthetic-preview" role="note">Synthetic preview · All captures and operations are fixtures. No live June data or services are connected.</div>',
    );
    return new Response(html, {
      status: response.status,
      headers: response.headers,
    });
  },
  hostname: "0.0.0.0",
  port,
});
const stop = () =>
  server.close(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
console.info(`Synthetic June Debug preview listening on port ${port}`);
