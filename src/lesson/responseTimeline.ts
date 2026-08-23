import type { BoardOp } from '../../shared/boardOps';
import type { GenerationIdentity } from '../../shared/runtimeProtocol';

export type ResponseCue =
  | { kind: 'caption'; cueId: string; responseId: string; startSample: number; endSample: number; sequence: number; identity: GenerationIdentity; delta: string }
  | { kind: 'visual'; cueId: string; responseId: string; startSample: number; endSample: number; sequence: number; identity: GenerationIdentity; ops: BoardOp[]; eventId: number | null; visualCueId?: string; semanticObjectId?: string; groupLabel?: string; checkpoint?: string; idempotencyKey?: string }
  | { kind: 'final'; cueId: string; responseId: string; startSample: number; endSample: number; sequence: number; identity: GenerationIdentity; text: string };

/**
 * Deterministic cue scheduler. The proxy derives cue offsets from PCM bytes;
 * this class releases captions, visuals, character targets, and final text
 * from the same heard-sample playhead. These are derived local boundaries,
 * not provider word timestamps.
 */
export class ResponseCueTimeline {
  private pending: ResponseCue[] = [];
  private seen = new Set<string>();
  private cancelledIdentities = new Set<string>();

  enqueue(cue: ResponseCue): boolean {
    if (!cue.cueId || this.seen.has(cue.cueId) || this.cancelledIdentities.has(identityKey(cue.identity))) return false;
    if (!Number.isInteger(cue.startSample) || !Number.isInteger(cue.endSample) || cue.startSample < 0 || cue.endSample < cue.startSample) return false;
    this.seen.add(cue.cueId);
    this.pending.push(cue);
    this.pending.sort((left, right) => left.endSample - right.endSample || left.sequence - right.sequence || left.cueId.localeCompare(right.cueId));
    return true;
  }

  drain(playedSamples: (responseId: string) => number): ResponseCue[] {
    const ready: ResponseCue[] = [];
    const waiting: ResponseCue[] = [];
    for (const cue of this.pending) {
      if (playedSamples(cue.responseId) >= cue.endSample) ready.push(cue);
      else waiting.push(cue);
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
