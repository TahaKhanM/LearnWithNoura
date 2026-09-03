import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BOARD_H, BOARD_W } from '../../shared/boardOps.js';
import type { ImageSpec } from '../../shared/authoredSpecs.js';
import { illustrationCacheKey } from './illustrationCache.js';
import { buildIllustrationPrompt, ILLUSTRATION_VISION_PROMPT } from './illustrationPrompts.js';
import { closedIllustrationVisionIssues, illustrationVisionReason } from './illustrationArrival.js';
import { refuseUnsafeIllustrationBrief } from './illustrationSafety.js';
import type {
  IllustrationBrief,
  IllustrationGenerateClient,
  IllustrationRecord,
  IllustrationStore,
  IllustrationVisionClient,
} from './illustrationTypes.js';

export type { IllustrationBrief, IllustrationRecord, IllustrationStore } from './illustrationTypes.js';

const VisionVerdictSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string().min(1).max(300)).max(8).default([]),
  hasEmbeddedText: z.boolean().default(false),
  unsafe: z.boolean().default(false),
  missingRequired: z.array(z.string().min(1).max(80)).max(8).default([]),
});

export interface IllustrationPrepareOk {
  ok: true;
  spec: ImageSpec;
  objectId: string;
  record: IllustrationRecord;
  cacheHit: boolean;
  latencyMs: number;
  imageCount: number;
  totalTokens: number;
}

export interface IllustrationPrepareFail {
  ok: false;
  reasons: string[];
  cacheHit: boolean;
  latencyMs: number;
  imageCount: number;
  totalTokens: number;
  refused: boolean;
}

export type IllustrationPrepareResult = IllustrationPrepareOk | IllustrationPrepareFail;

export interface IllustrationHooks {
  onPreparing?: (alt: string) => void;
  onPartial?: (dataUrl: string, alt: string) => void;
}

export interface PrepareIllustrationDeps {
  generate: IllustrationGenerateClient;
  vision: IllustrationVisionClient;
  store: IllustrationStore;
  model: string;
  enabled: boolean;
  now?: () => number;
  maxRetries?: number;
  /** Remaining paid generations in this lesson. Cache hits are free. */
  generationBudgetRemaining: number;
}

const DEFAULT_AT: [number, number] = [80, 60];
const DEFAULT_W = 840;
const DEFAULT_H = 420;

export function issueIllustrationAssetId(): string {
  return `img-${randomBytes(8).toString('hex')}`;
}

export async function prepareIllustration(
  deps: PrepareIllustrationDeps,
  brief: IllustrationBrief,
  hooks: IllustrationHooks = {},
): Promise<IllustrationPrepareResult> {
  const started = (deps.now ?? Date.now)();
  const elapsed = () => Math.max(0, (deps.now ?? Date.now)() - started);
  const alt = (brief.alt?.trim() || `Educational illustration of ${brief.subject}`).slice(0, 200);

  if (!deps.enabled) {
    return fail(['Illustrations are turned off.'], { refused: true, latencyMs: elapsed() });
  }

  const unsafe = refuseUnsafeIllustrationBrief(brief);
  if (unsafe) {
    return fail([unsafe], { refused: true, latencyMs: elapsed() });
  }

  hooks.onPreparing?.(alt);
  const cacheKey = illustrationCacheKey(brief);
  const cached = await deps.store.getByCacheKey(cacheKey);
  if (cached) {
    const cachedVision = await inspectCachedRecord(deps, brief, cached);
    if (cachedVision.ok === false) {
      return fail(cachedVision.reasons, { cacheHit: true, latencyMs: elapsed() });
    }
    return ok(cached, brief, alt, { cacheHit: true, latencyMs: elapsed(), imageCount: 0, totalTokens: 0 });
  }

  const remaining = deps.generationBudgetRemaining ?? 0;
  if (!(remaining > 0)) {
    return fail(['illustration_budget:exhausted'], { refused: false, latencyMs: elapsed() });
  }

  const attempts = Math.min(
    1 + Math.max(0, deps.maxRetries ?? 2),
    Math.max(1, Math.floor(remaining)),
  );
  const prompt = buildIllustrationPrompt(brief);
  let lastReasons = ['The illustration could not be prepared.'];
  let imageCount = 0;
  let totalTokens = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const generated = await deps.generate.generate({
      prompt,
      model: deps.model,
      onPartial: (dataUrl) => hooks.onPartial?.(dataUrl, alt),
    });
    if (!generated) {
      lastReasons = ['The illustration model returned no image.'];
      continue;
    }
    imageCount += 1;
    totalTokens += generated.usage.totalTokens;
    const dataUrl = toDataUrl(generated.bytes, generated.mime);
    const visionReply = await deps.vision.inspect({
      prompt: visionUserText(brief),
      imageDataUrl: dataUrl,
    });
    const verdict = parseVision(visionReply);
    if (verdict.ok === false) {
      lastReasons = verdict.reasons;
      continue;
    }
    const record: IllustrationRecord = {
      id: issueIllustrationAssetId(),
      cacheKey,
      mime: generated.mime,
      bytes: generated.bytes,
      createdAt: (deps.now ?? Date.now)(),
    };
    return ok(record, brief, alt, { cacheHit: false, latencyMs: elapsed(), imageCount, totalTokens });
  }

  return fail(lastReasons, { latencyMs: elapsed(), imageCount, totalTokens });
}

