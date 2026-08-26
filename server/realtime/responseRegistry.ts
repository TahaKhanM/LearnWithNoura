import type { GenerationIdentity } from '../../shared/runtimeProtocol.js';
import { ResponseSegmentAnnotator } from './segmentAnnotator.js';
import type { CoordinatorContext } from './coordinatorContext.js';

/**
 * Per-provider-response bookkeeping: which generation each response belongs
 * to, its segment annotator, and which responses were cancelled by barge-in.
 * Late provider deltas keep their original identity, so events for an
 * interrupted response are rejected by the client rather than replayed into
 * the new generation.
 */

export function identityForResponse(ctx: CoordinatorContext, responseId: unknown): GenerationIdentity | null {
  return typeof responseId === 'string'
    ? ctx.state.responseIdentities.get(responseId) ?? ctx.state.clientIdentity
    : ctx.state.clientIdentity;
}

export function responseSegment(ctx: CoordinatorContext, responseId: string): ResponseSegmentAnnotator {
  const existing = ctx.state.responseSegments.get(responseId);
  if (existing) return existing;
  const created = new ResponseSegmentAnnotator();
  ctx.state.responseSegments.set(responseId, created);
  return created;
}

export function flushResponseSegment(ctx: CoordinatorContext, responseId: string, completed: boolean): void {
  const segment = ctx.state.responseSegments.get(responseId);
  ctx.state.responseSegments.delete(responseId);
  if (!segment || !completed || ctx.state.cancelledResponses.has(responseId)) return;
  for (const cue of segment.seal()) {
    ctx.sendClient({ ...cue.payload, response_id: responseId }, identityForResponse(ctx, responseId), cue.optional);
  }
}

export function addBounded(set: Set<string>, value: string, limit: number): void {
  set.add(value);
  if (set.size <= limit) return;
  const oldest = set.values().next().value;
  if (oldest !== undefined) set.delete(oldest);
}
