import type { BoardOp } from '../../shared/boardOps';
import type { DeliveredTask } from '../../shared/lessonTurn';
import type { GenerationIdentity } from '../../shared/runtimeProtocol';

export type ResponseCue =
  | { kind: 'visual'; cueId: string; responseId: string; sequence: number; identity: GenerationIdentity; ops: BoardOp[]; eventId: number | null; visualCueId?: string; semanticObjectId?: string; groupLabel?: string; checkpoint?: string; replacesGroup?: string; idempotencyKey?: string }
  | { kind: 'semantic'; cueId: string; responseId: string; sequence: number; identity: GenerationIdentity; state: Record<string, unknown>; semanticObjectId?: string }
  | { kind: 'task'; cueId: string; responseId: string; sequence: number; identity: GenerationIdentity; task: DeliveredTask }
  | { kind: 'final'; cueId: string; responseId: string; sequence: number; identity: GenerationIdentity; text: string };

/**
 * Deterministic cue scheduler bound to real playback boundaries. While a
 * response is audibly playing (between the provider's data-channel
 * `output_audio_buffer.started` and `.stopped` for it), its visuals, task
 * banner, and final caption correction wait — the child hears the thought
 * before the board changes under them. A response that is not playing (tool
 * results before speech, no-audio responses, retired playback) releases its
 * cues immediately, which also keeps the server's visibility barrier live.
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

  drain(isPlaying: (responseId: string) => boolean): ResponseCue[] {
    const ready: ResponseCue[] = [];
    const waiting: ResponseCue[] = [];
    for (const cue of this.pending) {
      if (isPlaying(cue.responseId)) waiting.push(cue);
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
      return removed;
    }
    this.rememberCancelled(identity);
    const removed: ResponseCue[] = [];
    this.pending = this.pending.filter((cue) => {
      const matches = sameIdentity(cue.identity, identity);
      if (matches) removed.push(cue);
      return !matches;
    });
    return removed;
  }

  pendingCount(kind?: ResponseCue['kind']): number {
    return kind ? this.pending.filter((cue) => cue.kind === kind).length : this.pending.length;
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
