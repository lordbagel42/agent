import { Effect, Schema } from "effect";
import type { ImportPage, PageFetcher, Source } from "../memory/store.js";
import {
  bindCoverage,
  type ConnectorConfig,
  decode,
  getJson,
  ImportError,
  limited,
  nextCursor,
  ProviderError,
  pageFetcher,
  readCursor,
} from "./common.js";
import { gmailSourceId } from "./identity.js";

const messageId = Schema.String.check(Schema.isPattern(/^[a-f0-9]+$/i));
const List = Schema.Struct({
  messages: Schema.optional(
    Schema.Array(Schema.Struct({ id: messageId, threadId: messageId })).check(
      Schema.isMaxLength(1),
    ),
  ),
  nextPageToken: Schema.optional(Schema.String),
});
const Message = Schema.Struct({
  id: messageId,
  threadId: messageId,
  labelIds: Schema.Array(Schema.String),
  internalDate: Schema.String.check(Schema.isPattern(/^\d+$/)),
  payload: Schema.optional(Schema.Unknown),
});
interface Part {
  readonly mimeType?: string | undefined;
  readonly filename?: string | undefined;
  readonly headers?:
    | ReadonlyArray<{ readonly name: string; readonly value: string }>
    | undefined;
  readonly body?:
    | {
        readonly data?: string | undefined;
        readonly attachmentId?: string | undefined;
      }
    | undefined;
  readonly parts?: ReadonlyArray<Part> | undefined;
}
const Part: Schema.Codec<Part> = Schema.Struct({
  mimeType: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
  headers: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  ),
  body: Schema.optional(
    Schema.Struct({
      data: Schema.optional(Schema.String),
      attachmentId: Schema.optional(Schema.String),
    }),
  ),
  parts: Schema.optional(Schema.Array(Schema.suspend(() => Part))),
});
const fail = (message: string) => new ImportError({ message });

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
  const fetchPage = Effect.fn("june.imports.gmail.page")(function* ({
    coverage,
    cursor,
  }: Parameters<PageFetcher>[0]): Effect.fn.Return<
    ImportPage,
    ImportError | ProviderError
  > {
    yield* authorize(coverage);
    const { index, token } = yield* readCursor(cursor, 1);
    const conversation = coverage.conversations[0];
    if (!conversation) return yield* fail("Missing selected label");
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
    const list = yield* decode(List, yield* getJson(config, url));
    const sources: Source[] = [];
    const gaps: string[] = token
      ? []
      : [
          `${conversation}: Gmail API search interval; exact lower-bound messages may be excluded by after. Deleted mail and unavailable content are not imported. Attachments, attached messages and non-plain-text MIME content returned by full reads are discarded; separate attachment bodies are never fetched. Labels and search results can change during pagination; this is not a snapshot.`,
        ];
    for (const ref of list.messages ?? []) {
      const gap = yield* Effect.gen(function* () {
        // Validate date/label before fetching any body; list query alone is not authorization.
        const metadataUrl = new URL(
          `${base}/${ref.id}?format=metadata&fields=id,threadId,labelIds,internalDate`,
        );
        const metadata = yield* decode(
          Message,
          yield* getJson(config, metadataUrl),
        );
        const observedAt = Number(metadata.internalDate);
        if (metadata.id !== ref.id || metadata.threadId !== ref.threadId)
          return yield* fail("Gmail identity mismatch");
        if (
          !metadata.labelIds.includes(conversation) ||
          observedAt < coverage.from ||
          observedAt >= coverage.to
        )
          return `${ref.id}: no longer inside selected label/date coverage.`;
        const message = yield* decode(
          Message,
          yield* getJson(config, new URL(`${base}/${ref.id}?format=full`)),
        );
        if (
          message.id !== metadata.id ||
          message.threadId !== metadata.threadId ||
          message.internalDate !== metadata.internalDate ||
          !message.labelIds.includes(conversation)
        )
          return yield* fail("Gmail message changed coverage during fetch");
        const payload = yield* decode(Part, message.payload);
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
          conversation: `thread:${message.threadId}`,
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
      }).pipe(
        Effect.catchIf(
          (error) => error instanceof ProviderError && error.status === 404,
          () =>
            Effect.succeed(`${ref.id}: message disappeared or is unavailable.`),
        ),
      );
      if (gap) gaps.push(gap);
    }
    return {
      sources,
      gmailLabel: conversation,
      gaps,
      nextCursor: yield* nextCursor(index, list.nextPageToken ?? "", 1),
      retryAfterMs: 1000,
    };
  });
  return pageFetcher(config, (request) =>
    limited(fetchPage(request), request.cursor),
  );
}
