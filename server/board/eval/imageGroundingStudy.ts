import { z } from 'zod';
import { validateAnchorRef, type ImageRegionSelector } from '../../../shared/boardOps.js';

const SelectorSchema = z.union([
  z.object({ type: z.literal('FragmentSelector'), unit: z.literal('percent'), x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict(),
  z.object({ type: z.literal('PointSelector'), x: z.number(), y: z.number() }).strict(),
  z.object({ type: z.literal('SvgSelector'), points: z.array(z.tuple([z.number(), z.number()])).min(3) }).strict(),
]);
const FixtureSchema = z.object({
  schemaVersion: z.literal('1.0.0'), syntheticOnly: z.literal(true),
  confidenceThreshold: z.number().min(0).max(1), pointingThreshold: z.number().min(0).max(1),
  canaryItemIds: z.array(z.string()).length(2), defectItemIds: z.array(z.string()).length(5),
  items: z.array(z.object({
    id: z.string(), hint: z.string(), svg: z.string(), expected: SelectorSchema, defect: SelectorSchema,
  }).strict()).length(6),
}).strict();

export interface GroundingStudyObservations {
  proposals: Array<{ itemId: string; selector: ImageRegionSelector; confidence: number }>;
  correctSelfChecks: Array<{ itemId: string; outcome: 'approved' | 'rejected' | 'invalid' }>;
  defectSelfChecks: Array<{ itemId: string; outcome: 'approved' | 'rejected' | 'invalid' }>;
  malformedReplies: number;
}

export function planImageGroundingStudy(
  fixtureRawJson: string,
  budget: { reservePerCallUsd: number; capUsd: number },
) {
  const fixture = parseFixture(fixtureRawJson);
  const canaryCalls = fixture.canaryItemIds.length * 2 + 1;
  const fullCalls = fixture.items.length * 2 + fixture.defectItemIds.length;
  const canaryCost = round(canaryCalls * budget.reservePerCallUsd, 6);
  const fullCost = round(fullCalls * budget.reservePerCallUsd, 6);
  return {
    syntheticItems: fixture.items.length,
    canary: {
      proposals: fixture.canaryItemIds.length,
      correctSelfChecks: fixture.canaryItemIds.length,
      seededDefectChecks: 1,
      maximumCalls: canaryCalls,
      conservativeCostUsd: canaryCost,
    },
    full: {
      proposals: fixture.items.length,
      correctSelfChecks: fixture.items.length,
      seededDefectChecks: fixture.defectItemIds.length,
      maximumCalls: fullCalls,
      conservativeCostUsd: fullCost,
    },
    capUsd: budget.capUsd,
    fits: fullCost <= budget.capUsd,
  };
}

export function evaluateImageGroundingStudy(fixtureRawJson: string, observations: GroundingStudyObservations) {
  const fixture = parseFixture(fixtureRawJson);
  const byId = new Map(fixture.items.map((item) => [item.id, item]));
  const proposals = observations.proposals.filter((row) => byId.has(row.itemId));
  const accurate = new Set(proposals.filter((row) => {
    const expected = byId.get(row.itemId)?.expected;
    return expected ? selectorAccuracy(row.selector, expected, fixture.pointingThreshold) : false;
  }).map((row) => row.itemId));
  const correctAudits = observations.correctSelfChecks.filter((row) => accurate.has(row.itemId));
  const falseRejects = correctAudits.filter((row) => row.outcome !== 'approved').length;
  const defectAudits = observations.defectSelfChecks.filter((row) => fixture.defectItemIds.includes(row.itemId));
  const catches = defectAudits.filter((row) => row.outcome === 'rejected').length;
  const auditById = new Map(observations.correctSelfChecks.map((row) => [row.itemId, row.outcome]));
  const tapFallbacks = proposals.filter((row) =>
    row.confidence < fixture.confidenceThreshold || auditById.get(row.itemId) !== 'approved').length;
  const metrics = {
    pointingAccuracy: ratio(accurate.size, fixture.items.length),
    correctSelfCheckFalseRejectRate: ratio(falseRejects, correctAudits.length),
    seededDefectCatchRate: ratio(catches, defectAudits.length),
    tapFallbackRate: ratio(tapFallbacks, fixture.items.length),
    malformedReplyRate: ratio(observations.malformedReplies, fixture.items.length + observations.malformedReplies),
  };
  const gates = {
    pointingAccuracy: metrics.pointingAccuracy >= 0.8,
    correctSelfCheckFalseRejectRate: metrics.correctSelfCheckFalseRejectRate <= 0.2,
    seededDefectCatchRate: metrics.seededDefectCatchRate >= 0.8,
    malformedReplyRate: metrics.malformedReplyRate <= 0.05,
  };
  return {
    schemaVersion: '1.0.0' as const,
    evidenceMode: 'authorized_synthetic_image_grounding_microstudy' as const,
    syntheticItems: fixture.items.length,
    metrics,
    gates,
    accepted: Object.values(gates).every(Boolean),
  };
}

export function parseImageGroundingStudyFixture(rawJson: string) {
  return parseFixture(rawJson);
}

function parseFixture(rawJson: string) {
  const fixture = FixtureSchema.parse(JSON.parse(rawJson));
  const ids = new Set(fixture.items.map((item) => item.id));
  if (ids.size !== fixture.items.length || fixture.canaryItemIds.some((id) => !ids.has(id)) || fixture.defectItemIds.some((id) => !ids.has(id))) {
    throw new Error('Image grounding fixture ids are inconsistent.');
  }
  for (const item of fixture.items) for (const selector of [item.expected, item.defect]) {
    if (!validateAnchorRef({ type: 'image_region', imageId: 'fixture-image', selector })) throw new Error(`Invalid selector in ${item.id}.`);
  }
  return fixture;
}

function selectorAccuracy(proposed: ImageRegionSelector, expected: ImageRegionSelector, threshold: number): boolean {
  const expectedBox = selectorBox(expected);
  if (proposed.type === 'PointSelector') return pointInside([proposed.x, proposed.y], expectedBox);
  const proposedBox = selectorBox(proposed);
  const proposedCenter: [number, number] = [proposedBox.x + proposedBox.w / 2, proposedBox.y + proposedBox.h / 2];
  if (pointInside(proposedCenter, expectedBox) && proposedBox.w <= expectedBox.w * 1.5 && proposedBox.h <= expectedBox.h * 1.5) return true;
  const intersectionWidth = Math.max(0, Math.min(proposedBox.x + proposedBox.w, expectedBox.x + expectedBox.w) - Math.max(proposedBox.x, expectedBox.x));
  const intersectionHeight = Math.max(0, Math.min(proposedBox.y + proposedBox.h, expectedBox.y + expectedBox.h) - Math.max(proposedBox.y, expectedBox.y));
  const intersection = intersectionWidth * intersectionHeight;
  const union = proposedBox.w * proposedBox.h + expectedBox.w * expectedBox.h - intersection;
  return union > 0 && intersection / union >= threshold;
}

function selectorBox(selector: ImageRegionSelector): { x: number; y: number; w: number; h: number } {
  if (selector.type === 'FragmentSelector') return selector;
  if (selector.type === 'PointSelector') return { x: selector.x, y: selector.y, w: 0, h: 0 };
  const xs = selector.points.map((point) => point[0]);
  const ys = selector.points.map((point) => point[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
function pointInside([x, y]: [number, number], box: { x: number; y: number; w: number; h: number }): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}
function ratio(numerator: number, denominator: number): number { return denominator > 0 ? numerator / denominator : 0; }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
