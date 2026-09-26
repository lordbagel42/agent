import { z } from "zod";
import type { PageFetcher, Source } from "../memory/store.js";
import {
  bindCoverage,
  type ConnectorConfig,
  decode,
  getJson,
  limited,
  nextCursor,
  ProviderError,
  readCursor,
} from "./common.js";
import { gmailSourceId } from "./identity.js";

const messageId = z.string().regex(/^[a-f0-9]+$/i);
const listSchema = z.object({
  messages: z
    .array(z.object({ id: messageId, threadId: messageId }))
    .max(1)
    .optional(),
  nextPageToken: z.string().optional(),
});
const messageSchema = z.object({
  id: messageId,
  threadId: messageId,
  labelIds: z.array(z.string()),
  internalDate: z.string().regex(/^\d+$/),
  payload: z.unknown().optional(),
});
interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string };
  parts?: Part[];
}
const partSchema: z.ZodType<Part> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
    body: z
      .object({
        data: z.string().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(partSchema).optional(),
  }),
);

/** Gmail only; conversations are explicitly selected label IDs, not search text. */
export function createGmailHistoryFetcher(
  config: ConnectorConfig,
): PageFetcher {
  const authorize = bindCoverage(config, "gmail");
  if (
    !/^[^\s@/]+@[^\s@/]+$/.test(config.coverage.account) ||
    config.coverage.conversations.length !== 1 ||
    !/^[A-Za-z0-9_]+$/.test(config.coverage.conversations[0] ?? "") ||
    config.coverage.from % 1000 ||
    config.coverage.to % 1000
  )
    throw new Error(
      "Select one Gmail label, explicit email account and whole-second dates",
    );
  return async ({ coverage, cursor, signal }) => {
    authorize(coverage);
    const { index, token } = readCursor(cursor, 1);
    const conversation = coverage.conversations[0];
    if (!conversation) throw new Error("Missing selected label");
    const base = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(coverage.account)}/messages`;
    const url = new URL(base);
    url.searchParams.set("labelIds", conversation);
    url.searchParams.set(
      "q",
      `after:${coverage.from / 1000} before:${coverage.to / 1000}`,
    );
    url.searchParams.set("maxResults", "1");
    url.searchParams.set("includeSpamTrash", "true");
    if (token) url.searchParams.set("pageToken", token);
    try {
      const list = decode(listSchema, await getJson(config, url, signal));
      const sources: Source[] = [];
      const gaps: string[] = token
        ? []
        : [
            `${conversation}: Gmail API search interval; exact lower-bound messages may be excluded by after. Deleted mail and unavailable content are not imported. Attachments, attached messages and non-plain-text MIME content returned by full reads are discarded; separate attachment bodies are never fetched. Labels and search results can change during pagination; this is not a snapshot.`,
          ];
      for (const ref of list.messages ?? []) {
        try {
          // Validate date/label before fetching any body; list query alone is not authorization.
          const metadataUrl = new URL(
            `${base}/${ref.id}?format=metadata&fields=id,threadId,labelIds,internalDate`,
          );
          const metadata = decode(
            messageSchema,
            await getJson(config, metadataUrl, signal),
          );
          const observedAt = Number(metadata.internalDate);
          if (metadata.id !== ref.id || metadata.threadId !== ref.threadId)
            throw new Error("Gmail identity mismatch");
          if (
            !metadata.labelIds.includes(conversation) ||
            observedAt < coverage.from ||
            observedAt >= coverage.to
          ) {
            gaps.push(
              `${ref.id}: no longer inside selected label/date coverage.`,
            );
            continue;
          }
          const message = decode(
            messageSchema,
            await getJson(
              config,
              new URL(`${base}/${ref.id}?format=full`),
              signal,
            ),
          );
          if (
            message.id !== metadata.id ||
            message.threadId !== metadata.threadId ||
            message.internalDate !== metadata.internalDate ||
            !message.labelIds.includes(conversation)
          )
            throw new Error("Gmail message changed coverage during fetch");
          const payload = decode(partSchema, message.payload);
          const text: string[] = [];
          const visit = (part: Part) => {
            if (
              part.filename ||
              part.body?.attachmentId ||
              part.headers?.some(
                (h) =>
                  h.name.toLowerCase() === "content-disposition" &&
                  /^\s*attachment(?:\s*;|\s*$)/i.test(h.value),
              )
            )
              return;
            const mimeType = part.mimeType?.toLowerCase();
            if (mimeType === "text/plain" && part.body?.data)
              text.push(
                Buffer.from(part.body.data, "base64url").toString("utf8"),
              );
            // Only body containers; never descend into attached/embedded mail.
            if (mimeType?.startsWith("multipart/"))
              for (const child of part.parts ?? []) visit(child);
          };
          visit(payload);
          const headers = (payload.headers ?? []).filter((h) =>
            [
              "from",
              "to",
              "cc",
              "bcc",
              "subject",
              "message-id",
              "date",
              "reply-to",
            ].includes(h.name.toLowerCase()),
          );
          if (!text.length) gaps.push(`${ref.id}: no inline plain-text body.`);
          sources.push({
            id: gmailSourceId(coverage.account, message.id),
            platform: "gmail",
            account: coverage.account,
            conversation,
            audiences: [...coverage.audiences],
            observedAt,
            author:
              headers.find((h) => h.name.toLowerCase() === "from")?.value ||
              "unknown",
            sourceUrl: `https://mail.google.com/mail/u/${encodeURIComponent(coverage.account)}/#all/${message.threadId}`,
            text: JSON.stringify({
              kind: "historical-evidence",
              text: text.join("\n"),
              headers,
              thread: message.threadId,
              message: message.id,
              method: "gmail.users.messages.get",
            }),
          });
        } catch (error) {
          if (error instanceof ProviderError && error.status === 404)
            gaps.push(`${ref.id}: message disappeared or is unavailable.`);
          else throw error;
        }
      }
      return {
        sources,
        gaps,
        nextCursor: nextCursor(index, list.nextPageToken ?? "", 1),
        retryAfterMs: 1000,
      };
    } catch (error) {
      const page = limited(error, cursor);
      if (page) return page;
      throw error;
    }
  };
}
