import { describe, expect, it } from 'vitest';
import {
  canSpendIllustrationGeneration,
  closedIllustrationVisionIssues,
  decideIllustrationArrival,
  generationsSpent,
  illustrationVisionReason,
  ILLUSTRATION_GENERATION_BUDGET,
} from './illustrationArrival.js';

describe('illustration generation budget', () => {
  it('allows at most two paid generations per lesson and treats cache hits as free', () => {
    expect(ILLUSTRATION_GENERATION_BUDGET).toBe(2);
    expect(canSpendIllustrationGeneration(0)).toBe(true);
    expect(canSpendIllustrationGeneration(1)).toBe(true);
    expect(canSpendIllustrationGeneration(2)).toBe(false);
    expect(generationsSpent({ cacheHit: true, imageCount: 0 })).toBe(0);
    expect(generationsSpent({ cacheHit: false, imageCount: 1 })).toBe(1);
    expect(generationsSpent({ cacheHit: false, imageCount: 2 })).toBe(2);
  });
});

describe('illustration arrival ordering', () => {
  it('holds a fast image until overlay steps are complete so it remains the final reveal', () => {
    expect(decideIllustrationArrival({
      runActiveForRequest: true,
      overlayComplete: false,
      prepare: 'ok',
    })).toEqual({ action: 'wait' });
    expect(decideIllustrationArrival({
      runActiveForRequest: false,
      overlayComplete: false,
      prepare: 'ok',
    })).toEqual({ action: 'wait' });
  });

  it('appends a ready image as the final reveal step while the same run is still active', () => {
    expect(decideIllustrationArrival({
      runActiveForRequest: true,
      overlayComplete: true,
      prepare: 'ok',
    })).toEqual({ action: 'append_final_step' });
  });

  it('stages a server-initiated checkpoint when the run has already completed', () => {
    expect(decideIllustrationArrival({
      runActiveForRequest: false,
      overlayComplete: true,
      prepare: 'ok',
    })).toEqual({ action: 'stage_checkpoint' });
  });

  it('fails closed with an honest note when generation fails, even if overlays are still revealing', () => {
    expect(decideIllustrationArrival({
      runActiveForRequest: true,
      overlayComplete: false,
      prepare: 'fail',
    })).toEqual({ action: 'fail_honest' });
  });

  it('waits while generation is still in flight', () => {
    expect(decideIllustrationArrival({
      runActiveForRequest: true,
      overlayComplete: true,
      prepare: 'pending',
    })).toEqual({ action: 'wait' });
  });
});

describe('illustration vision closed codes', () => {
  it('never carries free-text inspection issues', () => {
    expect(closedIllustrationVisionIssues({
      kind: 'verdict',
      approved: false,
      hasEmbeddedText: true,
      unsafe: false,
      missingRequired: false,
    }).map(illustrationVisionReason)).toEqual(['illustration_vision:embedded_text']);
    expect(closedIllustrationVisionIssues({
      kind: 'verdict',
      approved: false,
      hasEmbeddedText: false,
      unsafe: false,
      missingRequired: false,
    }).map(illustrationVisionReason)).toEqual(['illustration_vision:rejected']);
    expect(closedIllustrationVisionIssues({ kind: 'invalid' }).map(illustrationVisionReason))
      .toEqual(['illustration_vision:invalid_verdict']);
  });
});
