export const ILLUSTRATION_GENERATION_BUDGET = 2;

export function generationsSpent(result: { cacheHit: boolean; imageCount: number }): number {
  return result.cacheHit ? 0 : Math.max(0, result.imageCount);
}

export type IllustrationPreparePhase = 'pending' | 'ok' | 'fail';

export type IllustrationArrivalDecision =
  | { action: 'wait' }
  | { action: 'append_final_step' }
  | { action: 'stage_checkpoint' }
  | { action: 'fail_honest' };

/**
 * Arrival policy for the parallel illustration lane. Overlay steps reveal
 * independently. A ready image is the final reveal while the same run is
 * still active; after that run has finished it arrives as an ordinary
 * server-initiated checkpoint. Generation failure never removes overlays.
 */
export function decideIllustrationArrival(input: {
  runActiveForRequest: boolean;
  overlayComplete: boolean;
  prepare: IllustrationPreparePhase;
}): IllustrationArrivalDecision {
  if (input.prepare === 'pending') return { action: 'wait' };
  if (input.prepare === 'fail') return { action: 'fail_honest' };
  if (!input.overlayComplete) return { action: 'wait' };
  if (input.runActiveForRequest) return { action: 'append_final_step' };
  return { action: 'stage_checkpoint' };
}

export type ClosedIllustrationVisionIssue =
  | 'embedded_text'
  | 'unsafe'
  | 'missing_required'
  | 'rejected'
  | 'invalid_verdict';

export function closedIllustrationVisionIssues(
  input:
    | { kind: 'invalid' }
    | {
      kind: 'verdict';
      approved: boolean;
      hasEmbeddedText: boolean;
      unsafe: boolean;
      missingRequired: boolean;
    },
): ClosedIllustrationVisionIssue[] {
  if (input.kind === 'invalid') return ['invalid_verdict'];
  const issues: ClosedIllustrationVisionIssue[] = [];
  if (input.hasEmbeddedText) issues.push('embedded_text');
  if (input.unsafe) issues.push('unsafe');
  if (input.missingRequired) issues.push('missing_required');
  if (!input.approved && issues.length === 0) issues.push('rejected');
  return issues;
}

export function illustrationVisionReason(issue: ClosedIllustrationVisionIssue): string {
  return `illustration_vision:${issue}`;
}
