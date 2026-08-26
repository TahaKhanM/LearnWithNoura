import type { GenerationIdentity } from '../../shared/runtimeProtocol.js';
import type { CoordinatorContext } from './coordinatorContext.js';

/**
 * Per-provider-response bookkeeping: which generation each response belongs
 * to and which responses were cancelled by barge-in. Late provider deltas
 * keep their original identity, so events for an interrupted response are
 * rejected by the client rather than replayed into the new generation.
 */

export function identityForResponse(ctx: CoordinatorContext, responseId: unknown): GenerationIdentity | null {
  return typeof responseId === 'string'
    ? ctx.state.responseIdentities.get(responseId) ?? ctx.state.clientIdentity
    : ctx.state.clientIdentity;
}

export function addBounded(set: Set<string>, value: string, limit: number): void {
  set.add(value);
  if (set.size <= limit) return;
  const oldest = set.values().next().value;
  if (oldest !== undefined) set.delete(oldest);
}
