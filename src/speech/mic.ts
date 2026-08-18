/**
 * Push to talk. The child holds the button, speaks, and lets go; the
 * recording goes to Scribe and comes back as text, which is then asked of
 * the tutor exactly as if it had been typed.
 */

// Chrome and Firefox record WebM/Opus, Safari records MP4/AAC. Scribe
// accepts all of them, so the job is only to pick one the browser can do.
const CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export function pickMimeType(
  isSupported: (type: string) => boolean = (t) => MediaRecorder.isTypeSupported(t),
): string | undefined {
  return CANDIDATES.find(isSupported);
}

export function isMicSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined'
  );
}

/** Recordings shorter than this are a mis-tap rather than a question. */
export const MIN_RECORDING_MS = 350;

export class MicRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  get active(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(): Promise<void> {
    if (this.active) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      // The tutor is usually speaking through the same speakers, so ask the
      // browser to keep its own voice out of the child's recording.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.startedAt = Date.now();
    this.recorder.start();
  }

  /** Stops recording and returns the clip, or null if it was too short. */
  async stop(): Promise<Blob | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      this.release();
      return null;
    }

    const held = Date.now() - this.startedAt;

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }));
      };
      recorder.stop();
    });

    this.release();
    if (held < MIN_RECORDING_MS || blob.size === 0) return null;
    return blob;
  }

  /** Drops the recording and the microphone without transcribing. */
  release(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

export async function transcribe(clip: Blob): Promise<string> {
  const response = await fetch('/api/stt', {
    method: 'POST',
    headers: { 'Content-Type': clip.type || 'audio/webm' },
    body: clip,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Transcription failed (${response.status})`);
  }

  const result = (await response.json()) as { text?: string };
  return (result.text || '').trim();
}
