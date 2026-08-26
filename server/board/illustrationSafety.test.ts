import { describe, expect, it } from 'vitest';
import { refuseUnsafeIllustrationBrief } from './illustrationSafety';

function brief(subject: string) {
  return {
    purpose: 'Show a classroom scene',
    subject,
    requiredElements: [] as string[],
    forbiddenElements: [] as string[],
  };
}

describe('refuseUnsafeIllustrationBrief', () => {
  it('refuses photoreal and portrait bypass strings before generate', () => {
    const bypasses = [
      'A picture of a child at a desk',
      'A portrait of a toddler smiling',
      'A portrait of a kid in a classroom',
      'A selfie of a child',
      'A photoreal kid standing in a garden',
      'A realistic toddler at the pond',
    ];
    for (const subject of bypasses) {
      expect(refuseUnsafeIllustrationBrief(brief(subject)), subject).toMatch(/not safe/i);
    }
  });

  it('allows a non-photoreal educational scene', () => {
    expect(refuseUnsafeIllustrationBrief(brief('A calm pond with a frog and reeds'))).toBeNull();
  });
});
