import { describe, expect, it, vi } from 'vitest';
import { groundImageRegion } from './imageGrounding.js';

const selector = { type: 'FragmentSelector' as const, unit: 'percent' as const, x: 0.2, y: 0.25, w: 0.3, h: 0.2 };

describe('image-region grounding orchestration', () => {
  it('accepts only a high-confidence proposal that passes Luna render-back verification', async () => {
    const propose = vi.fn(async () => ({ selector, confidence: 0.91 }));
    const renderCandidate = vi.fn(async () => 'data:image/jpeg;base64,cmVuZGVyZWQ=');
    const inspect = vi.fn(async () => ({ outcome: 'approved' as const, issues: [] }));
    const result = await groundImageRegion({
      imageId: 'worksheet-image',
      hint: 'the denominator in the left fraction',
      boardImage: 'data:image/jpeg;base64,Ym9hcmQ=',
      proposal: { propose },
      audit: { model: 'gpt-5.6-luna', reasoningEffort: 'low', inspect },
      renderCandidate,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ status: 'grounded', selector, confidence: 0.91 });
    expect(renderCandidate).toHaveBeenCalledWith(selector);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({
      idea: 'the denominator in the left fraction',
      candidateImage: 'data:image/jpeg;base64,cmVuZGVyZWQ=',
    }), expect.any(Object));
  });

  it('falls back to a child tap before render-back when confidence is low', async () => {
    const renderCandidate = vi.fn();
    const inspect = vi.fn();
    const result = await groundImageRegion({
      imageId: 'worksheet-image', hint: 'the axle', boardImage: 'data:image/jpeg;base64,Ym9hcmQ=',
      proposal: { propose: async () => ({ selector, confidence: 0.61 }) },
      audit: { model: 'gpt-5.6-luna', reasoningEffort: 'low', inspect },
      renderCandidate,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ status: 'tap_required', reason: 'low_confidence' });
    expect(renderCandidate).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('falls back on invalid proposals, render failures, or a rejected self-check', async () => {
    const base = {
      imageId: 'worksheet-image', hint: 'the labelled organ', boardImage: 'data:image/jpeg;base64,Ym9hcmQ=',
      audit: { model: 'gpt-5.6-luna' as const, reasoningEffort: 'low' as const, inspect: async () => ({ outcome: 'approved' as const, issues: [] }) },
      signal: new AbortController().signal,
    };
    await expect(groundImageRegion({
      ...base,
      proposal: { propose: async () => ({ selector: { ...selector, x: 0.9 }, confidence: 0.9 }) },
      renderCandidate: async () => 'data:image/jpeg;base64,eA==',
    })).resolves.toEqual({ status: 'tap_required', reason: 'invalid_proposal' });
    await expect(groundImageRegion({
      ...base,
      proposal: { propose: async () => ({ selector, confidence: 0.9 }) },
      renderCandidate: async () => null,
    })).resolves.toEqual({ status: 'tap_required', reason: 'render_failed' });
    await expect(groundImageRegion({
      ...base,
      proposal: { propose: async () => ({ selector, confidence: 0.9 }) },
      audit: { ...base.audit, inspect: async () => ({ outcome: 'rejected' as const, issues: ['private judge prose'] }) },
      renderCandidate: async () => 'data:image/jpeg;base64,eA==',
    })).resolves.toEqual({ status: 'tap_required', reason: 'self_check_failed' });
  });
});
