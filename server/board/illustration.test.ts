import { describe, expect, it } from 'vitest';
import { illustrationCacheKey } from './illustrationCache';
import { persistIllustrationRecord, prepareIllustration, type PrepareIllustrationDeps } from './illustration';
import { MemoryIllustrationStore } from './memoryIllustrationStore';
import type { IllustrationBrief, IllustrationGenerateResult } from './illustrationTypes';

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function brief(overrides: Partial<IllustrationBrief> = {}): IllustrationBrief {
  return {
    purpose: 'Show a pond habitat so the child can name living things',
    subject: 'A calm pond with a frog, reeds, and a lily pad',
    style: 'flat educational illustration',
    requiredElements: ['frog', 'reeds'],
    forbiddenElements: ['text', 'numbers'],
    ...overrides,
  };
}

function generated(overrides: Partial<IllustrationGenerateResult> = {}): IllustrationGenerateResult {
  return {
    bytes: PNG,
    mime: 'image/png',
    usage: { totalTokens: 42, inputTokens: 12, outputTokens: 30 },
    ...overrides,
  };
}

const approval = JSON.stringify({
  approved: true, issues: [], hasEmbeddedText: false, unsafe: false, missingRequired: [],
});

function deps(overrides: Partial<PrepareIllustrationDeps> & {
  generateCalls?: Array<{ prompt: string }>;
  visionCalls?: number;
} = {}): PrepareIllustrationDeps & { generateCalls: Array<{ prompt: string }>; visionCalls: number } {
  const generateCalls: Array<{ prompt: string }> = overrides.generateCalls ?? [];
  let visionCalls = 0;
  const store = overrides.store ?? new MemoryIllustrationStore();
  return {
    generateCalls,
    get visionCalls() { return visionCalls; },
    enabled: true,
    model: 'gpt-image-1.5',
    store,
    generate: overrides.generate ?? {
      generate: async ({ prompt }) => {
        generateCalls.push({ prompt });
        return generated();
      },
    },
    vision: overrides.vision ?? {
      inspect: async () => {
        visionCalls += 1;
        return approval;
      },
    },
    ...overrides,
  };
}

