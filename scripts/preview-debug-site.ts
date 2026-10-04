import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createDebugSite } from "../src/diagnostics/server.js";
import { DiagnosticStore } from "../src/diagnostics/store.js";
import type { DebugSnapshot } from "../src/runtime/session-controls.js";

// Synthetic-only preview. Never reads June's config, secrets or runtime data.
const directory = mkdtempSync(join(tmpdir(), "june-debug-preview-"));
const store = new DiagnosticStore(join(directory, "archive.sqlite"));
const port = 3092;
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
        { id: inputId, role: "user", content: event.text },
        {
          id: `${inputId}:reply`,
          role: "assistant",
          content:
            "The saved receipt records an uncertain send. It should not be repeated without reconciling the outcome.",
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
      history: [],
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
      index % 3 === 0
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
const app = createDebugSite({
  origin,
  store,
  assets: resolve("dist/debug-site/public"),
  revision: "synthetic-preview",
  viewerToken: "june-debug-synthetic-preview-viewer",
  ingestToken: "june-debug-synthetic-preview-uploader",
});
const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port });
const stop = () =>
  server.close(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
console.info("Synthetic June Debug preview listening on port 3092");
