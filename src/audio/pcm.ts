/** Streaming integer-ratio conversion for telephone PCM. The low-pass FIR
 * precedes downsampling; decimating without it aliases voice harmonics. */
export class PhonePcm {
  private previous = 0;
  private readonly history = new Float64Array(63);
  private position = 0;
  private readonly kernel = (() => {
    const values = Array.from({ length: 63 }, (_, i) => {
      const x = i - 31;
      const cutoff = 3400 / 48000;
      return (
        (x === 0
          ? 2 * cutoff
          : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)) *
        (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / 62))
      );
    });
    const sum = values.reduce((a, b) => a + b, 0);
    return values.map((v) => v / sum);
  })();

  up(frame: Uint8Array): Uint8Array {
    if (frame.byteLength !== 320) throw new Error("invalid_phone_frame");
    const input = new DataView(
      frame.buffer,
      frame.byteOffset,
      frame.byteLength,
    );
    const output = Buffer.alloc(1920);
    for (let i = 0; i < 160; i++) {
      const sample = input.getInt16(i * 2, true);
      for (let j = 0; j < 6; j++)
        output.writeInt16LE(
          Math.round(this.previous + ((sample - this.previous) * (j + 1)) / 6),
          (i * 6 + j) * 2,
        );
      this.previous = sample;
    }
    return output;
  }

  down(frame: Uint8Array): Uint8Array {
    if (frame.byteLength !== 1920) throw new Error("invalid_audio_frame");
    const input = new DataView(
      frame.buffer,
      frame.byteOffset,
      frame.byteLength,
    );
    const output = Buffer.alloc(320);
    for (let i = 0; i < 960; i++) {
      this.history[this.position] = input.getInt16(i * 2, true);
      this.position = (this.position + 1) % 63;
      if (i % 6 !== 5) continue;
      let sample = 0;
      for (let j = 0; j < 63; j++)
        sample +=
          (this.history[(this.position + j) % 63] ?? 0) * (this.kernel[j] ?? 0);
      output.writeInt16LE(
        Math.max(-32768, Math.min(32767, Math.round(sample))),
        Math.floor(i / 6) * 2,
      );
    }
    return output;
  }
}
