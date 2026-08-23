/**
 * Microphone capture: echo-cancelled input, downsampled to 24kHz PCM16 in
 * an AudioWorklet, delivered as base64 chunks (~40ms) plus an RMS energy
 * reading used for the listening indicator and fast local barge-in.
 */

const TARGET_RATE = 24000;
const CHUNK_SAMPLES = 960; // 40ms at 24kHz

const WORKLET_SOURCE = `
class SenecaCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = sampleRate / ${TARGET_RATE};
    this.readPos = 0;
    this.buffer = [];
    this.out = new Float32Array(${CHUNK_SAMPLES});
    this.outPos = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) this.buffer.push(channel[i]);
    // Linear-interpolation resample from the context rate to 24kHz.
    while (this.readPos + 1 < this.buffer.length) {
      const idx = Math.floor(this.readPos);
      const frac = this.readPos - idx;
      this.out[this.outPos++] = this.buffer[idx] * (1 - frac) + this.buffer[idx + 1] * frac;
      this.readPos += this.ratio;
      if (this.outPos === ${CHUNK_SAMPLES}) {
        this.port.postMessage(this.out.slice(0));
        this.outPos = 0;
      }
    }
    const keep = Math.floor(this.readPos);
    this.buffer = this.buffer.slice(keep);
    this.readPos -= keep;
    return true;
  }
}
registerProcessor('seneca-capture', SenecaCapture);
`;

export interface MicHandlers {
  onChunk: (base64: string) => void;
  onEnergy: (rms: number) => void;
}

export class AudioIn {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private handlers: MicHandlers;
  muted = false;

  constructor(handlers: MicHandlers) {
    this.handlers = handlers;
  }

  static supported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== 'undefined'
    );
  }

  /** Throws if the user denies the microphone. */
  async start(): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.ctx = new AudioContext();
    const workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
    );
    try {
      await this.ctx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'seneca-capture');
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = event.data;
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      this.handlers.onEnergy(Math.sqrt(sum / samples.length));
      if (this.muted) return;
      this.handlers.onChunk(encodePcm16Base64(samples));
    };
    source.connect(this.node);
    // The worklet needs a destination to keep processing in some browsers;
    // a zero-gain sink keeps the graph alive without feedback.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink);
    sink.connect(this.ctx.destination);
  }

  stop(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

function encodePcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    let v = Math.max(-1, Math.min(1, samples[i]));
    const int = v < 0 ? v * 0x8000 : v * 0x7fff;
    const value = Math.round(int) & 0xffff;
    bytes[2 * i] = value & 0xff;
    bytes[2 * i + 1] = (value >> 8) & 0xff;
  }
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
