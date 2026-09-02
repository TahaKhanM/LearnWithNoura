import type { BoardOp } from '../../../shared/boardOps.js';
import { materializeSketchCorpus, type SyntheticSketch } from './corpus.js';
import {
  SKETCH_INTERPRETATIONS,
  type SketchInterpretation,
} from './types.js';

/** Matches the live learner pen preview and the path-spec compile default. */
export const SYNTHETIC_SKETCH_STROKE_WIDTH = 4;

export const sketchInterpretationJsonSchema = {
  type: 'string',
  enum: [...SKETCH_INTERPRETATIONS],
} as const;

export const SKETCH_REPLY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    interpretation: sketchInterpretationJsonSchema,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['interpretation', 'confidence'],
} as const;

export function isSketchInterpretation(value: unknown): value is SketchInterpretation {
  return typeof value === 'string' && (SKETCH_INTERPRETATIONS as readonly string[]).includes(value);
}

export function parseSketchReply(text: string): {
  interpretation: SketchInterpretation | '';
  confidence: number;
  valid: boolean;
} {
  try {
    const parsed = JSON.parse(text) as { interpretation?: unknown; confidence?: unknown };
    if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)) {
      throw new Error('invalid');
    }
    if (!isSketchInterpretation(parsed.interpretation)) {
      return { interpretation: '', confidence: 0, valid: false };
    }
    return {
      interpretation: parsed.interpretation,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      valid: true,
    };
  } catch {
    return { interpretation: '', confidence: 0, valid: false };
  }
}

export function syntheticSketchOps(sketch: SyntheticSketch): BoardOp[] {
  return [{
    op: 'add',
    id: `synthetic-sketch-${sketch.id}`,
    color: 'ink',
    spec: { kind: 'path', points: sketch.points, width: SYNTHETIC_SKETCH_STROKE_WIDTH },
  }];
}

export function renderSyntheticSketchSvg(sketch: SyntheticSketch): string {
  return wrapSketchTile(sketch.id, sketch.expectedInterpretation, sketch.points, 0);
}

export function sketchCorpusContactSheetSvg(): string {
  const bases = materializeSketchCorpus().filter((entry) => entry.jitterSeed === 1);
  const height = bases.length * 600;
  const tiles = bases.map((sketch, index) =>
    wrapSketchTile(sketch.id, sketch.expectedInterpretation, sketch.points, index * 600, false));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}">` +
    `<rect x="0" y="0" width="1000" height="${height}" fill="#fcfbf7"/>\n${tiles.join('\n')}\n</svg>\n`;
}

