import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { ChannelAdapter, ModelImageInput } from "../core/contracts.js";
import {
  audioDurationSeconds,
  modelAudioSchema,
  VIDEO_AUDIO_CHANNELS,
  VIDEO_AUDIO_RATE,
  VIDEO_AUDIO_SECONDS,
  type VideoAudio,
} from "../core/media.js";
import { decodeStrict } from "../effect/schema.js";
import { createSlackFileReader } from "./slack-images.js";

/** Only our own child is terminated. Always await close, including cancellation,
 * before releasing admission or removing its private working directory. */
async function decode(
  executable: "ffprobe" | "ffmpeg",
  args: string[],
  cwd: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/prlimit",
      [
        "--as=1073741824",
        "--cpu=20",
        "--fsize=5242880",
        "--core=0",
        "--nofile=64",
        "--",
        `/usr/bin/${executable}`,
        ...args,
      ],
      {
        cwd,
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let failed = false;
    let size = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 30_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const)
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) stop();
        else chunks.push(chunk);
      });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      // ffprobe can exit zero after a demux error. At error-only log level any
      // diagnostic means we cannot use even an otherwise readable prefix.
      if (failed || code !== 0 || stderr.length)
        reject(new Error("Video decoding unavailable"));
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
  });
}

class VideoAudioUnavailable extends Schema.TaggedError<VideoAudioUnavailable>()(
  "VideoAudioUnavailable",
  {},
) {}
const audioAttempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new VideoAudioUnavailable() });
const audioStreams = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({ index: Schema.Int, channels: Schema.Literals([1, 2]) }),
  ),
});

const readAudio = Effect.fn("june.slack.video.audio")(function* (
  input: string[],
  home: string,
  fileId: string,
  signal: AbortSignal,
): Effect.fn.Return<VideoAudio, VideoAudioUnavailable> {
  const probe = yield* audioAttempt(() =>
    decode(
      "ffprobe",
      [
        "-v",
        "error",
        ...input,
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=index,channels",
        "-of",
        "json",
      ],
      home,
      signal,
    ),
  );
  const info = yield* Effect.try({
    // ffprobe also emits empty programs/stream_groups on some versions.
    // Decode just the selected stream fields; never surface other metadata.
    try: () => Schema.decodeUnknownSync(audioStreams)(JSON.parse(probe.stdout)),
    catch: () => new VideoAudioUnavailable(),
  });
  if (info.streams.length === 0) return { status: "absent" };
  yield* audioAttempt(() =>
    decode(
      "ffmpeg",
      [
        "-nostdin",
        "-xerror",
        "-hide_banner",
        "-loglevel",
        "error",
        ...input,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-filter_threads",
        "1",
        "-af",
        `asetpts=PTS-STARTPTS,atrim=duration=${VIDEO_AUDIO_SECONDS}`,
        "-t",
        String(VIDEO_AUDIO_SECONDS),
        // Preserve stereo: a mono downmix can cancel opposite-phase sound.
        // Reject multichannel sources above instead of silently dropping them.
        "-ac",
        String(VIDEO_AUDIO_CHANNELS),
        "-ar",
        String(VIDEO_AUDIO_RATE),
        "-threads",
        "1",
        "-map_metadata",
        "-1",
        "-f",
        "s16le",
        "audio.pcm",
      ],
      home,
      signal,
    ),
  );
  const data = yield* audioAttempt(() => readFile(join(home, "audio.pcm")));
  const audio = yield* Effect.try({
    try: () =>
      decodeStrict(modelAudioSchema)({
        evidenceId: `slack:${fileId}:audio:0`,
        data,
      }),
    catch: () => new VideoAudioUnavailable(),
  });
  // Only exact decoded digital silence is classified here. Quiet sounds are
  // still evidence; absence of intelligible speech is a model judgment.
  return data.every((byte) => byte === 0)
    ? { status: "silent", durationSeconds: audioDurationSeconds(audio) }
    : { status: "ready", input: audio };
});

/** MP4/MOV only: force the demuxer and disable external tracks. Media cannot
 * select network protocols, playlists, local references, or decoder arguments.
 * Files live only in a mode-0700 temporary directory. Audio has its own bound. */
