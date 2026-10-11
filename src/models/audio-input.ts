import {
  audioDurationSeconds,
  modelAudioSchema,
  VIDEO_AUDIO_BLOCK_BYTES,
  VIDEO_AUDIO_CHANNELS,
  VIDEO_AUDIO_RATE,
} from "../core/media.js";
import { decodeStrict } from "../effect/schema.js";
import { ModelError } from "./provider.js";

/** Canonical WAV without source metadata. Validate before allocating base64. */
export function encodeModelAudio(value: unknown) {
  let input: typeof modelAudioSchema.Type;
  try {
    input = decodeStrict(modelAudioSchema)(value);
  } catch {
    throw new ModelError("invalid_audio", false);
  }
  const wav = Buffer.alloc(44 + input.data.byteLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(VIDEO_AUDIO_CHANNELS, 22);
  wav.writeUInt32LE(VIDEO_AUDIO_RATE, 24);
  wav.writeUInt32LE(VIDEO_AUDIO_RATE * VIDEO_AUDIO_BLOCK_BYTES, 28);
  wav.writeUInt16LE(VIDEO_AUDIO_BLOCK_BYTES, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(input.data.byteLength, 40);
  wav.set(input.data, 44);
  return {
    evidenceId: input.evidenceId,
    durationSeconds: audioDurationSeconds(input),
    data: wav.toString("base64"),
  };
}
