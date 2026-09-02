import { AnchorSceneSchema, type AnchorScene } from '../../shared/compiledLesson.js';
import { adaptSemanticScene, VISUAL_PLAN_VERSION, type SemanticScenePlan } from '../../shared/semanticScene.js';

export interface IntentTemplateRequest {
  idea: string;
  constraints: string | null;
  sectionId: string;
}

type TemplateName = Exclude<AnchorScene['template'], null | undefined>;
interface TemplateMatch {
  template: TemplateName;
  groupLabel: string;
  domain: SemanticScenePlan['intent']['domain'];
  parameters: Record<string, unknown>;
  narration: string;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const NUMBER_TOKEN = '-?\\d+(?:\\.\\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty';

export function extractIntentTemplateScene(request: IntentTemplateRequest): AnchorScene | null {
  const text = `${request.idea} ${request.constraints ?? ''}`.replace(/\s+/g, ' ').trim();
  const match = extractNumberLine(text)
    ?? extractFractions(text)
    ?? extractUnitCircle(text)
    ?? extractSlopeComparison(text)
    ?? extractPythagorean(text)
    ?? extractTriangleAngleSum(text)
    ?? extractGrammarClauses(text)
    ?? extractCausalCycle(text)
    ?? extractTimeline(text);
  return match ? buildScene(request, match) : null;
}

function extractNumberLine(text: string): TemplateMatch | null {
  if (!/\bnumber\s*line\b/i.test(text)) return null;
  const range = new RegExp(`\\bfrom\\s+(${NUMBER_TOKEN})\\s+(?:to|through)\\s+(${NUMBER_TOKEN})`, 'i').exec(text);
  if (!range) return null;
  const min = numericToken(range[1]);
  const max = numericToken(range[2]);
  if (min === null || max === null || max <= min) return null;
  const directMark = new RegExp(`\\bmark(?:ed|ing)?\\s+(?:the\\s+(?:number|point)\\s+)?(${NUMBER_TOKEN})`, 'i').exec(text);
  const describedMark = new RegExp(`\\bwith\\s+(${NUMBER_TOKEN})\\s+mark(?:ed)?\\b`, 'i').exec(text);
  const mark = numericToken((directMark ?? describedMark)?.[1]);
  if (mark !== null && (mark < min || mark > max)) return null;
  const span = max - min;
  const step = Number.isInteger(min) && Number.isInteger(max) && span <= 20 ? 1 : Number((span / 10).toPrecision(4));
  const groupLabel = `Number line ${displayNumber(min)} to ${displayNumber(max)}`;
  return {
    template: 'number_line',
    groupLabel,
    domain: 'quantitative',
    parameters: { min, max, step, marks: mark === null ? [] : [{ value: mark, label: displayNumber(mark), color: 'red' }] },
    narration: mark === null
      ? `This number line runs from ${displayNumber(min)} to ${displayNumber(max)}.`
      : `This number line runs from ${displayNumber(min)} to ${displayNumber(max)}, with ${displayNumber(mark)} marked.`,
  };
}

function extractFractions(text: string): TemplateMatch | null {
  if (!/\b(?:compare|fraction|strip|same scale)\b/i.test(text)) return null;
  const matches = [...text.matchAll(/(-?\d+)\s*\/\s*(\d+)/g)];
  if (matches.length < 2 || matches.length > 4) return null;
  const fractions = matches.map((match) => ({ numerator: Number(match[1]), denominator: Number(match[2]) }));
  if (fractions.some(({ numerator, denominator }) => denominator < 1 || denominator > 24 || numerator < 0 || numerator > denominator)) return null;
  const wantsStrips = /\bstrips?\b/i.test(text);
  if (wantsStrips && fractions.some(({ denominator }) => denominator > 12)) return null;
  const labels = fractions.map(({ numerator, denominator }) => `${numerator}/${denominator}`);
  return {
    template: 'fraction_comparison',
    groupLabel: `Compare ${labels.join(' and ')}`,
    domain: 'quantitative',
    parameters: {
      values: fractions.map(({ numerator, denominator }) => numerator / denominator),
      labels,
      ...(/\bstrips?\b/i.test(text) ? { representation: 'strips', fractions } : {}),
    },
    narration: `Both fractions share one exact scale, so ${labels.join(' and ')} can be compared directly.`,
  };
}

function extractUnitCircle(text: string): TemplateMatch | null {
  if (!/\bunit[- ]circle\b/i.test(text)) return null;
  const angle = /(-?\d+(?:\.\d+)?)\s*(?:°|degrees?\b)/i.exec(text);
  if (!angle) return null;
  const angleDegrees = Number(angle[1]);
  if (!Number.isFinite(angleDegrees) || Math.abs(angleDegrees) > 360) return null;
  return {
    template: 'unit_circle_projection',
    groupLabel: `Unit circle at ${displayNumber(angleDegrees)}°`,
    domain: 'geometry',
    parameters: { angleDegrees },
    narration: `The radius marks ${displayNumber(angleDegrees)} degrees and projects to the exact coordinate axes.`,
  };
}

function extractSlopeComparison(text: string): TemplateMatch | null {
  const lines = linearEquations(text);
  if (lines.length > 0) {
    return {
      template: 'slope_comparison',
      groupLabel: lines.length === 1 ? 'Linear graph' : 'Compare linear graphs',
      domain: 'algebra',
      parameters: { lines, markIntersection: /\bintersection\b/i.test(text) },
      narration: lines.length === 1 ? `The exact line ${lines[0].label} is plotted on shared axes.` : 'The exact lines share one set of axes so their intersection and slopes are visible.',
    };
  }
  if (!/\bslopes?\b/i.test(text)) return null;
  const suffix = /\bslopes?\s+(?:of\s+)?([^.;]+)/i.exec(text)?.[1];
  const slopes = suffix?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (slopes.length < 2 || slopes.length > 3 || slopes.some((value) => !Number.isFinite(value))) return null;
  return {
    template: 'slope_comparison',
    groupLabel: `Compare slopes ${slopes.map(displayNumber).join(', ')}`,
    domain: 'algebra',
    parameters: { slopes },
    narration: `These lines have exact slopes ${slopes.map(displayNumber).join(', ')} on the same axes.`,
  };
}

function extractPythagorean(text: string): TemplateMatch | null {
  if (!/\bpythagorean\b/i.test(text) || !/\b(?:area|proof)\b/i.test(text)) return null;
  return {
    template: 'pythagorean_area_proof',
    groupLabel: 'Pythagorean area proof',
    domain: 'geometry',
    parameters: {},
    narration: 'The same four triangles leave either the c-squared area or the a-squared and b-squared areas.',
  };
}

function extractTriangleAngleSum(text: string): TemplateMatch | null {
  if (!/\btriangle\b/i.test(text) || !/\bangles?\b/i.test(text) || !/(?:\bsum\b.*\b180\b|\b180\b.*\bsum\b)/i.test(text)) return null;
  return {
    template: 'triangle_angle_sum',
    groupLabel: 'Triangle angle sum',
    domain: 'geometry',
    parameters: {},
    narration: 'The three interior angles fit along a straight line and total 180 degrees.',
  };
}

function extractGrammarClauses(text: string): TemplateMatch | null {
  if (!/\bmain\s+and\s+subordinate\s+clauses?\b/i.test(text)) return null;
  const sentence = /['“]([^'”]{5,180})['”]/.exec(text)?.[1];
  if (!sentence) return null;
  const parts = sentence.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2 || !/^(although|because|when|while|if|since|unless|after|before)\b/i.test(parts[0])) return null;
  const labels = [parts[0], parts[1]];
  return {
    template: 'grammar_structure',
    groupLabel: 'Main and subordinate clauses',
    domain: 'grammar',
    parameters: { labels },
    narration: 'The subordinate clause gives context, and the main clause can stand as the central statement.',
  };
}

