import { isDeepStrictEqual } from "node:util";
import { Effect, Schema } from "effect";
import type { JuneRuntime } from "../effect/runtime.js";
import type {
  ImportCoverage,
  ImportPage,
  PageFetcher,
} from "../memory/store.js";

export interface ConnectorConfig {
  /** Authenticated, operator-selected coverage, never model supplied. */
  coverage: ImportCoverage;
  accessToken: (signal?: AbortSignal) => Promise<string>;
  transport?: typeof fetch;
  effectRuntime: JuneRuntime;
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
  return Effect.fnUntraced(function* (requested: ImportCoverage) {
    if (!isDeepStrictEqual(coverage, requested))
      return yield* new ImportError({
        message: "Import selection is not authorized",
      });
  });
}

/** A connector failure; the message is fixed host text, never provider content. */
export class ImportError extends Schema.TaggedError<ImportError>()(
  "ImportError",
  { message: Schema.String },
) {}

export class ProviderError extends Schema.TaggedError<ProviderError>()(
  "ImportProviderError",
  { status: Schema.Number, retryMs: Schema.Number },
) {
  override get message() {
    return `History provider request failed (${this.status})`;
  }
}

const Cursor = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  token: Schema.String.check(Schema.isMaxLength(1800)),
});
export const readCursor = Effect.fnUntraced(function* (
  cursor: string | null,
  count: number,
) {
  const result = yield* Effect.try(() =>
    Schema.decodeUnknownSync(Cursor)(
      cursor === null ? { index: 0, token: "" } : JSON.parse(cursor),
    ),
  ).pipe(
    Effect.mapError(
      () => new ImportError({ message: "Invalid import cursor" }),
    ),
  );
  if (result.index >= count)
    return yield* new ImportError({ message: "Invalid import cursor" });
  return result;
});
export const nextCursor = Effect.fnUntraced(function* (
  index: number,
  token: string,
  count: number,
) {
  if (!token) index++;
  if (index >= count) return null;
  const result = JSON.stringify({ index, token });
  if (result.length > 2048 || token.length > 1800)
    return yield* new ImportError({
      message: "Provider cursor exceeds storage limit",
    });
  return result;
});

const GmailRateLimit = Schema.Struct({
  error: Schema.Struct({
    errors: Schema.optional(
      Schema.Array(Schema.Struct({ reason: Schema.String })),
    ),
  }),
});
export const getJson = Effect.fn("june.imports.request")(function* (
  config: Pick<ConnectorConfig, "accessToken" | "transport">,
  url: URL,
) {
  // Credential and transport rejections stay the original defects.
  const token = yield* Effect.promise((signal) => config.accessToken(signal));
  const response = yield* Effect.promise((signal) =>
    (config.transport ?? fetch)(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal,
      redirect: "error",
    }),
  );
  if (!response.ok) {
    const seconds = Number(response.headers.get("retry-after"));
    let status = response.status;
    if (status === 403 && url.hostname === "gmail.googleapis.com") {
      const body = Schema.decodeUnknownOption(GmailRateLimit)(
        yield* Effect.promise(() => response.json().catch(() => null)),
      );
      if (
        body._tag === "Some" &&
        body.value.error.errors?.some((e) =>
          ["rateLimitExceeded", "userRateLimitExceeded"].includes(e.reason),
        )
      )
        status = 429;
    }
    return yield* new ProviderError({
      status,
      retryMs:
        Number.isFinite(seconds) && seconds > 0
          ? Math.ceil(seconds * 1000)
          : 60_000,
    });
  }
  return yield* Effect.promise((): Promise<unknown> => response.json());
});

/** Rate limits and provider backoff become a resumable page, not a failure. */
export function limited<A, E, R>(
  page: Effect.Effect<A, E | ProviderError, R>,
  cursor: string | null,
) {
  return page.pipe(
    Effect.catchIf(
      (error): error is ProviderError =>
        error instanceof ProviderError &&
        (error.status === 429 || error.status === 503),
      (error): Effect.Effect<ImportPage> =>
        Effect.succeed({
          sources: [],
          nextCursor: cursor,
          rateLimited: true,
          retryAfterMs: error.retryMs,
          cooldownReason:
            error.status === 503 ? "provider_backoff" : "rate_limit",
        }),
    ),
  );
}

/** Avoid leaking provider bodies, message contents or tokens through diagnostics. */
export const decode = <S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () => new ImportError({ message: "Invalid history provider response" }),
    ),
  );

/** Promise boundary for the memory store's PageFetcher contract. */
export function pageFetcher(
  config: ConnectorConfig,
  fetchPage: (
    request: Parameters<PageFetcher>[0],
  ) => Effect.Effect<ImportPage, ImportError | ProviderError>,
): PageFetcher {
  return (request) => {
    // A pre-aborted signal must not start a request; runPromise only
    // interrupts on a later abort.
    if (request.signal?.aborted) return Promise.reject(request.signal.reason);
    return config.effectRuntime.runPromise(fetchPage(request), {
      signal: request.signal,
    });
  };
}
