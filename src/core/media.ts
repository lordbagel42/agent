import { Schema } from "effect";

export const VIDEO_AUDIO_RATE = 16000;
export const VIDEO_AUDIO_SECONDS = 30;
export const VIDEO_AUDIO_CHANNELS = 2;
export const VIDEO_AUDIO_BLOCK_BYTES = VIDEO_AUDIO_CHANNELS * 2;
export const VIDEO_AUDIO_BYTES =
  VIDEO_AUDIO_RATE * VIDEO_AUDIO_SECONDS * VIDEO_AUDIO_BLOCK_BYTES;

/** Host-decoded stereo signed 16-bit little-endian PCM, not a URL or transcript.
 * Bytes never belong in durable state, diagnostics, or text prompts. */
export const modelAudioSchema = Schema.Struct({
  evidenceId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2048),
  ),
  data: Schema.Uint8Array.check(
    Schema.makeFilter(
      (data) =>
        data.byteLength > 0 &&
        data.byteLength <= VIDEO_AUDIO_BYTES &&
        data.byteLength % VIDEO_AUDIO_BLOCK_BYTES === 0,
    ),
  ),
});
export type ModelAudioInput = typeof modelAudioSchema.Type;
export type VideoAudio =
  | { status: "ready"; input: ModelAudioInput }
  | { status: "silent"; durationSeconds: number }
  | { status: "absent" | "unavailable" };

export const audioDurationSeconds = (input: ModelAudioInput) =>
  input.data.byteLength / (VIDEO_AUDIO_RATE * VIDEO_AUDIO_BLOCK_BYTES);