describe('illustration cache key', () => {
  it('normalizes purpose, subject, and style so equivalent briefs share a key', () => {
    const a = illustrationCacheKey(brief({ purpose: 'Show a Pond Habitat', subject: 'A calm pond' }));
    const b = illustrationCacheKey(brief({ purpose: 'show a pond habitat', subject: 'a  calm   pond' }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('prepareIllustration', () => {
  it('generates, vision-checks, stores a server-issued assetId, and never embeds a data-URL in the spec', async () => {
    const prepared = deps();
    const result = await prepareIllustration(prepared, brief());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cacheHit).toBe(false);
    expect(result.imageCount).toBe(1);
    expect(result.totalTokens).toBe(42);
    expect(result.spec.kind).toBe('image');
    expect(result.spec.assetId).toMatch(/^img-[a-f0-9]{16}$/);
    expect(result.spec.alt).toMatch(/pond/i);
    expect(result.spec.assetId.startsWith('data:')).toBe(false);
    expect(prepared.generateCalls).toHaveLength(1);
    expect(prepared.generateCalls[0].prompt).toMatch(/Do not draw any letters/);
    expect(result.record.bytes).toEqual(PNG);
    const stored = await prepared.store.getById(result.spec.assetId);
    expect(stored).toBeNull();
  });

  it('returns a cache hit and skips generation on a normalized brief', async () => {
    const store = new MemoryIllustrationStore();
    const first = await prepareIllustration(deps({ store }), brief());
    expect(first.ok).toBe(true);
    if (first.ok) await persistIllustrationRecord(store, first);
    const secondDeps = deps({ store });
    const second = await prepareIllustration(secondDeps, brief({
      purpose: 'SHOW A POND HABITAT so the child can name living things',
    }));
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.cacheHit).toBe(true);
    expect(second.imageCount).toBe(0);
    expect(second.spec.assetId).toBe(first.spec.assetId);
    expect(secondDeps.visionCalls).toBeGreaterThan(0);
  });

  it('does not return a cache hit as accepted when stored bytes fail vision', async () => {
    const store = new MemoryIllustrationStore();
    const first = await prepareIllustration(deps({ store }), brief());
    expect(first.ok).toBe(true);
    if (first.ok) await persistIllustrationRecord(store, first);
    const result = await prepareIllustration(deps({
      store,
      vision: {
        inspect: async () => JSON.stringify({
          approved: false,
          issues: ['unsafe photoreal child'],
          hasEmbeddedText: false,
          unsafe: true,
          missingRequired: [],
        }),
      },
    }), brief());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.cacheHit).toBe(true);
    expect(result.reasons.some((reason) => /unsafe|safety|child/i.test(reason))).toBe(true);
  });

  it('retries after a vision rejection and fails closed after two retries', async () => {
    let visions = 0;
    const generateCalls: Array<{ prompt: string }> = [];
    const result = await prepareIllustration(deps({
      generateCalls,
      vision: {
        inspect: async () => {
          visions += 1;
          return JSON.stringify({
            approved: false,
            issues: ['digits painted on the lily pad'],
            hasEmbeddedText: true,
            unsafe: false,
            missingRequired: [],
          });
        },
      },
    }), brief());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refused).toBe(false);
    expect(generateCalls).toHaveLength(3);
    expect(visions).toBe(3);
    expect(result.reasons.some((reason) => /text|numbers|equations|digits/i.test(reason))).toBe(true);
  });

  it('accepts the second generation after the first vision check fails', async () => {
    let visions = 0;
    const result = await prepareIllustration(deps({
      vision: {
        inspect: async () => {
          visions += 1;
          return visions === 1
            ? JSON.stringify({ approved: false, issues: ['missing frog'], hasEmbeddedText: false, unsafe: false, missingRequired: ['frog'] })
            : approval;
        },
      },
    }), brief());
    expect(result.ok).toBe(true);
    expect(visions).toBe(2);
  });

  it('refuses an unsafe subject before any generate call', async () => {
    const generateCalls: Array<{ prompt: string }> = [];
    const result = await prepareIllustration(deps({ generateCalls }), brief({
      subject: 'A photorealistic child holding a gun',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refused).toBe(true);
    expect(generateCalls).toHaveLength(0);
    expect(result.reasons[0]).toMatch(/not safe/i);
  });

  it('does nothing when the feature flag is off', async () => {
    const generateCalls: Array<{ prompt: string }> = [];
    const result = await prepareIllustration(deps({ enabled: false, generateCalls }), brief());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refused).toBe(true);
    expect(generateCalls).toHaveLength(0);
  });

  it('notifies preparing and partial hooks without persisting partial bytes', async () => {
    const store = new MemoryIllustrationStore();
    const preparing: string[] = [];
    const partials: string[] = [];
    const result = await prepareIllustration(deps({
      store,
      generate: {
        generate: async ({ onPartial }) => {
          onPartial?.('data:image/png;base64,partial', 0);
          return generated();
        },
      },
    }), brief(), {
      onPreparing: (alt) => preparing.push(alt),
      onPartial: (dataUrl) => partials.push(dataUrl),
    });
    expect(preparing.length).toBe(1);
    expect(partials).toEqual(['data:image/png;base64,partial']);
    expect(await store.getByCacheKey(illustrationCacheKey(brief()))).toBeNull();
    if (result.ok) await persistIllustrationRecord(store, result);
    const cached = await store.getByCacheKey(illustrationCacheKey(brief()));
    expect(cached?.bytes).toEqual(PNG);
    expect(Buffer.from(cached?.bytes ?? []).toString('base64')).not.toBe('partial');
  });
});
