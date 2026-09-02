/**
 * Playback-aware subtitle state.
 *
 * Realtime transcript events describe generation progress, not what the
 * browser has audibly played. This timeline keeps each response in its
 * original conversation position, holds generated text until local playback
 * starts, releases one fluent phrase at a time, and corrects that response in
 * place when the final transcript arrives. Child turns share the same ordered
 * ledger, so a late final event can never jump behind a later turn.
 */

export interface CaptionLine {
  role: 'tutor' | 'child';
  text: string;
  live: boolean;
  responseId?: string;
}

type TutorState = 'pending' | 'playing' | 'finished' | 'unavailable' | 'interrupted';

interface ChildGroup {
  kind: 'child';
  text: string;
}

interface TutorGroup {
  kind: 'tutor';
  responseId: string;
  state: TutorState;
  transcript: string;
  finalText: string | null;
  lines: string[];
  nextReleaseAt: number;
}

type CaptionGroup = ChildGroup | TutorGroup;

const MAX_GROUPS = 96;
const MAX_LINES = 100;
const MIN_PHRASE_MS = 650;
const MAX_PHRASE_MS = 2_400;
const MS_PER_WORD = 245;

export class ResponseCaptionTimeline {
  private groups: CaptionGroup[] = [];
  private tutors = new Map<string, TutorGroup>();

  registerResponse(responseId: string, audioExpected = true): boolean {
    if (!responseId || this.tutors.has(responseId)) return false;
    const group: TutorGroup = {
      kind: 'tutor',
      responseId,
      state: audioExpected ? 'pending' : 'unavailable',
      transcript: '',
      finalText: null,
      lines: [],
      nextReleaseAt: 0,
    };
    this.groups.push(group);
    this.tutors.set(responseId, group);
    this.trimGroups();
    return false;
  }

  appendChild(text: string): boolean {
    const clean = text.trim();
    if (!clean) return false;
    this.groups.push({ kind: 'child', text: clean });
    this.trimGroups();
    return true;
  }

  appendTutorText(text: string, responseId?: string): boolean {
    const clean = text.trim();
    if (!clean) return false;
    if (!responseId) {
      this.groups.push({
        kind: 'tutor', responseId: `local-${crypto.randomUUID()}`,
        state: 'finished', transcript: clean, finalText: clean,
        lines: segmentPhrases(clean), nextReleaseAt: 0,
      });
      this.trimGroups();
      return true;
    }
    this.registerResponse(responseId, false);
    return this.finishTranscript(responseId, clean, 0, false);
  }

  pushDelta(responseId: string, delta: string, now: number, audioExpected: boolean): boolean {
    if (!responseId || !delta) return false;
    const group = this.ensureTutor(responseId, audioExpected);
    if (group.state === 'interrupted') return false;
    group.transcript += delta;
    if (!audioExpected && group.state === 'pending') group.state = 'unavailable';
    if (group.state === 'playing') return this.advanceGroup(group, now);
    if (group.state === 'unavailable') {
      const next = splitPhrases(group.transcript, false);
      if (sameStrings(group.lines, next)) return false;
      group.lines = next;
      return true;
    }
    return false;
  }

  finishTranscript(responseId: string, text: string, now: number, audioExpected: boolean): boolean {
    const clean = text.trim();
    if (!responseId || !clean) return false;
    const group = this.ensureTutor(responseId, audioExpected);
    if (group.state === 'interrupted') return false;
    group.finalText = clean;
    const finalPhrases = segmentPhrases(clean);
    let changed = false;
    if (group.lines.length > 0) {
      const correctedPrefix = finalPhrases.slice(0, Math.min(group.lines.length, finalPhrases.length));
      if (!sameStrings(group.lines, correctedPrefix)) {
        group.lines = correctedPrefix;
        changed = true;
      }
    }
    if (!audioExpected && group.state === 'pending') group.state = 'unavailable';
    if (group.state === 'finished' || group.state === 'unavailable') {
      if (!sameStrings(group.lines, finalPhrases)) {
        group.lines = finalPhrases;
        changed = true;
      }
      return changed;
    }
    return this.advanceGroup(group, now) || changed;
  }

  playbackStarted(responseId: string, now: number): boolean {
    if (!responseId) return false;
    const group = this.ensureTutor(responseId, true);
    if (group.state === 'interrupted') return false;
    group.state = 'playing';
    group.nextReleaseAt = Math.min(group.nextReleaseAt || now, now);
    return this.advanceGroup(group, now);
  }

