import type { BoardOp } from '../../shared/boardOps';
import type { DeliveredTask } from '../../shared/lessonTurn';
import type { GenerationIdentity } from '../../shared/runtimeProtocol';

export type ResponseCue =
  | { kind: 'visual'; cueId: string; responseId: string; sequence: number; identity: GenerationIdentity; ops: BoardOp[]; eventId: number | null; visualCueId?: string; semanticObjectId?: string; groupLabel?: string; checkpoint?: string; replacesGroup?: string; idempotencyKey?: string; awaitNarration?: boolean }
  | { kind: 'semantic'; cueId: string; responseId: string; sequence: number; identity: GenerationIdentity; state: Record<string, unknown>; semanticObjectId?: string }
  | { kind: 'task'; cueId: string; responseId: string; sequence: number; identity: GenerationIdentity; task: DeliveredTask }
  | { kind: 'final'; cueId: string; responseId: string; sequence: number; identity: GenerationIdentity; text: string };

/** What the session knows about a response's audible playback: currently
 * playing, not started yet (audio may still come), or finished for good
 * (played out, retired, done-with-no-audio, or no voice plane at all). */
export type ResponsePlaybackStatus = 'playing' | 'pending' | 'finished';

/**
 * Deterministic cue scheduler bound to real playback boundaries. Ordinary
 * board draws release as soon as they arrive so the picture is visible
 * while the tutor is still talking about it. Lesson-state, task banners,
 * and final caption corrections still wait while that response is audibly
 * playing. A response that is not playing releases those immediately.
 *
 * Storyboard step cues (`awaitNarration`) bind to the END of their tagged
 * response: they hold until that response has finished playing, so a reveal
 * lands exactly at the previous beat's playback boundary rather than at its
 * start. A response that will never play (finished with no audio, retired,
 * or a session without a voice plane) releases them immediately.
 */
export class ResponseCueTimeline {
  private pending: ResponseCue[] = [];
  private seen = new Set<string>();
  private cancelledIdentities = new Set<string>();

  enqueue(cue: ResponseCue): boolean {
    if (!cue.cueId || this.seen.has(cue.cueId) || this.cancelledIdentities.has(identityKey(cue.identity))) return false;
    this.seen.add(cue.cueId);
    this.pending.push(cue);
    this.pending.sort((left, right) => left.sequence - right.sequence || left.cueId.localeCompare(right.cueId));
    return true;
  }

  drain(status: (responseId: string) => ResponsePlaybackStatus): ResponseCue[] {
    const ready: ResponseCue[] = [];
    const waiting: ResponseCue[] = [];
    for (const cue of this.pending) {
      const playback = status(cue.responseId);
      const held = cue.kind === 'visual'
        ? cue.awaitNarration && playback !== 'finished'
        : playback === 'playing';
      if (held) waiting.push(cue);
      else ready.push(cue);
    }
    this.pending = waiting;
    return ready;
  }

  cancel(identity?: GenerationIdentity): ResponseCue[] {
    if (!identity) {
      const removed = this.pending;
      for (const cue of removed) this.rememberCancelled(cue.identity);
      this.pending = [];
      this.forget(removed);
      return removed;
    }
    this.rememberCancelled(identity);
    const removed: ResponseCue[] = [];
    this.pending = this.pending.filter((cue) => {
      const matches = sameIdentity(cue.identity, identity);
      if (matches) removed.push(cue);
      return !matches;
    });
    this.forget(removed);
    return removed;
  }

  /** Removes unreleased board events without cancelling their whole
   * generation. Once a cue has drained it is already first-painted and this
   * intentionally becomes a no-op, preserving the permanence contract. */
  cancelVisualEvents(eventIds: Iterable<number>): ResponseCue[] {
    const targets = new Set(eventIds);
    if (targets.size === 0) return [];
    const removed: ResponseCue[] = [];
    this.pending = this.pending.filter((cue) => {
      const matches = cue.kind === 'visual' && cue.eventId !== null && targets.has(cue.eventId);
      if (matches) removed.push(cue);
      return !matches;
    });
    this.forget(removed);
    return removed;
  }

  pendingCount(kind?: ResponseCue['kind']): number {
    return kind ? this.pending.filter((cue) => cue.kind === kind).length : this.pending.length;
  }

  /** A cancelled cue never applied, so its (stable) cue id must be free to
   * re-enqueue when the server legitimately re-sends the same board event
   * under the next generation identity. */
  private forget(removed: ResponseCue[]): void {
    for (const cue of removed) this.seen.delete(cue.cueId);
  }

  private rememberCancelled(identity: GenerationIdentity): void {
    this.cancelledIdentities.add(identityKey(identity));
    if (this.cancelledIdentities.size > 64) this.cancelledIdentities.delete(this.cancelledIdentities.values().next().value as string);
  }
}

function sameIdentity(left: GenerationIdentity, right: GenerationIdentity): boolean {
  return left.sessionId === right.sessionId && left.connectionEpoch === right.connectionEpoch && left.turnId === right.turnId && left.generationId === right.generationId;
}

function identityKey(identity: GenerationIdentity): string {
  return `${identity.sessionId}\u0000${identity.connectionEpoch}\u0000${identity.turnId}\u0000${identity.generationId}`;
}
