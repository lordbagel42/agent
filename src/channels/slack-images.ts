import type { ChannelAdapter, MessageEvent } from "../core/contracts.js";

const IMAGE_LIMIT = 5 * 1024 * 1024;

/** Bound the stream, not just the server's optional Content-Length claim. */
async function readBounded(response: Response, limit: number) {
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("content-length")) > limit
  ) {
    await response.body?.cancel();
    throw new Error("Image unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Image too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** File URLs are resolved privately, never retained in message metadata or
 * accepted from the model. No redirects may forward the bot credential. */
interface SlackFileOptions {
  teamId: string;
  botToken: string;
  fetch: typeof globalThis.fetch;
}

export function createSlackFileReader(options: SlackFileOptions) {
  return async (
    event: MessageEvent,
    fileId: string,
    signal: AbortSignal,
    mimetypes: readonly string[],
    limit: number,
  ) => {
    const unavailable = { status: "unavailable" as const };
    if (
      signal.aborted ||
      event.address.channel !== "slack" ||
      event.address.accountId !== options.teamId ||
      !/^F[A-Z0-9]{2,63}$/.test(fileId) ||
      !event.metadata?.files?.some((file) => file.id === fileId)
    )
      return unavailable;
    const boundedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    const headers = { authorization: `Bearer ${options.botToken}` };
    try {
      const response = await options.fetch(
        `https://slack.com/api/files.info?${new URLSearchParams({ file: fileId })}`,
        {
          redirect: "error",
          headers,
          signal: boundedSignal,
        },
      );
      const info = JSON.parse(
        (await readBounded(response, 256 * 1024)).toString("utf8"),
      );
      if (info?.ok === false && info.error === "missing_scope")
        return {
          status: "unavailable" as const,
          code: "files_read_required" as const,
        };
      const file = info?.file;
      if (
        info?.ok !== true ||
        file?.id !== fileId ||
        !mimetypes.includes(file.mimetype) ||
        (typeof file.size === "number" && file.size > limit) ||
        typeof file.url_private !== "string"
      )
        return unavailable;
      const url = new URL(file.url_private);
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
      const download = await options.fetch(url.href, {
        redirect: "error",
        headers,
        signal: boundedSignal,
      });
      const data = await readBounded(download, limit);
      if (boundedSignal.aborted) return unavailable;
      return {
        status: "ready" as const,
        mimeType: file.mimetype as string,
        data,
      };
    } catch {
      // Provider errors can contain private URLs/headers; return no raw errors.
      return unavailable;
    }
  };
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
