import {
  TELEMETRY_SCHEMA_VERSION,
  type MetricInput,
} from '../../shared/sessionTelemetry';

const MAX_TRACKED_BOUNDARIES = 64;

export interface BoardRevealCorrelation {
  visualCueId?: string;
  semanticObjectId?: string;
}

interface AwaitedReveal {
  revealMs: number;
  correlation: BoardRevealCorrelation;
}

export class ResponseTimingTracker {
  private narrationBoundaries = new Map<string, number>();
  private seenVisualCueIds = new Set<string>();
  /** A storyboard step reveal waiting for the beat narration that follows. */
  private awaitedReveal: AwaitedReveal | null = null;

  /**
   * A storyboard step just became visible; the NEXT narration start narrates
   * it. Only the latest awaited reveal is held, and a cue already counted
   * (for example a re-sent step cue after an interruption) is never counted
   * again.
   */
  noteAwaitedReveal(revealMs: number, correlation: BoardRevealCorrelation): void {
    if (!isUsableBoundary(revealMs)) return;
    if (correlation.visualCueId && this.seenVisualCueIds.has(correlation.visualCueId)) return;
    this.awaitedReveal = { revealMs, correlation };
  }

  noteNarrationScheduled(responseId: string, boundaryMs: number): MetricInput | null {
    if (!responseId || !isUsableBoundary(boundaryMs) || this.narrationBoundaries.has(responseId)) return null;
    this.narrationBoundaries.set(responseId, boundaryMs);
    trimOldest(this.narrationBoundaries);
    if (!this.awaitedReveal) return null;
    const { revealMs, correlation } = this.awaitedReveal;
    this.awaitedReveal = null;
    if (correlation.visualCueId) {
      this.seenVisualCueIds.add(correlation.visualCueId);
      trimOldest(this.seenVisualCueIds);
    }
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      name: 'board_reveal_to_narration',
      unit: 'ms',
      value: Math.round(boundaryMs - revealMs),
      ...(correlation.visualCueId ? { visualCueId: correlation.visualCueId } : {}),
      ...(correlation.semanticObjectId ? { semanticObjectId: correlation.semanticObjectId } : {}),
    };
  }

  noteBoardReveal(
    responseId: string,
    revealMs: number,
    correlation: BoardRevealCorrelation,
  ): MetricInput | null {
    if (!responseId || !isUsableBoundary(revealMs)) return null;
    const narrationMs = this.narrationBoundaries.get(responseId);
    if (narrationMs === undefined) return null;
    if (correlation.visualCueId) {
      if (this.seenVisualCueIds.has(correlation.visualCueId)) return null;
      this.seenVisualCueIds.add(correlation.visualCueId);
      trimOldest(this.seenVisualCueIds);
    }
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      name: 'board_reveal_to_narration',
      unit: 'ms',
      value: Math.round(narrationMs - revealMs),
      ...(correlation.visualCueId ? { visualCueId: correlation.visualCueId } : {}),
      ...(correlation.semanticObjectId ? { semanticObjectId: correlation.semanticObjectId } : {}),
    };
  }

  resetGeneration(): void {
    this.narrationBoundaries.clear();
    this.seenVisualCueIds.clear();
    this.awaitedReveal = null;
  }
}

function isUsableBoundary(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function trimOldest(collection: Map<unknown, unknown> | Set<unknown>): void {
  if (collection.size <= MAX_TRACKED_BOUNDARIES) return;
  collection.delete(collection.keys().next().value);
}
