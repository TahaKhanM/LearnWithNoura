import {
  TELEMETRY_SCHEMA_VERSION,
  type MetricInput,
} from '../../shared/sessionTelemetry';

const MAX_TRACKED_BOUNDARIES = 64;

export interface BoardRevealCorrelation {
  visualCueId?: string;
  semanticObjectId?: string;
}

export class ResponseTimingTracker {
  private narrationBoundaries = new Map<string, number>();
  private seenVisualCueIds = new Set<string>();

  noteNarrationScheduled(responseId: string, boundaryMs: number): void {
    if (!responseId || !isUsableBoundary(boundaryMs) || this.narrationBoundaries.has(responseId)) return;
    this.narrationBoundaries.set(responseId, boundaryMs);
    trimOldest(this.narrationBoundaries);
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
  }
}

function isUsableBoundary(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function trimOldest(collection: Map<unknown, unknown> | Set<unknown>): void {
  if (collection.size <= MAX_TRACKED_BOUNDARIES) return;
  collection.delete(collection.keys().next().value);
}
