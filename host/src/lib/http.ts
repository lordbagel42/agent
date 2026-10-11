/**
 * Bounded HTTP for host services: no ambient proxy, no cookies, no automatic
 * redirects, a deadline for the whole exchange and a response-size cap. The
 * shape mirrors what the Python services read from urllib.
 */
import { type Duration, Effect, Layer, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
} from "effect/http";

export class HttpFailure extends Schema.TaggedError<HttpFailure>()(
  "HttpFailure",
  {
    reason: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {}

export interface Exchange {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
  readonly contentType?: string;
  readonly timeout: Duration.Input;
  readonly limit: number;
}

export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** Fetch with manual redirects: a 3xx is returned to the caller, never followed. */
export const layer = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, {
      redirect: "manual",
      credentials: "omit",
    }),
  ),
);

export const exchange = Effect.fnUntraced(function* (input: Exchange) {
  const client = yield* HttpClient.HttpClient;
  const body =
    input.body === undefined
      ? HttpBody.empty
      : HttpBody.uint8Array(
          typeof input.body === "string"
            ? new TextEncoder().encode(input.body)
            : input.body,
          input.contentType ??
            input.headers?.["Content-Type"] ??
            "application/octet-stream",
        );
  const request = HttpClientRequest.make(input.method)(input.url, {
    headers: input.headers ?? {},
    body,
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const response = yield* client.execute(request);
      const chunks: Uint8Array[] = [];
      let total = 0;
      yield* response.stream.pipe(
        Stream.runForEach((chunk) => {
          total += chunk.length;
          if (total > input.limit)
            return Effect.fail(
              new HttpFailure({ reason: "response_too_large" }),
            );
          chunks.push(chunk);
          return Effect.void;
        }),
      );
      return {
        status: response.status,
        headers: response.headers as Record<string, string>,
        body: Buffer.concat(chunks, total),
      } satisfies Reply;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () => Effect.fail(new HttpFailure({ reason: "timeout" })),
    }),
    Effect.catchTag(["HttpClientError"], () =>
      Effect.fail(new HttpFailure({ reason: "transport" })),
    ),
  );
});
