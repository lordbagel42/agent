/* Runs only in June's isolated media peer. Never requests a physical device. */
class JuneAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.capture = new Int16Array(960);
    this.captured = 0;
    this.port.onmessage = ({ data }) => {
      if (data === "clear") {
        this.queue = [];
        this.offset = 0;
      } else if (data instanceof ArrayBuffer && data.byteLength === 1920) {
        if (this.queue.length >= 25) this.port.postMessage("overflow");
        else this.queue.push(new Int16Array(data));
      }
    };
  }
  process(inputs, outputs) {
    const output = outputs[0][0];
    const input = inputs[0];
    for (let i = 0; i < output.length; i++) {
      output[i] = this.queue.length ? this.queue[0][this.offset++] / 32768 : 0;
      if (this.offset === 960) {
        this.queue.shift();
        this.offset = 0;
      }
      let sample = 0;
      for (const channel of input) sample += channel[i] || 0;
      if (input.length) sample /= input.length;
      this.capture[this.captured++] = Math.round(
        Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
      );
      if (this.captured === 960) {
        this.port.postMessage(this.capture.buffer, [this.capture.buffer]);
        this.capture = new Int16Array(960);
        this.captured = 0;
      }
    }
    return true;
  }
}
registerProcessor("june-audio", JuneAudio);
