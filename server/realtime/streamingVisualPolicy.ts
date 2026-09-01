import type { BoardOp } from '../../shared/boardOps.js';
import type { BoardContextTracker } from './boardContext.js';

/** Rejects exact redraws under fresh ids before an incrementally committed
 * step reaches staging. Streaming cannot wait for a whole-scene duplicate
 * check without forfeiting early paint, so every step enforces novelty. */
export function streamedStepDuplicateReasons(
  board: Pick<BoardContextTracker, 'novelTutorOps'>,
  ops: BoardOp[],
): string[] {
  return board.novelTutorOps(ops).duplicates.map(({ requestedId, existingId }) =>
    `streamed object ${requestedId} duplicates visible tutor object ${existingId}`);
}
