import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
    if (new URL(url).pathname === "/api/files.info") {
      if (init?.body || new URL(url).searchParams.get("file") !== "F123")
        return Response.json({ ok: false, error: "invalid_arguments" });
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

it.for(["readImage", "readVideo"] as const)(
  "%s rejects foreign attachments before IO and bounds downloads",
  async (action) => {
    let reads = 0;
    const slack = adapter(async () => {
      reads++;
      throw new Error("Must not read");
    });
    expect(slack[action]).toBeTypeOf("function");
    for (const [source, fileId] of [
      [event, "F999"],
      [{ ...event, senderId: "guest" }, "F123"],
      [{ ...event, address: { ...event.address, accountId: "T2" } }, "F123"],
      [{ ...event, direct: false }, "F123"],
    ] as const) {
      expect(
        await slack[action]?.(source, fileId, new AbortController().signal),
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
      await ungranted[action]?.(event, "F123", new AbortController().signal),
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
        if (new URL(url).pathname === "/api/files.info")
          return Response.json({
            ok: true,
            file: {
              id: scenario === "wrong-id" ? "F999" : "F123",
              mimetype:
                scenario === "unsupported"
                  ? "image/svg+xml"
                  : action === "readImage"
                    ? "image/png"
                    : "video/mp4",
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
            ? new Uint8Array(
                (action === "readImage" ? 5 : 50) * 1024 * 1024 + 1,
              )
            : Buffer.from("not a PNG"),
        );
      });
      expect(
        await reader[action]?.(event, "F123", new AbortController().signal),
        scenario,
      ).toMatchObject({ status: "unavailable" });
      if (["foreign-url", "wrong-id", "unsupported"].includes(scenario))
        expect(downloaded).toEqual([]);
    }
  },
);

it("reads an attached MP4 as distinct timestamped keyframes, not every frame or a thumbnail", async () => {
  const home = await mkdtemp(join(tmpdir(), "june-video-test-"));
  try {
    const path = join(home, "two-scenes.mp4");
    await promisify(execFile)("/usr/bin/ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=160x90:r=8:d=1",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x90:r=8:d=1",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0",
      "-threads",
      "1",
      "-c:v",
      "libx264",
      "-g",
      "4",
      "-metadata",
      "title=n: 0 pts: 0 pts_time:99",
      path,
    ]);
    const video = await readFile(path);
    const source = {
      ...event,
      metadata: {
        channelType: "im" as const,
        files: [{ id: "F123", mimetype: "video/mp4" }],
      },
    };
    let downloads = 0;
    const slack = adapter(async (input) => {
      if (new URL(String(input)).pathname === "/api/files.info")
        return Response.json({
          ok: true,
          file: {
            id: "F123",
            mimetype: "video/mp4",
            size: video.length,
            // Slack can serve the actual video in url_private via files-tmb,
            // despite the route name. Never substitute its thumb_* fields.
            url_private: "https://files.slack.com/files-tmb/T1-F123/video.mp4",
          },
        });
      downloads++;
      return new Response(video);
    });
    expect(slack.readVideo).toBeTypeOf("function");
    const result = await slack.readVideo?.(
      source,
      "F123",
      new AbortController().signal,
    );
    expect(result?.status).toBe("ready");
    if (result?.status !== "ready") throw new Error("Missing video frames");
    expect(downloads).toBe(1);
    expect(result.images).toHaveLength(4);
    expect(result.images.map((image) => image.mediaTimeSeconds)).toEqual([
      0, 0.5, 1, 1.5,
    ]);
    // Decode real returned frames: first is red, last is blue. Repeating one
    // thumbnail or merely relabeling its timestamp cannot pass this check.
    for (const [index, dominant] of [
      [0, 0],
      [3, 2],
    ] as const) {
      const frame = result.images[index];
      if (!frame) throw new Error("Missing frame");
      const { spawn } = await import("node:child_process");
      const child = spawn("/usr/bin/ffmpeg", [
        "-v",
        "error",
        "-f",
        "image2pipe",
        "-i",
        "pipe:0",
        "-vf",
        "scale=1:1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ]);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      const stopped = new Promise<void>((resolve, reject) =>
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error("Frame decoding failed")),
        ),
      );
      child.stdin.end(frame.data);
      await stopped;
      const pixel = Buffer.concat(chunks);
      expect(pixel[dominant]).toBeGreaterThan(200);
      expect(pixel[dominant === 0 ? 2 : 0]).toBeLessThan(30);
    }
    expect(JSON.stringify(source)).not.toContain("files-pri");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("rejects cover-only/corrupt containers and bounds samples despite forged duration headers", async () => {
  const home = await mkdtemp(join(tmpdir(), "june-video-limits-"));
  const run = promisify(execFile);
  async function readVideo(data: Buffer) {
    const slack = adapter(async (input) =>
      new URL(String(input)).pathname === "/api/files.info"
        ? Response.json({
            ok: true,
            file: {
              id: "F123",
              mimetype: "video/mp4",
              url_private:
                "https://files.slack.com/files-pri/T1-F123/video.mp4",
            },
          })
        : new Response(new Uint8Array(data)),
    );
    return slack.readVideo?.(event, "F123", new AbortController().signal);
  }
  try {
    const cover = join(home, "cover.jpg");
    const coverOnly = join(home, "cover.mp4");
    await run("/usr/bin/ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=yellow:s=64x64",
      "-frames:v",
      "1",
      "-threads",
      "1",
      cover,
    ]);
    await run("/usr/bin/ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=2",
      "-i",
      cover,
      "-map",
      "0:a",
      "-map",
      "1:v",
      "-c:a",
      "aac",
      "-c:v",
      "copy",
      "-disposition:v",
      "attached_pic",
      coverOnly,
    ]);
    expect(await readVideo(await readFile(coverOnly))).toEqual({
      status: "unavailable",
    });
    for (const seconds of [120, 121]) {
      const path = join(home, `timeline-${seconds}.mp4`);
      await run("/usr/bin/ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=blue:s=64x64:r=1:d=${seconds}`,
        "-threads",
        "1",
        "-c:v",
        "libx264",
        "-g",
        "15",
        "-movflags",
        "+faststart",
        path,
      ]);
      const data = await readFile(path);
      if (seconds === 121) {
        const mdhd = data.indexOf(Buffer.from("mdhd"));
        expect(mdhd).toBeGreaterThan(0);
        expect(data[mdhd + 4]).toBe(0);
        // v0 mdhd: timescale at +16, duration at +20 from the type. Forge one
        // second while leaving the actual packet presentation times intact.
        data.writeUInt32BE(data.readUInt32BE(mdhd + 16), mdhd + 20);
      }
      const result = await readVideo(data);
      expect(result?.status).toBe("ready");
      if (result?.status !== "ready") throw new Error("Missing samples");
      expect(result.images.map((image) => image.mediaTimeSeconds)).toEqual([
        0, 15, 30, 45, 60, 75, 90, 105,
      ]);
      expect(result).not.toHaveProperty("durationSeconds");
      // Faststart preserves a valid header and readable video prefix, but
      // removes the tail of mdat. A zero-exit probe with demux errors must fail.
      expect(
        (await readVideo(data.subarray(0, data.length - 64)))?.status,
      ).toBe("unavailable");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
