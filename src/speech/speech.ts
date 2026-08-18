import { toSpokenText, estimateSpeakingMs } from './spokenText';

/**
 * Speech is deliberately fire and forget: `speak` starts talking and
 * returns immediately, while `whenIdle` resolves once the current line has
 * finished. That split is what lets the board carry on drawing mid
 * sentence, the way a teacher talks and draws at the same time, while
 * still preventing the next sentence from stepping on this one.
 *
 * The audio comes from ElevenLabs through the backend proxy and is played
 * through Web Audio rather than an <audio> element. Web Audio decodes the
 * clip up front and stops on the sample, so cutting the tutor off the
 * instant a child presses to talk is exact rather than approximate.
 */

const supported =
  typeof window !== 'undefined' &&
  typeof (window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext) !== 'undefined';

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

let enabled = true;
let currentLine: Promise<void> = Promise.resolve();

// Bumped on every new line and on cancel, so a clip that was already in
// flight when the child interrupted can tell that it is no longer wanted.
let generation = 0;

let context: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let inFlight: AbortController | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function audioContext(): AudioContext {
  if (!context) {
    const Ctor = window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
    context = new (Ctor as typeof AudioContext)();
  }
  return context;
}

export function isSpeechSupported(): boolean {
  return supported;
}

/**
 * Call from a real user gesture. Browsers start an AudioContext suspended
 * and only a gesture may resume it, so this is what buys the right to
 * speak later without another tap.
 */
export function primeAudio(): void {
  if (!supported) return;
  const ctx = audioContext();
  if (ctx.state === 'suspended') void ctx.resume();
}

export function setSpeechEnabled(value: boolean): void {
  enabled = value;
  if (!value) cancelSpeech();
}

function stopSource(): void {
  if (!source) return;
  source.onended = null;
  try {
    source.stop();
  } catch {
    // Already stopped, which is fine.
  }
  source.disconnect();
  source = null;
}

async function playLine(text: string, spoken: string, mine: number): Promise<void> {
  const controller = new AbortController();
  inFlight = controller;

  try {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spoken }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TTS request failed (${response.status})`);

    const encoded = await response.arrayBuffer();
    if (mine !== generation) return;

    const ctx = audioContext();
    // Autoplay policy can leave the context suspended if the lesson began
    // without a gesture. Resuming is a no-op when it is already running.
    if (ctx.state === 'suspended') await ctx.resume();

    const buffer = await ctx.decodeAudioData(encoded);
    if (mine !== generation) return;

    await new Promise<void>((resolve) => {
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.onended = () => resolve();
      source = node;
      node.start();
      // A clip that never fires `ended` must not hang the lesson.
      setTimeout(resolve, buffer.duration * 1000 + 4000);
    });

    if (mine === generation) stopSource();
  } catch (err) {
    if (mine !== generation) return;
    // Aborts are the expected path when a child interrupts, so they are not
    // worth reporting. Anything else falls back to timing only, which keeps
    // the lesson moving at a believable pace instead of racing ahead.
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      console.warn('Falling back to silent pacing:', err);
      await delay(estimateSpeakingMs(text));
    }
  } finally {
    if (inFlight === controller) inFlight = null;
  }
}

export function speak(text: string): void {
  const spoken = toSpokenText(text);
  if (!spoken) return;

  cancelSpeech();
  const mine = ++generation;

  if (!supported || !enabled) {
    // Keep the pacing honest even with no audio, so the lesson does not
    // suddenly race ahead when the sound is off.
    currentLine = delay(estimateSpeakingMs(text));
    return;
  }

  currentLine = playLine(text, spoken, mine);
}

export function whenIdle(): Promise<void> {
  return currentLine;
}

export function cancelSpeech(): void {
  generation += 1;
  inFlight?.abort();
  inFlight = null;
  stopSource();
  currentLine = Promise.resolve();
}
