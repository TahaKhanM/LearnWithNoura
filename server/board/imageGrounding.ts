import { validateAnchorRef, type ImageRegionSelector } from '../../shared/boardOps.js';
import type { VisionAuditPort } from './visionAudit.js';

export const IMAGE_GROUNDING_CONFIDENCE_THRESHOLD = 0.72;

export interface ImageGroundingProposalPort {
  propose(input: {
    imageId: string;
    hint: string;
    boardImage: string;
  }, options: { signal: AbortSignal }): Promise<{
    selector: ImageRegionSelector;
    confidence: number;
  } | null>;
}

export type ImageGroundingResult =
  | { status: 'grounded'; selector: ImageRegionSelector; confidence: number }
  | { status: 'tap_required'; reason: 'low_confidence' | 'invalid_proposal' | 'render_failed' | 'self_check_failed' | 'grounding_unavailable' };

export async function groundImageRegion(input: {
  imageId: string;
  hint: string;
  boardImage: string;
  proposal: ImageGroundingProposalPort;
  audit: VisionAuditPort;
  renderCandidate: (selector: ImageRegionSelector) => Promise<string | null>;
  signal: AbortSignal;
  confidenceThreshold?: number;
}): Promise<ImageGroundingResult> {
  try {
    const proposal = await input.proposal.propose({
      imageId: input.imageId,
      hint: input.hint,
      boardImage: input.boardImage,
    }, { signal: input.signal });
    throwIfAborted(input.signal);
    if (!proposal || !Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
      return { status: 'tap_required', reason: 'invalid_proposal' };
    }
    const validated = validateAnchorRef({ type: 'image_region', imageId: input.imageId, selector: proposal.selector });
    if (!validated || validated.type !== 'image_region') return { status: 'tap_required', reason: 'invalid_proposal' };
    if (proposal.confidence < (input.confidenceThreshold ?? IMAGE_GROUNDING_CONFIDENCE_THRESHOLD)) {
      return { status: 'tap_required', reason: 'low_confidence' };
    }
    const candidateImage = await input.renderCandidate(validated.selector);
    throwIfAborted(input.signal);
    if (!candidateImage) return { status: 'tap_required', reason: 'render_failed' };
    const audit = await input.audit.inspect({
      purpose: 'Verify one proposed image-region annotation before it reaches the learner.',
      idea: input.hint,
      constraints: 'Approve only when the annotation points to the requested visible image region.',
      candidateImage,
    }, { signal: input.signal });
    throwIfAborted(input.signal);
    return audit.outcome === 'approved'
      ? { status: 'grounded', selector: validated.selector, confidence: proposal.confidence }
      : { status: 'tap_required', reason: 'self_check_failed' };
  } catch (error) {
    if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
    return { status: 'tap_required', reason: 'grounding_unavailable' };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error('Image grounding aborted.');
  error.name = 'AbortError';
  return error;
}