function extractCausalCycle(text: string): TemplateMatch | null {
  if (!/\b(?:cycle|repeating)\b/i.test(text)) return null;
  const labels = explicitList(text, /\b(?:stages?|steps?)\s*:\s*([^.!?]+)/i);
  if (labels.length < 3 || labels.length > 6) return null;
  return {
    template: 'causal_cycle',
    groupLabel: 'Repeating cycle',
    domain: 'process',
    parameters: { labels },
    narration: `The cycle moves through ${labels.join(', ')} and returns to the start.`,
  };
}

function extractTimeline(text: string): TemplateMatch | null {
  if (!/\btimeline\b/i.test(text)) return null;
  const labels = explicitList(text, /\b(?:events?|dates?)\s*:\s*([^.!?]+)/i);
  if (labels.length < 3 || labels.length > 6) return null;
  return {
    template: 'timeline',
    groupLabel: 'Timeline',
    domain: 'timeline',
    parameters: { labels },
    narration: `The timeline orders ${labels.join(', ')} from left to right.`,
  };
}

function buildScene(request: IntentTemplateRequest, match: TemplateMatch): AnchorScene {
  const operationPrefix = request.sectionId.length <= 24
    ? request.sectionId
    : `template-${stableId(request.sectionId)}`;
  const adapted = adaptSemanticScene({
    schemaVersion: VISUAL_PLAN_VERSION,
    planId: `template-${request.sectionId}`.slice(0, 120),
    intent: {
      objective: match.groupLabel,
      domain: match.domain,
      relevance: 'essential',
      questionAnswered: request.idea.slice(0, 300),
      rationale: 'An exact deterministic template represents every supplied parameter without a model round.',
      action: 'establish',
      density: 'minimal',
    },
    groups: [{
      id: operationPrefix,
      label: match.groupLabel,
      revealOrder: ['outline', 'relation', 'label', 'connector', 'emphasis'],
      template: match.template,
      parameters: match.parameters,
    }],
  });
  return AnchorSceneSchema.parse({
    groupId: request.sectionId,
    groupLabel: match.groupLabel,
    template: match.template,
    ops: adapted.ops,
    storyboard: adapted.checkpoints.map((checkpoint, index) => ({
      id: `${request.sectionId}-template-${index}`.slice(0, 120),
      reveal: checkpoint.reveal,
      narration: index === 0 ? match.narration : `Now add the ${checkpoint.reveal} that completes ${match.groupLabel.toLowerCase()}.`,
      objectIds: checkpoint.ops.flatMap((op) => op.op === 'add' ? [op.id] : []),
    })),
  });
}

