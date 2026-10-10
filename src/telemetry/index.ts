import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  type Attributes,
  context,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { safeAttributes, safeName } from "./privacy.js";
import { type Row, retention, Store } from "./store.js";

export const telemetryQuerySchema = z
  .strictObject({
    view: z.enum(["status", "traces", "logs", "metrics"]).default("status"),
    traceId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    name: z.string().min(1).max(80).optional(),
    status: z.enum(["ok", "error", "unfinished"]).optional(),
    since: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    until: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .refine(
    (q) => q.since === undefined || q.until === undefined || q.since <= q.until,
    { message: "since must not exceed until" },
  );
export type TelemetryQuery = z.input<typeof telemetryQuerySchema>;
export interface Telemetry {
  query(input: TelemetryQuery): unknown;
  shutdown(): Promise<void>;
}

// Never persisted: hashes correlate only within this process, not across restarts.
const correlationKey = randomBytes(32);
export function correlationId(value: string): string {
  return createHmac("sha256", correlationKey).update(value).digest("hex");
}
let active: Backend | undefined;
const noop = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
const milliseconds = (time: [number, number]) => time[0] * 1000 + time[1] / 1e6;

/** A private provider means third-party instrumentations cannot inject arbitrary
 * records. The active/callback Span is a redacting facade, never the SDK span. */
function facade(
  raw: Span,
  guard: (run: () => void) => void,
  ownsEnd = false,
): Span {
  const span: Span = {
    spanContext: () => ({
      traceId: raw.spanContext().traceId,
      spanId: raw.spanContext().spanId,
      traceFlags: 1,
    }),
    isRecording: () => raw.isRecording(),
    setAttribute(key, value) {
      guard(() => raw.setAttributes(safeAttributes({ [key]: value })));
      return span;
    },
    setAttributes(attributes) {
      guard(() => raw.setAttributes(safeAttributes(attributes)));
      return span;
    },
    setStatus(status) {
      // Keep OK implicit, so a later thrown error cannot be masked by the
      // SDK's rule that an explicitly OK status takes precedence over ERROR.
      if (status.code !== SpanStatusCode.ERROR) return span;
      guard(() => raw.setStatus({ code: SpanStatusCode.ERROR }));
      return span;
    },
    updateName() {
      return span;
    },
    addEvent(name, attributes) {
      guard(() =>
        raw.addEvent(
          safeName(name, true),
          safeAttributes(
            attributes &&
              typeof attributes === "object" &&
              !Array.isArray(attributes) &&
              !(attributes instanceof Date)
              ? attributes
              : {},
          ),
        ),
      );
      return span;
    },
    addLink() {
      return span;
    },
    addLinks() {
      return span;
    },
    recordException() {
      /* Deliberately do not retain messages, stacks or types. */
    },
    end(time) {
      /* Otherwise withSpan owns the one and only end. */
      if (ownsEnd) guard(() => raw.end(time));
    },
  };
  return span;
}

/** Effect's OpenTelemetry bridge starts and ends its own spans. Route them
 * through the same facade so both privacy boundaries still apply. */
export function effectTracer(): Tracer | undefined {
  const backend = active;
  if (!backend) return undefined;
  const tracer: Pick<Tracer, "startSpan"> = {
    startSpan(name, options, parent) {
      try {
        const raw = backend.tracer.startSpan(
          safeName(name),
          {
            kind: options?.kind,
            startTime: options?.startTime,
            attributes: safeAttributes(options?.attributes),
          },
          parent,
        );
        return facade(raw, (action) => backend.guard(action), true);
      } catch {
        backend.sdkFailures++;
        return noop;
      }
    },
  };
  // The bridge only calls startSpan; refuse the callback API rather than bypass the facade.
  return {
    ...tracer,
    startActiveSpan() {
      throw new Error("effect_tracer_active_span_unsupported");
    },
  } as Tracer;
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  const backend = active;
  if (!backend) return run(noop);
  let raw: Span | undefined;
  try {
    raw = backend.tracer.startSpan(
      safeName(name),
      { attributes: safeAttributes(attributes) },
      backend.contexts.active(),
    );
  } catch {
    backend.sdkFailures++;
  }
  if (!raw) return run(noop);
  const owned = raw;
  const span = facade(owned, (action) => backend.guard(action));
  const parent = trace.setSpan(backend.contexts.active(), span);
  // Never catch and rerun the callback: telemetry is not an effect retry layer.
  return backend.contexts.with(parent, async () => {
    try {
      return await run(span);
    } catch (error) {
      backend.guard(() => owned.setStatus({ code: SpanStatusCode.ERROR }));
      throw error;
    } finally {
      backend.guard(() => owned.end());
    }
  });
}

export function recordEvent(name: string, attributes: Attributes = {}): void {
  active?.event(name, attributes);
}

type Result = { code: number };
function monitor<
  T,
  E extends { export(data: T, callback: (result: Result) => void): void },
>(exporter: E, failed: () => void): E {
  const original = exporter.export.bind(exporter);
  exporter.export = (data, callback) => {
    try {
      original(data, (result) => {
        if (result.code !== 0) failed();
        callback({ code: result.code });
      });
    } catch {
      failed();
      callback({ code: 1 });
    }
  };
  return exporter;
}

class Backend implements Telemetry {
  readonly contexts = new AsyncLocalStorageContextManager().enable();
  private readonly ownsGlobalContext = context.setGlobalContextManager(
    this.contexts,
  );
  readonly store: Store;
  readonly session;
  readonly tracer;
  private readonly provider;
  private readonly logs;
  private readonly metrics;
  private readonly logger;
  private stopping?: Promise<void>;
  sdkFailures = 0;
  private exportFailures = { traces: 0, logs: 0, metrics: 0 };
  private exportEnabled = { traces: false, logs: false, metrics: false };
  constructor(options: { path: string; revision?: string }) {
    this.store = new Store(options.path);
    this.session = {
      processId: randomUUID(),
      processStartedAt: Date.now(),
      ...(options.revision && /^[a-f0-9]{40}$/.test(options.revision)
        ? { revision: options.revision }
        : {}),
    };
    const resource = resourceFromAttributes({
      "service.name": "june",
      "service.instance.id": this.session.processId,
      ...(this.session.revision
        ? { "service.version": this.session.revision }
        : {}),
    });
    const make = <T>(
      signal: "traces" | "logs" | "metrics",
      factory: () => T,
    ): T | undefined => {
      const endpoint =
        process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`] ??
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      if (!endpoint?.trim()) return undefined;
      try {
        const url = new URL(endpoint);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("Unsupported protocol");
        const exporter = factory();
        this.exportEnabled[signal] = true;
        return exporter;
      } catch {
        this.exportFailures[signal]++;
        return undefined;
      }
    };
    const traceExporter = make("traces", () =>
      monitor(
        new OTLPTraceExporter({ timeoutMillis: 3000 }),
        () => this.exportFailures.traces++,
      ),
    );
    const logExporter = make("logs", () =>
      monitor(
        new OTLPLogExporter({ timeoutMillis: 3000 }),
        () => this.exportFailures.logs++,
      ),
    );
    const metricExporter = make("metrics", () =>
      monitor(
        new OTLPMetricExporter({ timeoutMillis: 3000 }),
        () => this.exportFailures.metrics++,
      ),
    );
    this.metrics = new MeterProvider({
      resource,
      readers: metricExporter
        ? [
            new PeriodicExportingMetricReader({
              exporter: metricExporter,
              exportIntervalMillis: 30_000,
              exportTimeoutMillis: 5000,
            }),
          ]
        : [],
    });
    const meter = this.metrics.getMeter("june");
    const completed = meter.createCounter("june.operations.completed", {
      description: "Completed instrumented operations in this process",
    });
    const duration = meter.createHistogram("june.operation.duration", {
      unit: "ms",
    });
    meter
      .createObservableGauge("june.process.memory.rss", { unit: "By" })
      .addCallback((result) => result.observe(process.memoryUsage().rss));
    meter
      .createObservableCounter("june.process.cpu.time", { unit: "s" })
      .addCallback((result) => {
        const cpu = process.cpuUsage();
        result.observe((cpu.user + cpu.system) / 1e6);
      });
    const batch = traceExporter
      ? new BatchSpanProcessor(traceExporter, {
          maxQueueSize: 2048,
          maxExportBatchSize: 256,
          scheduledDelayMillis: 1000,
          exportTimeoutMillis: 5000,
        })
      : undefined;
    const row = (span: ReadableSpan, ended: boolean): Row => ({
      ...this.session,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      name: safeName(span.name),
      parentSpanId: span.parentSpanContext?.spanId,
      at: milliseconds(span.startTime),
      status: ended
        ? span.status.code === SpanStatusCode.ERROR
          ? "error"
          : "ok"
        : "unfinished",
      ...(ended
        ? {
            durationMs: milliseconds(span.duration),
            endedAt: milliseconds(span.endTime),
          }
        : {}),
      attributes: safeAttributes(span.attributes),
      events: span.events.slice(0, 16).map((event) => ({
        name: safeName(event.name, true),
        at: milliseconds(event.time),
        attributes: safeAttributes(event.attributes),
      })),
    });
    const processor: SpanProcessor = {
      onStart: (span) =>
        this.guard(() => this.store.span(row(span, false), false)),
      onEnd: (span) =>
        this.guard(() => {
          this.store.span(row(span, true), true);
          const labels = {
            "june.span.name": safeName(span.name),
            "june.outcome":
              span.status.code === SpanStatusCode.ERROR ? "error" : "ok",
          };
          completed.add(1, labels);
          duration.record(milliseconds(span.duration), labels);
          // Second privacy boundary immediately before the only exporter.
          batch?.onEnd({
            kind: span.kind,
            parentSpanContext: span.parentSpanContext
              ? {
                  traceId: span.parentSpanContext.traceId,
                  spanId: span.parentSpanContext.spanId,
                  traceFlags: 1,
                }
              : undefined,
            startTime: span.startTime,
            endTime: span.endTime,
            duration: span.duration,
            ended: span.ended,
            resource,
            instrumentationScope: { name: "june" },
            droppedAttributesCount: span.droppedAttributesCount,
            droppedEventsCount: span.droppedEventsCount,
            droppedLinksCount: span.droppedLinksCount,
            name: safeName(span.name),
            attributes: safeAttributes(span.attributes),
            status: { code: span.status.code },
            links: [],
            events: span.events.slice(0, 16).map((event) => ({
              ...event,
              name: safeName(event.name, true),
              attributes: safeAttributes(event.attributes),
            })),
            spanContext: () => ({
              traceId: span.spanContext().traceId,
              spanId: span.spanContext().spanId,
              traceFlags: 1,
            }),
          });
        }),
      forceFlush: async () => {
        await batch?.forceFlush();
      },
      shutdown: async () => {
        await batch?.shutdown();
      },
    };
    this.provider = new BasicTracerProvider({
      resource,
      sampler: new AlwaysOnSampler(),
      spanProcessors: [processor],
      spanLimits: {
        attributeCountLimit: 32,
        eventCountLimit: 16,
        linkCountLimit: 0,
        attributeValueLengthLimit: 128,
      },
    });
    this.tracer = this.provider.getTracer("june");
    this.logs = new LoggerProvider({
      resource,
      processors: logExporter
        ? [
            new BatchLogRecordProcessor({
              exporter: logExporter,
              maxQueueSize: 2048,
              maxExportBatchSize: 256,
              scheduledDelayMillis: 1000,
              exportTimeoutMillis: 5000,
            }),
          ]
        : [],
    });
    this.logger = this.logs.getLogger("june");
  }
  guard(run: () => void) {
    try {
      run();
    } catch {
      this.sdkFailures++;
    }
  }
  event(name: string, attributes: Attributes) {
    this.guard(() => {
      const at = Date.now();
      const safe = safeAttributes(attributes);
      const parent = trace.getSpanContext(this.contexts.active());
      const eventName = safeName(name, true);
      this.store.event({
        ...this.session,
        at,
        name: eventName,
        traceId: parent?.traceId,
        spanId: parent?.spanId,
        status:
          safe["june.outcome"] === "error" || safe["june.outcome"] === "failed"
            ? "error"
            : "ok",
        attributes: safe,
      });
      this.logger.emit({
        eventName,
        body: eventName,
        attributes: safe,
        timestamp: at,
        severityNumber: 9,
        severityText: "INFO",
        context: parent
          ? trace.setSpanContext(ROOT_CONTEXT, {
              traceId: parent.traceId,
              spanId: parent.spanId,
              traceFlags: 1,
            })
          : ROOT_CONTEXT,
      });
    });
  }
  query(input: TelemetryQuery): unknown {
    const q = telemetryQuerySchema.parse(input);
    const result = q.view === "status" ? {} : this.store.query(q);
    return {
      view: q.view,
      ...result,
      currentProcess: this.session,
      retention,
      persistence: {
        available: this.store.available,
        failures: this.store.failures,
        durability: "sqlite_wal_normal",
        interruptedSpansRemainUnfinished: true,
      },
      export: {
        protocol: "otlp_http_json",
        enabled: this.exportEnabled,
        failures: this.exportFailures,
        durableQueue: false,
      },
      sdkFailures: this.sdkFailures,
      ...(q.view === "metrics"
        ? {
            observations: {
              source: "current_process_at_query_time",
              memoryBytes: process.memoryUsage(),
              cpuMicroseconds: process.cpuUsage(),
              uptimeSeconds: process.uptime(),
            },
            exportedInstruments: [
              "june.operations.completed",
              "june.operation.duration",
              "june.process.memory.rss",
              "june.process.cpu.time",
            ],
          }
        : {}),
    };
  }
  shutdown(): Promise<void> {
    this.stopping ??= (async () => {
      if (active === this) active = undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(
            [this.provider, this.logs, this.metrics].map(async (provider) => {
              try {
                await provider.shutdown();
              } catch {
                // Keep handling late rejections even after the deadline.
                this.sdkFailures++;
              }
            }),
          ),
          new Promise<void>((resolve) => {
            // SDK transport timeouts may measure inactivity, not wall time.
            // Bound our wait; this does not cancel in-flight HTTP requests.
            deadline = setTimeout(() => {
              this.sdkFailures++;
              resolve();
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        this.store.close();
        if (this.ownsGlobalContext) context.disable();
        this.contexts.disable();
      }
    })();
    return this.stopping;
  }
}

export function initializeTelemetry(options: {
  path: string;
  revision?: string;
}): Telemetry {
  if (active) return active;
  try {
    active = new Backend(options);
    return active;
  } catch {
    // SDK setup must not prevent messaging startup. Do not expose exception text.
    return {
      query: () => ({ view: "status", unavailable: true, sdkFailures: 1 }),
      shutdown: async () => {},
    };
  }
}
