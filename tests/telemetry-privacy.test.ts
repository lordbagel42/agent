import {
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { expect, it } from "vitest";
import {
  correlationId,
  initializeTelemetry,
  recordEvent,
  telemetryQuerySchema,
  withSpan,
} from "../src/telemetry/index.js";

it("redacts durable and OTLP records without replaying failed work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "june-otel-"));
  const received: { url?: string; body: string; header?: string }[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    received.push({
      url: request.url,
      body: Buffer.concat(parts).toString(),
      header: request.headers["x-fixture"] as string,
    });
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const saved = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith("OTEL_")) delete process.env[key];
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-fixture=private-test-header";
  const telemetry = initializeTelemetry({
    path: join(directory, "telemetry.sqlite"),
  });
  try {
    const secret = "sensitive prompt / response ?token=secret";
    const error = new Error(secret);
    let calls = 0;
    await expect(
      withSpan(
        secret,
        {
          prompt: secret,
          "http.route": secret,
          "june.operation.id": correlationId(secret),
          "june.channel": "slack",
        },
        async (span) => {
          calls++;
          expect(trace.getActiveSpan()?.spanContext()).toEqual(
            span.spanContext(),
          );
          span.setAttributes({
            "tool.arguments": secret,
            "http.headers": secret,
          });
          span.setStatus({ code: SpanStatusCode.OK, message: secret });
          span.updateName(secret);
          span.recordException(error);
          span.addEvent(secret, { response: secret });
          span.end();
          await withSpan(
            "june.model.call",
            { "gen_ai.usage.input_tokens": 2 },
            async () => {
              recordEvent(secret, {
                prompt: secret,
                "june.outcome": "completed",
              });
            },
          );
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    const traces = telemetry.query({ view: "traces" }) as {
      rows: {
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        status: string;
      }[];
    };
    expect(traces.rows).toHaveLength(2);
    expect(traces.rows[0]?.parentSpanId).toBe(traces.rows[1]?.spanId);
    expect(traces.rows[0]?.traceId).toBe(traces.rows[1]?.traceId);
    expect(traces.rows[1]?.status).toBe("error");
    expect(
      JSON.stringify([traces, telemetry.query({ view: "logs" })]),
    ).not.toContain(secret);
    expect(statSync(join(directory, "telemetry.sqlite")).mode & 0o777).toBe(
      0o600,
    );
    await telemetry.shutdown();
    expect(received.map((item) => item.url).sort()).toEqual([
      "/v1/logs",
      "/v1/metrics",
      "/v1/traces",
    ]);
    expect(
      received.every((item) => item.header === "private-test-header"),
    ).toBe(true);
    const payload = received.map((item) => item.body).join("");
    expect(payload).not.toContain(secret);
    expect(payload).not.toContain("tool.arguments");
    expect(payload).toContain("june.operation");
    expect(payload).toContain("june.operations.completed");
    expect(JSON.stringify(telemetry.query({}))).not.toContain(
      "private-test-header",
    );
  } finally {
    await telemetry.shutdown();
    for (const key of Object.keys(process.env))
      if (key.startsWith("OTEL_")) delete process.env[key];
    for (const [key, value] of Object.entries(saved))
      if (key.startsWith("OTEL_")) process.env[key] = value;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects unsafe persistence and unbounded queries without interrupting work", async () => {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith("OTEL_")) delete process.env[key];
  const directory = mkdtempSync(join(tmpdir(), "june-otel-"));
  const target = join(directory, "target");
  writeFileSync(target, "untouched", { mode: 0o600 });
  symlinkSync(target, join(directory, "telemetry.sqlite"));
  const telemetry = initializeTelemetry({
    path: join(directory, "telemetry.sqlite"),
  });
  try {
    let calls = 0;
    await withSpan("june.turn", {}, async () => {
      calls++;
      recordEvent("june.event");
    });
    expect(calls).toBe(1);
    expect(telemetry.query({})).toMatchObject({
      persistence: { available: false, failures: 1 },
    });
    expect(telemetryQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(telemetryQuerySchema.safeParse({ unknown: true }).success).toBe(
      false,
    );
    expect(
      telemetryQuerySchema.safeParse({ traceId: "A".repeat(32) }).success,
    ).toBe(false);
  } finally {
    await telemetry.shutdown();
    for (const [key, value] of Object.entries(saved))
      if (key.startsWith("OTEL_")) process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  }
});
