import { expect, it } from "vitest";
import type { MessageEvent } from "../core/contracts.js";
import { createSlackAdapter } from "./slack.js";

const event: MessageEvent = {
  type: "message",
  id: "event",
  messageId: "123.456",
  senderId: "U1",
  direct: true,
  text: "Read this image",
  occurredAt: 1,
  address: { channel: "slack", accountId: "T1", conversationId: "D1" },
  metadata: {
    channelType: "im",
    files: [{ id: "F123", mimetype: "image/png" }],
  },
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
function adapter(fetch: typeof globalThis.fetch) {
  return createSlackAdapter({
    signingSecret: "unused",
    botToken: "private-test-token",
    teamId: "T1",
    botUserId: "UBOT",
    ownerUserIds: ["U1"],
    fetch,
  });
}

it("resolves an attached file through Slack and returns bytes outside metadata", async () => {
  const calls: string[] = [];
  const slack = adapter(async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer private-test-token",
    );
    if (url === "https://slack.com/api/files.info") {
      expect(JSON.parse(String(init?.body))).toEqual({ file: "F123" });
      return Response.json({
        ok: true,
        file: {
          id: "F123",
          mimetype: "image/png",
          size: png.length,
          url_private: "https://files.slack.com/files-pri/T1-F123/image.png",
        },
      });
    }
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  expect(slack.readImage).toBeTypeOf("function");
  const result = await slack.readImage?.(
    event,
    "F123",
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: "ready",
    image: { evidenceId: "slack:F123", mimeType: "image/png" },
  });
  if (result?.status !== "ready") throw new Error("Missing image");
  expect(Buffer.from(result.image.data)).toEqual(png);
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(event)).not.toContain("files-pri");
});

it("rejects foreign attachments before IO and bounds authenticated downloads", async () => {
  let reads = 0;
  const slack = adapter(async () => {
    reads++;
    throw new Error("Must not read");
  });
  expect(slack.readImage).toBeTypeOf("function");
  for (const [source, fileId] of [
    [event, "F999"],
    [{ ...event, senderId: "guest" }, "F123"],
    [{ ...event, address: { ...event.address, accountId: "T2" } }, "F123"],
    [{ ...event, direct: false }, "F123"],
  ] as const) {
    expect(
      await slack.readImage?.(source, fileId, new AbortController().signal),
    ).toMatchObject({ status: "unavailable" });
  }
  expect(reads).toBe(0);
  const ungranted = adapter(async () =>
    Response.json({
      ok: false,
      error: "missing_scope",
      needed: "files:read",
      provided: "chat:write",
    }),
  );
  expect(
    await ungranted.readImage?.(event, "F123", new AbortController().signal),
  ).toEqual({ status: "unavailable", code: "files_read_required" });
  for (const scenario of [
    "foreign-url",
    "redirect",
    "too-large",
    "bad-signature",
    "wrong-id",
    "unsupported",
  ]) {
    const downloaded: string[] = [];
    const reader = adapter(async (input) => {
      const url = String(input);
      if (url.endsWith("/files.info"))
        return Response.json({
          ok: true,
          file: {
            id: scenario === "wrong-id" ? "F999" : "F123",
            mimetype:
              scenario === "unsupported" ? "image/svg+xml" : "image/png",
            url_private:
              scenario === "foreign-url"
                ? "https://files.slack.com.attacker.example/image.png"
                : "https://files.slack.com/files-pri/T1-F123/image.png",
          },
        });
      downloaded.push(url);
      if (scenario === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com" },
        });
      return new Response(
        scenario === "too-large"
          ? new Uint8Array(5 * 1024 * 1024 + 1)
          : Buffer.from("not a PNG"),
      );
    });
    expect(
      await reader.readImage?.(event, "F123", new AbortController().signal),
      scenario,
    ).toMatchObject({ status: "unavailable" });
    if (["foreign-url", "wrong-id", "unsupported"].includes(scenario))
      expect(downloaded).toEqual([]);
  }
});
