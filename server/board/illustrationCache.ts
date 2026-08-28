import { createHash } from 'node:crypto';
import type { IllustrationBrief } from './illustrationTypes.js';

export function illustrationCacheKey(brief: IllustrationBrief): string {
  const required = [...brief.requiredElements].map(normalizeToken).sort().join(',');
  const forbidden = [...brief.forbiddenElements].map(normalizeToken).sort().join(',');
  const material = [
    normalizeToken(brief.purpose),
    normalizeToken(brief.subject),
    normalizeToken(brief.style ?? 'educational'),
    required,
    forbidden,
  ].join('|');
  return createHash('sha256').update(material).digest('hex');
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
