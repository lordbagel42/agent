import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ImportCoverage, ImportPage } from "../memory/store.js";

export interface ConnectorConfig {
  /** Authenticated, operator-selected coverage, never model supplied. */
  coverage: ImportCoverage;
  accessToken: (signal?: AbortSignal) => Promise<string>;
  transport?: typeof fetch;
}

export function bindCoverage(config: ConnectorConfig, platform: string) {
  const coverage = structuredClone(config.coverage);
  if (
    coverage.platform !== platform ||
    !coverage.account ||
    !Number.isSafeInteger(coverage.from) ||
    coverage.from < 0 ||
    !Number.isSafeInteger(coverage.to) ||
    coverage.to <= coverage.from ||
    !coverage.conversations.length ||
    !coverage.audiences.length ||
    new Set(coverage.conversations).size !== coverage.conversations.length ||
    coverage.audiences.some((a) => !a)
  )
    throw new Error("Invalid trusted import selection");
  return (requested: ImportCoverage) => {
    if (!isDeepStrictEqual(coverage, requested))
      throw new Error("Import selection is not authorized");
  };
}

const cursorSchema = z.object({
  index: z.number().int().nonnegative(),
  token: z.string().max(1800),
});
export function readCursor(cursor: string | null, count: number) {
  try {
    const result = cursorSchema.parse(
      cursor === null ? { index: 0, token: "" } : JSON.parse(cursor),
    );
    if (result.index >= count) throw new Error();
    return result;
  } catch {
    throw new Error("Invalid import cursor");
  }
}
export function nextCursor(index: number, token: string, count: number) {
  if (!token) index++;
  if (index >= count) return null;
  const result = JSON.stringify({ index, token });
  if (result.length > 2048 || token.length > 1800)
    throw new Error("Provider cursor exceeds storage limit");
  return result;
}

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly retryMs: number,
  ) {
    super(`History provider request failed (${status})`);
  }
}
export async function getJson(
  config: ConnectorConfig,
  url: URL,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const token = await config.accessToken(signal);
  signal?.throwIfAborted();
  const response = await (config.transport ?? fetch)(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    const seconds = Number(response.headers.get("retry-after"));
    let status = response.status;
    if (status === 403 && url.hostname === "gmail.googleapis.com") {
      const body = z
        .object({
          error: z.object({
            errors: z.array(z.object({ reason: z.string() })).optional(),
          }),
        })
        .safeParse(await response.json().catch(() => null));
      if (
        body.success &&
        body.data.error.errors?.some((e) =>
          ["rateLimitExceeded", "userRateLimitExceeded"].includes(e.reason),
        )
      )
        status = 429;
    }
    throw new ProviderError(
      status,
      Number.isFinite(seconds) && seconds > 0
        ? Math.ceil(seconds * 1000)
        : 60_000,
    );
  }
  return response.json();
}
export function limited(
  error: unknown,
  cursor: string | null,
): ImportPage | undefined {
  if (
    error instanceof ProviderError &&
    (error.status === 429 || error.status === 503)
  )
    return {
      sources: [],
      nextCursor: cursor,
      rateLimited: true,
      retryAfterMs: error.retryMs,
    };
}

/** Avoid leaking provider bodies, message contents or tokens through diagnostics. */
export function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Invalid history provider response");
  return result.data;
}
