import { toSpokenText, estimateSpeakingMs } from './spokenText';

/**
 * Speech is deliberately fire and forget: `speak` starts talking and
 * returns immediately, while `whenIdle` resolves once the current line has
 * finished. That split is what lets the board carry on drawing mid
 * sentence, the way a teacher talks and draws at the same time, while
 * still preventing the next sentence from stepping on this one.
 */

const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

let enabled = true;
let currentLine: Promise<void> = Promise.resolve();
let preferredVoice: SpeechSynthesisVoice | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Voices load asynchronously in most browsers, so resolve lazily and cache.
function pickVoice(): SpeechSynthesisVoice | null {
  if (preferredVoice) return preferredVoice;
  if (!supported) return null;

  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  const english = voices.filter((v) => v.lang.startsWith('en'));
  const pool = english.length > 0 ? english : voices;

  // Prefer the richer system voices where they exist; they are far easier
  // for a child to listen to than the default robotic fallback.
  const nicer = ['samantha', 'karen', 'daniel', 'moira', 'google us english'];
  for (const name of nicer) {
    const match = pool.find((v) => v.name.toLowerCase().includes(name));
    if (match) {
      preferredVoice = match;
      return match;
    }
  }

  preferredVoice = pool[0];
  return preferredVoice;
}

export function isSpeechSupported(): boolean {
  return supported;
}

export function setSpeechEnabled(value: boolean): void {
  enabled = value;
  if (!value) cancelSpeech();
}

export function speak(text: string): void {
  const spoken = toSpokenText(text);
  if (!spoken) return;

  if (!supported || !enabled) {
    // Keep the pacing honest even with no audio, so the lesson does not
    // suddenly race ahead when the sound is off.
    currentLine = delay(estimateSpeakingMs(text));
    return;
  }

  const utterance = new SpeechSynthesisUtterance(spoken);
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 0.98;
  utterance.pitch = 1.05;

  currentLine = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    // Some browsers drop long utterances silently, so never hang the
    // lesson on a promise that may not settle.
    setTimeout(finish, estimateSpeakingMs(text) + 6000);
  });

  window.speechSynthesis.speak(utterance);
}

export function whenIdle(): Promise<void> {
  return currentLine;
}

export function cancelSpeech(): void {
  if (supported) window.speechSynthesis.cancel();
  currentLine = Promise.resolve();
}