function ok(
  record: IllustrationRecord,
  brief: IllustrationBrief,
  alt: string,
  stats: { cacheHit: boolean; latencyMs: number; imageCount: number; totalTokens: number },
): IllustrationPrepareOk {
  const at = brief.at ?? DEFAULT_AT;
  return {
    ok: true,
    spec: {
      kind: 'image',
      assetId: record.id,
      at: [
        Math.min(BOARD_W - 80, Math.max(0, at[0])),
        Math.min(BOARD_H - 40, Math.max(0, at[1])),
      ],
      w: clampSize(brief.w ?? DEFAULT_W, 80, BOARD_W),
      h: clampSize(brief.h ?? DEFAULT_H, 40, BOARD_H),
      alt,
    },
    objectId: `illust-${record.id.slice(4, 12)}`,
    record,
    ...stats,
  };
}

export async function persistIllustrationRecord(
  store: IllustrationStore,
  result: IllustrationPrepareOk,
  owner?: { parentId?: string; sessionId?: string },
): Promise<void> {
  await store.put({
    ...result.record,
    ...(owner?.parentId ? { parentId: owner.parentId } : {}),
    ...(owner?.sessionId ? { sessionId: owner.sessionId } : {}),
  });
}

function fail(
  reasons: string[],
  extras: Partial<IllustrationPrepareFail> & { latencyMs: number },
): IllustrationPrepareFail {
  return {
    ok: false,
    reasons,
    cacheHit: extras.cacheHit ?? false,
    latencyMs: extras.latencyMs,
    imageCount: extras.imageCount ?? 0,
    totalTokens: extras.totalTokens ?? 0,
    refused: extras.refused ?? false,
  };
}

async function inspectCachedRecord(
  deps: PrepareIllustrationDeps,
  brief: IllustrationBrief,
  record: IllustrationRecord,
): Promise<{ ok: true } | { ok: false; reasons: string[] }> {
  if (!record.bytes?.length) {
    return { ok: false, reasons: ['The cached illustration has no stored bytes to inspect.'] };
  }
  const visionReply = await deps.vision.inspect({
    prompt: visionUserText(brief),
    imageDataUrl: toDataUrl(record.bytes, record.mime),
  });
  return parseVision(visionReply);
}

function visionUserText(brief: IllustrationBrief): string {
  return [
    ILLUSTRATION_VISION_PROMPT,
    `Subject: ${brief.subject}`,
    `Purpose: ${brief.purpose}`,
    brief.requiredElements.length > 0 ? `Required elements: ${brief.requiredElements.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function parseVision(reply: string | null): { ok: true } | { ok: false; reasons: string[] } {
  try {
    const verdict = VisionVerdictSchema.parse(JSON.parse(reply ?? ''));
    const issues = closedIllustrationVisionIssues({
      kind: 'verdict',
      approved: verdict.approved,
      hasEmbeddedText: verdict.hasEmbeddedText,
      unsafe: verdict.unsafe,
      missingRequired: verdict.missingRequired.length > 0,
    });
    return issues.length === 0
      ? { ok: true }
      : { ok: false, reasons: issues.map(illustrationVisionReason) };
  } catch {
    return { ok: false, reasons: closedIllustrationVisionIssues({ kind: 'invalid' }).map(illustrationVisionReason) };
  }
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function clampSize(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
