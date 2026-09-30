import type { ChannelAdapter } from "../core/contracts.js";

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
export function createSlackImageReader(options: {
  teamId: string;
  botToken: string;
  ownerUserIds: ReadonlySet<string>;
  fetch: typeof globalThis.fetch;
}): NonNullable<ChannelAdapter["readImage"]> {
  return async (event, fileId, signal) => {
    const unavailable = { status: "unavailable" as const };
    if (
      signal.aborted ||
      event.address.channel !== "slack" ||
      event.address.accountId !== options.teamId ||
      !options.ownerUserIds.has(event.senderId) ||
      !event.direct ||
      event.metadata?.channelType !== "im" ||
      !/^F[A-Z0-9]{2,63}$/.test(fileId) ||
      !event.metadata.files?.some((file) => file.id === fileId)
    )
      return unavailable;
    const boundedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    const headers = { authorization: `Bearer ${options.botToken}` };
    try {
      const response = await options.fetch("https://slack.com/api/files.info", {
        method: "POST",
        redirect: "error",
        headers: {
          ...headers,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ file: fileId }),
        signal: boundedSignal,
      });
      const info = JSON.parse(
        (await readBounded(response, 256 * 1024)).toString("utf8"),
      );
      if (info?.ok === false && info.error === "missing_scope")
        return { status: "unavailable", code: "files_read_required" };
      const file = info?.file;
      if (
        info?.ok !== true ||
        file?.id !== fileId ||
        !["image/png", "image/jpeg"].includes(file.mimetype) ||
        (typeof file.size === "number" && file.size > IMAGE_LIMIT) ||
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
        !url.pathname.startsWith("/files-pri/") ||
        boundedSignal.aborted
      )
        return unavailable;
      const download = await options.fetch(url.href, {
        redirect: "error",
        headers,
        signal: boundedSignal,
      });
      const data = await readBounded(download, IMAGE_LIMIT);
      const signature =
        file.mimetype === "image/png"
          ? [137, 80, 78, 71, 13, 10, 26, 10]
          : [255, 216, 255];
      if (
        boundedSignal.aborted ||
        !signature.every((byte, i) => data[i] === byte)
      )
        return unavailable;
      return {
        status: "ready",
        image: { evidenceId: `slack:${fileId}`, mimeType: file.mimetype, data },
      };
    } catch {
      // Provider errors can contain private URLs/headers; return no raw errors.
      return unavailable;
    }
  };
}