function linearEquations(text: string): Array<{ slope: number; intercept: number; label: string }> {
  const equations: Array<{ slope: number; intercept: number; label: string }> = [];
  const pattern = /y\s*=\s*([+-]?\s*(?:\d+(?:\.\d+)?)?)\s*\*?\s*x\s*([+-]\s*\d+(?:\.\d+)?)?/gi;
  for (const match of text.matchAll(pattern)) {
    const coefficient = (match[1] ?? '').replace(/\s/g, '');
    const slope = coefficient === '' || coefficient === '+' ? 1 : coefficient === '-' ? -1 : Number(coefficient);
    const intercept = Number((match[2] ?? '0').replace(/\s/g, ''));
    if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return [];
    equations.push({ slope, intercept, label: `y=${formatLinear(slope, intercept)}` });
  }
  return equations.length <= 3 ? equations : [];
}

function formatLinear(slope: number, intercept: number): string {
  const coefficient = slope === 1 ? '' : slope === -1 ? '-' : displayNumber(slope);
  const suffix = intercept === 0 ? '' : intercept > 0 ? `+${displayNumber(intercept)}` : displayNumber(intercept);
  return `${coefficient}x${suffix}`;
}

function explicitList(text: string, pattern: RegExp): string[] {
  const source = pattern.exec(text)?.[1];
  if (!source) return [];
  return source.split(/\s*(?:;|,|\band\b)\s*/i)
    .map((label) => label.trim())
    .filter((label) => label.length >= 2 && label.length <= 60);
}

function numericToken(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  const parsed = NUMBER_WORDS[normalized] ?? Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function displayNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}