  playbackFinished(responseId: string): boolean {
    const group = this.tutors.get(responseId);
    if (!group || group.state === 'interrupted') return false;
    const source = this.sourcePhrases(group, true);
    const changed = group.state !== 'finished' || !sameStrings(group.lines, source);
    group.state = 'finished';
    group.lines = source;
    group.nextReleaseAt = 0;
    return changed;
  }

  audioUnavailable(responseId: string): boolean {
    const group = this.tutors.get(responseId);
    if (!group || group.state === 'interrupted' || group.state === 'finished') return false;
    const source = this.sourcePhrases(group, true);
    const changed = group.state !== 'unavailable' || !sameStrings(group.lines, source);
    group.state = 'unavailable';
    group.lines = source;
    group.nextReleaseAt = 0;
    return changed;
  }

  audioUnavailableForPending(): boolean {
    let changed = false;
    for (const group of this.tutors.values()) {
      if (group.state === 'pending' || group.state === 'playing') {
        changed = this.audioUnavailable(group.responseId) || changed;
      }
    }
    return changed;
  }

  interrupt(responseId: string): boolean {
    const group = this.tutors.get(responseId);
    if (!group || group.state === 'interrupted') return false;
    group.state = 'interrupted';
    group.lines = group.lines.filter(Boolean);
    group.nextReleaseAt = 0;
    return true;
  }

  advance(now: number): boolean {
    let changed = false;
    for (const group of this.tutors.values()) {
      if (group.state === 'playing') changed = this.advanceGroup(group, now) || changed;
    }
    return changed;
  }

  lines(): CaptionLine[] {
    const lines: CaptionLine[] = [];
    for (const group of this.groups) {
      if (group.kind === 'child') {
        lines.push({ role: 'child', text: group.text, live: false });
        continue;
      }
      const live = group.state === 'playing' || (group.state === 'unavailable' && group.finalText === null);
      // Phrase pacing is an internal release clock, not separate dialogue
      // rows. Project one cumulative line per response so the learner sees
      // the sentence grow in place and a completed response never collapses
      // to only its final phrase (for example, just “question.”).
      const text = group.lines.join(' ').trim();
      if (text) lines.push({ role: 'tutor', text, live, responseId: group.responseId });
    }
    return lines.slice(-MAX_LINES);
  }

  private ensureTutor(responseId: string, audioExpected: boolean): TutorGroup {
    const existing = this.tutors.get(responseId);
    if (existing) return existing;
    this.registerResponse(responseId, audioExpected);
    return this.tutors.get(responseId) as TutorGroup;
  }

  private advanceGroup(group: TutorGroup, now: number): boolean {
    if (group.state !== 'playing' || now < group.nextReleaseAt) return false;
    const source = this.sourcePhrases(group, false);
    if (group.lines.length >= source.length) return false;
    const next = source[group.lines.length];
    group.lines = [...group.lines, next];
    group.nextReleaseAt = now + phraseDurationMs(next);
    return true;
  }

  private sourcePhrases(group: TutorGroup, includeTail: boolean): string[] {
    if (group.finalText !== null) return segmentPhrases(group.finalText);
    return splitPhrases(group.transcript, includeTail);
  }

  private trimGroups(): void {
    while (this.groups.length > MAX_GROUPS) {
      const removed = this.groups.shift();
      if (removed?.kind === 'tutor') this.tutors.delete(removed.responseId);
    }
  }
}

function phraseDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(MIN_PHRASE_MS, Math.min(MAX_PHRASE_MS, words * MS_PER_WORD));
}

function phraseBoundary(text: string): number {
  const punctuation = [...text.matchAll(/[.!?;:]\s+/g)].at(-1);
  if (punctuation && punctuation.index !== undefined) return punctuation.index + punctuation[0].length;
  if (text.length < 92) return 0;
  const breakAt = text.lastIndexOf(' ', 92);
  return breakAt > 36 ? breakAt + 1 : 92;
}

function splitPhrases(text: string, includeTail: boolean): string[] {
  const phrases: string[] = [];
  let remaining = text.trimStart();
  while (remaining) {
    const boundary = phraseBoundary(remaining);
    if (boundary === 0) break;
    const phrase = remaining.slice(0, boundary).trim();
    if (phrase) phrases.push(phrase);
    remaining = remaining.slice(boundary).trimStart();
  }
  const tail = remaining.trim();
  if (includeTail && tail) phrases.push(tail);
  return phrases;
}

export function segmentPhrases(text: string): string[] {
  return splitPhrases(text, true).filter(Boolean);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