export function createSlackVideoReader(
  options: Parameters<typeof createSlackFileReader>[0],
): NonNullable<ChannelAdapter["readVideo"]> {
  const read = createSlackFileReader(options);
  return async (event, fileId, signal) => {
    const result = await read(
      event,
      fileId,
      signal,
      ["video/mp4", "video/quicktime"],
      50 * 1024 * 1024,
    );
    if (result.status !== "ready") return result;
    let home: string | undefined;
    try {
      signal.throwIfAborted();
      home = await mkdtemp(join(tmpdir(), "june-video-"));
      await writeFile(join(home, "input.mp4"), result.data, { mode: 0o600 });
      const input = [
        "-max_alloc",
        "67108864",
        "-cpucount",
        "1",
        "-threads",
        "1",
        "-max_pixels",
        "8294400",
        "-f",
        "mov",
        "-protocol_whitelist",
        "file",
        "-enable_drefs",
        "0",
        "-use_absolute_path",
        "0",
        "-i",
        "input.mp4",
      ];
      const probe = await decode(
        "ffprobe",
        [
          "-v",
          "error",
          ...input,
          "-select_streams",
          "V:0",
          "-show_entries",
          "stream=width,height:packet=pts_time,duration_time:packet_side_data=",
          "-of",
          "json",
        ],
        home,
        signal,
      );
      const info = JSON.parse(probe.stdout);
      const stream = info.streams?.[0];
      // Use packet timing only to space samples. Even packet duration can depend
      // on forged container headers (especially the final frame's hold), so this
      // is NOT a verified clip duration. Independently cap decoding at 120s and
      // return only observed frame timestamps, never a completeness claim.
      let start = Infinity;
      let end = -Infinity;
      for (const packet of info.packets ?? []) {
        const pts = Number(packet.pts_time);
        const duration = Number(packet.duration_time);
        if (
          !Number.isFinite(pts) ||
          !Number.isFinite(duration) ||
          duration <= 0
        )
          return { status: "unavailable" };
        start = Math.min(start, pts);
        end = Math.max(end, pts + duration);
      }
      const samplingSpanSeconds = Math.min(120, end - start);
      if (
        !stream ||
        !Number.isFinite(samplingSpanSeconds) ||
        samplingSpanSeconds <= 0 ||
        !Number.isInteger(stream.width) ||
        !Number.isInteger(stream.height) ||
        stream.width <= 0 ||
        stream.height <= 0 ||
        stream.width * stream.height > 3840 * 2160
      )
        return { status: "unavailable" };
      await decode(
        "ffmpeg",
        [
          "-nostdin",
          "-xerror",
          "-hide_banner",
          "-loglevel",
          "error",
          // Sparse review can reduce inter-frame decode work by sampling
          // keyframes, without widening the host's CPU/wall budgets.
          "-skip_frame",
          "nokey",
          ...input,
          "-t",
          "120",
          "-map",
          "0:V:0",
          "-an",
          "-sn",
          "-dn",
          "-filter_threads",
          "1",
          "-vf",
          `setpts=PTS-STARTPTS,select='isnan(prev_selected_t)+gte(t-prev_selected_t,${samplingSpanSeconds / 8})',scale=640:640:force_original_aspect_ratio=decrease`,
          "-frames:v",
          "8",
          "-fps_mode",
          "passthrough",
          "-enc_time_base",
          "1:1000",
          "-frame_pts",
          "1",
          "-threads",
          "1",
          "-q:v",
          "3",
          "-map_metadata",
          "-1",
          "frame-%09d.jpg",
        ],
        home,
        signal,
      );
      // The muxer names files with decoded PTS rounded to milliseconds. Never
      // parse timestamps from diagnostics: hostile container metadata can forge
      // log lines. Selected frames retain their PTS, without fps duplication.
      const files = (await readdir(home))
        .filter((file) => /^frame-\d{9}\.jpg$/.test(file))
        .sort();
      if (!files.length || files.length > 8) return { status: "unavailable" };
      const images: ModelImageInput[] = [];
      for (const [index, file] of files.entries()) {
        const data = await readFile(join(home, file));
        const time = Number(file.slice(6, -4)) / 1000;
        if (
          !Number.isFinite(time) ||
          time < 0 ||
          time > 120 ||
          data.length > 1024 * 1024 ||
          data[0] !== 255 ||
          data[1] !== 216 ||
          data[2] !== 255
        )
          return { status: "unavailable" };
        images.push({
          evidenceId: `slack:${fileId}:frame:${index}`,
          mimeType: "image/jpeg",
          data,
          mediaTimeSeconds: time,
        });
      }
      // Audio decode failure must not erase valid visual evidence. Pass the
      // caller's signal into native operations and await child close before
      // Effect finishes, including cancellation and temporary-file cleanup.
      const audio = await options.effectRuntime.runPromise(
        readAudio(input, home, fileId, signal).pipe(
          Effect.catchTag("VideoAudioUnavailable", () =>
            Effect.succeed({ status: "unavailable" } as const),
          ),
        ),
      );
      signal.throwIfAborted();
      return { status: "ready", images, audio };
    } catch {
      // Decoder/Slack diagnostics may contain private metadata. Never return it.
      return { status: "unavailable" };
    } finally {
      if (home) await rm(home, { recursive: true, force: true });
    }
  };
}