export function interpretSketchOffline(points: Array<[number, number]>): {
  interpretation: SketchInterpretation;
  confidence: number;
  semanticClaim: false;
} {
  const scores = scoreLabels(points);
  const ranked = SKETCH_INTERPRETATIONS
    .map((label) => ({ label, score: scores[label] }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const second = ranked[1];
  const gap = (best.score - second.score) / Math.max(best.score, 0.01);
  return {
    interpretation: best.label,
    confidence: Math.max(0.05, Math.min(0.99, gap)),
    semanticClaim: false,
  };
}

export function scoreSketchCorpusOffline() {
  const sketches = materializeSketchCorpus();
  const rows = sketches.map((sketch) => {
    const reading = interpretSketchOffline(sketch.points);
    return {
      id: sketch.id,
      expected: sketch.expectedInterpretation,
      predicted: reading.interpretation,
      confidence: reading.confidence,
      correct: reading.interpretation === sketch.expectedInterpretation,
    };
  });
  return {
    providerCalls: 0,
    itemCount: sketches.length,
    accuracy: rows.filter((row) => row.correct).length / rows.length,
    cheaperModelAssistDefault: 'off' as const,
    decisionReason: 'Offline geometric features are spatial hints, not a check-grading assist.',
    rows,
  };
}

type Vec = [number, number];

function wrapSketchTile(
  id: string,
  interpretation: SketchInterpretation,
  points: Array<[number, number]>,
  offsetY: number,
  includeRoot = true,
): string {
  const d = polylineSvgPath(points);
  const tile =
    `<g data-sketch-id="${escapeXml(id)}" data-interpretation="${escapeXml(interpretation)}" transform="translate(0 ${offsetY})">` +
    `<rect x="0" y="0" width="1000" height="600" fill="#fcfbf7"/>` +
    `<text x="24" y="36" font-size="18" fill="#26231F">${escapeXml(interpretation)} (${escapeXml(id)})</text>` +
    `<path d="${d}" stroke="#26231F" stroke-width="${SYNTHETIC_SKETCH_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
    `</g>`;
  if (!includeRoot) return tile;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600" viewBox="0 0 1000 600">${tile}</svg>`;
}

function polylineSvgPath(points: Array<[number, number]>): string {
  const [first, ...rest] = points;
  return `M ${first[0].toFixed(1)} ${first[1].toFixed(1)} ${rest
    .map((point) => `L ${point[0].toFixed(1)} ${point[1].toFixed(1)}`)
    .join(' ')}`;
}

function scoreLabels(points: Vec[]): Record<SketchInterpretation, number> {
  const f = features(points);
  return {
    'straight line': f.linearity * (1 - f.closedness) * aspectWide(f) * (f.meanY < 360 ? 1 : 0.12) *
      fewPoints(f, 6) * noCross(f),
    underline: f.linearity * (1 - f.closedness) * (f.meanY > 380 ? 1 : 0.08) * fewPoints(f, 6) * noCross(f),
    circle: f.circularity * f.closedness * (f.n >= 7 ? 1 : 0.15),
    triangle: f.closedness * (f.n === 4 ? 1 : 0.12) * (1 - f.circularity) *
      (f.sharpTurns >= 2 ? 1 : 0.35) * (f.aspect < 2.6 ? 1 : 0.25),
    'right arrow': (f.maxXInterior ? 1 : 0.08) * (1 - f.closedness) * (f.ySpan / Math.max(f.xSpan, 1) > 0.12 ? 1 : 0.25) *
      (f.n >= 4 && f.n <= 6 ? 1 : 0.15) * (f.centerVisit ? 0.08 : 1) * (f.crossings === 0 ? 1 : 0.35),
    'cross mark': (f.crossings >= 1 ? 1 : 0.04) * (f.centerVisit ? 1 : 0.08) * (1 - f.closedness) * (f.n >= 4 ? 1 : 0.15),
    'check mark': (f.lowestInterior ? 1 : 0.05) * (f.n <= 4 ? 1 : 0.08) * (1 - f.closedness) *
      noCross(f) * (f.ySpan / Math.max(f.xSpan, 1) > 0.4 ? 1 : 0.2),
    box: f.closedness * (f.n >= 5 && f.n <= 6 ? 1 : 0.12) * (f.sharpTurns >= 3 ? 1 : 0.25) *
      (1 - f.circularity) * (f.aspect > 1.15 && f.aspect < 3.2 ? 1 : 0.3),
    'increasing curve': (1 - f.closedness) * f.yDecreasesWithX * (1 - f.linearity * 0.45) *
      (f.n >= 6 ? 1 : 0.3) * noCross(f) * (f.maxXInterior ? 0.2 : 1),
    'fraction partition': (f.n >= 10 ? 1 : 0.04) * (f.sharpTurns >= 6 ? 1 : 0.15) * (f.verticalRuns >= 3 ? 1 : 0.25),
  };
}

function fewPoints(f: SketchFeatures, max: number): number {
  return f.n <= max ? 1 : 0.15;
}

function noCross(f: SketchFeatures): number {
  return f.crossings === 0 ? 1 : 0.08;
}

function aspectWide(f: SketchFeatures): number {
  return f.aspect > 2 ? 1 : 0.3;
}

interface SketchFeatures {
  n: number;
  meanY: number;
  closedness: number;
  linearity: number;
  circularity: number;
  aspect: number;
  xSpan: number;
  ySpan: number;
  sharpTurns: number;
  crossings: number;
  maxXInterior: boolean;
  lowestInterior: boolean;
  centerVisit: boolean;
  yDecreasesWithX: number;
  verticalRuns: number;
}

function features(points: Vec[]): SketchFeatures {
  const n = points.length;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const xSpan = Math.max(1, maxX - minX);
  const ySpan = Math.max(1, maxY - minY);
  const diag = Math.hypot(xSpan, ySpan);
  const first = points[0];
  const last = points[n - 1];
  const closedness = 1 - Math.min(1, dist(first, last) / diag);
  const meanX = mean(xs);
  const meanY = mean(ys);
  const cov = covariance(points, meanX, meanY);
  const theta = 0.5 * Math.atan2(2 * cov.sxy, cov.sxx - cov.syy);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const lineRms = Math.sqrt(mean(points.map((point) => {
    const dx = point[0] - meanX;
    const dy = point[1] - meanY;
    const proj = dx * ux + dy * uy;
    return (dx - proj * ux) ** 2 + (dy - proj * uy) ** 2;
  })));
  const radius = mean(points.map((point) => dist(point, [meanX, meanY])));
  const circleRms = Math.sqrt(mean(points.map((point) => (dist(point, [meanX, meanY]) - radius) ** 2)));
  const maxXIndex = xs.findIndex((value) => value === maxX);
  const maxYIndex = ys.findIndex((value) => value === maxY);
  return {
    n,
    meanY,
    closedness,
    linearity: 1 - Math.min(1, lineRms / (diag * 0.22)),
    circularity: 1 - Math.min(1, circleRms / Math.max(radius, 1)),
    aspect: xSpan / ySpan,
    xSpan,
    ySpan,
    sharpTurns: countSharpTurns(points),
    crossings: countCrossings(points),
    maxXInterior: maxXIndex > 0 && maxXIndex < n - 1,
    lowestInterior: maxYIndex > 0 && maxYIndex < n - 1,
    centerVisit: points.some((point) => dist(point, [minX + xSpan / 2, minY + ySpan / 2]) < diag * 0.16),
    yDecreasesWithX: trendYDecreasesWithX(points),
    verticalRuns: countVerticalRuns(points),
  };
}

function countSharpTurns(points: Vec[]): number {
  let turns = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const incoming = heading(points[index - 1], points[index]);
    const outgoing = heading(points[index], points[index + 1]);
    if (Math.abs(angleDelta(incoming, outgoing)) > 0.7) turns += 1;
  }
  return turns;
}

function countCrossings(points: Vec[]): number {
  const closed = dist(points[0], points[points.length - 1]) < 12;
  let crossings = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let j = i + 2; j < points.length - 1; j += 1) {
      if (closed && i === 0 && j === points.length - 2) continue;
      if (segmentsIntersect(points[i], points[i + 1], points[j], points[j + 1])) crossings += 1;
    }
  }
  return crossings;
}

function countVerticalRuns(points: Vec[]): number {
  let runs = 0;
  let inRun = false;
  for (let index = 1; index < points.length; index += 1) {
    const vertical = Math.abs(points[index][0] - points[index - 1][0]) < 8 &&
      Math.abs(points[index][1] - points[index - 1][1]) > 40;
    if (vertical && !inRun) {
      runs += 1;
      inRun = true;
    } else if (!vertical) {
      inRun = false;
    }
  }
  return runs;
}

function trendYDecreasesWithX(points: Vec[]): number {
  let steps = 0;
  let falling = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index][0] <= points[index - 1][0]) continue;
    steps += 1;
    if (points[index][1] < points[index - 1][1]) falling += 1;
  }
  return steps === 0 ? 0 : falling / steps;
}

function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(den) < 1e-9) return false;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}

function heading(a: Vec, b: Vec): number {
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

function angleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return delta;
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function covariance(points: Vec[], meanX: number, meanY: number): { sxx: number; syy: number; sxy: number } {
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    const dx = x - meanX;
    const dy = y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return { sxx, syy, sxy };
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) =>
    char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '&' ? '&amp;' : char === "'" ? '&apos;' : '&quot;');
}
