import { Effect, Schema } from "effect";
import type { ChannelAdapter, MessageEvent } from "../core/contracts.js";
import type { JuneRuntime } from "../effect/runtime.js";

const IMAGE_LIMIT = 5 * 1024 * 1024;

/** Failures carry no provider text: errors can contain private URLs/headers. */
class SlackFileUnavailable extends Schema.TaggedError<SlackFileUnavailable>()(
  "SlackFileUnavailable",
  {},
) {}
const unavailableFile = () => new SlackFileUnavailable();
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: unavailableFile });

/** Bound the stream, not just the server's optional Content-Length claim. */
const readBounded = Effect.fnUntraced(function* (
  response: Response,
  limit: number,
) {
  const body = response.body;
  if (
    !response.ok ||
    !body ||
    Number(response.headers.get("content-length")) > limit
  ) {
    yield* attempt(async () => {
      await body?.cancel();
    });
    return yield* unavailableFile();
  }
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = yield* attempt(() => reader.read());
          if (done) break;
          size += value.byteLength;
          if (size > limit) return yield* unavailableFile();
          chunks.push(value);
        }
        return Buffer.concat(chunks, size);
      }),
    (reader) =>
      attempt(async () => {
        await reader.cancel();
        reader.releaseLock();
      }).pipe(Effect.orDie),
  );
});

/** File URLs are resolved privately, never retained in message metadata or
 * accepted from the model. No redirects may forward the bot credential. */
interface SlackFileOptions {
  teamId: string;
  botToken: string;
  fetch: typeof globalThis.fetch;
  effectRuntime: JuneRuntime;
}

type SlackFileResult =
  | { status: "unavailable"; code?: "files_read_required" }
  | { status: "ready"; mimeType: string; data: Buffer };

export function createSlackFileReader(options: SlackFileOptions) {
  const unavailable = { status: "unavailable" as const };
  const read = Effect.fn("june.slack.file.read")(function* (
    event: MessageEvent,
    fileId: string,
    signal: AbortSignal,
    mimetypes: readonly string[],
    limit: number,
  ): Effect.fn.Return<SlackFileResult, SlackFileUnavailable> {
    if (
      signal.aborted ||
      event.address.channel !== "slack" ||
      event.address.accountId !== options.teamId ||
      !/^F[A-Z0-9]{2,63}$/.test(fileId) ||
      !event.metadata?.files?.some((file) => file.id === fileId)
    )
      return unavailable;
    // Cancellation and the deadline abort the requests; they never interrupt
    // this program, so a cancelled read still answers "unavailable".
    const boundedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    const headers = { authorization: `Bearer ${options.botToken}` };
    const response = yield* attempt(() =>
      options.fetch(
        `https://slack.com/api/files.info?${new URLSearchParams({ file: fileId })}`,
        { redirect: "error", headers, signal: boundedSignal },
      ),
    );
    const bytes = yield* readBounded(response, 256 * 1024);
    const info = yield* Effect.try({
      try: () => JSON.parse(bytes.toString("utf8")),
      catch: unavailableFile,
    });
    if (info?.ok === false && info.error === "missing_scope")
      return { status: "unavailable", code: "files_read_required" };
    const file = info?.file;
    if (
      info?.ok !== true ||
      file?.id !== fileId ||
      !mimetypes.includes(file.mimetype) ||
      (typeof file.size === "number" && file.size > limit) ||
      typeof file.url_private !== "string"
    )
      return unavailable;
    const url = yield* Effect.try({
      try: () => new URL(file.url_private),
      catch: unavailableFile,
    });
    if (
      url.protocol !== "https:" ||
      url.hostname !== "files.slack.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      // Slack's authoritative url_private can use its transcoded-media route.
      // Never use thumb_* metadata or accept a caller-supplied URL instead.
      !/^\/files-(?:pri|tmb)\//.test(url.pathname) ||
      boundedSignal.aborted
    )
      return unavailable;
    const download = yield* attempt(() =>
      options.fetch(url.href, {
        redirect: "error",
        headers,
        signal: boundedSignal,
      }),
    );
    const data = yield* readBounded(download, limit);
    if (boundedSignal.aborted) return unavailable;
    return { status: "ready", mimeType: file.mimetype as string, data };
  });
  return (
    event: MessageEvent,
    fileId: string,
    signal: AbortSignal,
    mimetypes: readonly string[],
    limit: number,
  ): Promise<SlackFileResult> =>
    options.effectRuntime.runPromise(
      read(event, fileId, signal, mimetypes, limit).pipe(
        Effect.catchTag("SlackFileUnavailable", () =>
          Effect.succeed(unavailable),
        ),
      ),
    );
}

export function createSlackImageReader(
  options: SlackFileOptions,
): NonNullable<ChannelAdapter["readImage"]> {
  const read = createSlackFileReader(options);
  return async (event, fileId, signal) => {
    const result = await read(
      event,
      fileId,
      signal,
      ["image/png", "image/jpeg"],
      IMAGE_LIMIT,
    );
    if (result.status !== "ready") return result;
    const signature =
      result.mimeType === "image/png"
        ? [137, 80, 78, 71, 13, 10, 26, 10]
        : [255, 216, 255];
    if (!signature.every((byte, i) => result.data[i] === byte))
      return { status: "unavailable" };
    return {
      status: "ready",
      image: {
        evidenceId: `slack:${fileId}`,
        mimeType: result.mimeType as "image/png" | "image/jpeg",
        data: result.data,
      },
    };
  };
}
