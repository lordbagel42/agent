import { z } from "zod";
import {
  type OperationDetail,
  type OperationIndex,
  type OperationQuery,
  type OperationSummary,
  operationEventSchema,
  operationIdSchema,
  operationQuerySchema,
} from "./operations.js";

export const operationInspectionSchema = operationQuerySchema.extend({
  target: z.literal("debug-operations"),
  operationId: operationIdSchema.optional(),
  limit: z.number().int().min(1).max(10).default(3),
});
export type OperationInspection = z.input<typeof operationInspectionSchema>;

/** Complete logical pages fit a worker observation, without text reconstruction.
 * Failure bodies and controller payloads are available via their event timeline;
 * do not repeat them inside summaries or hydrate related timelines here.
 */
export function operationInspectionPage(
  result: OperationIndex | OperationDetail,
  offset: number,
  limit: number,
): string {
  const summarize = ({ latest, failure, ...counts }: OperationSummary) => {
    const { controller: _controller, ...metadata } = latest;
    return {
      ...counts,
      latest: metadata,
      lastFailure: failure
        ? { id: failure.id, sequence: failure.sequence }
        : null,
    };
  };
  const rows =
    "items" in result
      ? result.items.slice(0, limit).map(summarize)
      : result.events.slice(0, limit);
  const total = "items" in result ? result.total : result.totalEvents;
  for (;;) {
    const nextOffset =
      offset + rows.length < total ? offset + rows.length : null;
    const page =
      "items" in result
        ? {
            items: rows,
            total,
            offset,
            nextOffset,
            controller: result.controller,
          }
        : {
            operation: summarize(result.operation),
            events: rows,
            totalEvents: total,
            offset,
            nextOffset,
            relatedQuery: result.operation.failureKey
              ? {
                  target: "debug-operations",
                  failureKey: result.operation.failureKey,
                  offset: 0,
                }
              : null,
          };
    const json = JSON.stringify(page);
    if (json.length <= 10000) return json;
    if (rows.length <= 1)
      throw new Error("Operations page exceeds metadata bounds");
    rows.pop();
  }
}

const count = z.number().int().nonnegative().safe();
const summarySchema = z.strictObject({
  latest: operationEventSchema,
  firstObservedAt: count,
  lastObservedAt: count,
  eventCount: count,
  failure: operationEventSchema.nullable(),
  failureKey: z.string().max(250).nullable(),
  matchingFailures: count,
});
const indexSchema = z.strictObject({
  items: z.array(summarySchema).max(100),
  total: count,
  nextOffset: count.nullable(),
  controller: operationEventSchema.nullable(),
});
const detailSchema = z.strictObject({
  operation: summarySchema,
  events: z.array(operationEventSchema).max(100),
  totalEvents: count,
  nextOffset: count.nullable(),
  related: z.array(summarySchema).max(10),
});

/** Separate read credential; no capture access, mutations, redirects or raw errors. */
export function createOperationReader(options: {
  origin: string;
  token: string;
}) {
  const url = new URL(options.origin);
  if (
    url.origin !== options.origin ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(options.token) ||
    options.token.length < 32 ||
    options.token.length > 4096
  )
    throw new Error("Invalid operations reader configuration");
  return async (
    query: OperationQuery & { operationId?: string },
  ): Promise<OperationIndex | OperationDetail> => {
    try {
      const { operationId, ...filters } = query;
      const parsed = operationQuerySchema.parse(filters);
      const endpoint = new URL("/api/operations-read", options.origin);
      if (operationId !== undefined) {
        operationIdSchema.parse(operationId);
        endpoint.pathname += `/${encodeURIComponent(operationId)}`;
        endpoint.searchParams.set("offset", String(parsed.offset));
      } else {
        endpoint.search = new URLSearchParams({
          q: parsed.query,
          offset: String(parsed.offset),
          limit: String(parsed.limit),
        }).toString();
        if (parsed.source) endpoint.searchParams.set("source", parsed.source);
        if (parsed.sources)
          endpoint.searchParams.set("sources", parsed.sources.join(","));
        if (parsed.failureKey)
          endpoint.searchParams.set("failureKey", parsed.failureKey);
        if (parsed.failuresOnly)
          endpoint.searchParams.set("failuresOnly", "true");
      }
      const response = await fetch(endpoint, {
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
        },
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok || response.redirected) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 4 * 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (operationId === undefined) return indexSchema.parse(json);
      const detail = detailSchema.parse(json);
      if (detail.operation.latest.operationId !== operationId)
        throw new Error();
      const events = detail.events.slice(0, parsed.limit);
      return {
        ...detail,
        events,
        nextOffset:
          parsed.offset + events.length < detail.totalEvents
            ? parsed.offset + events.length
            : null,
      };
    } catch {
      throw new Error("Operations archive unavailable");
    }
  };
}
