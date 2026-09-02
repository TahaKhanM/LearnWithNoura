import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BoardPurposeSchema, LessonStageKindSchema } from '../../shared/pedagogy';
import { VisualTemplateSchema } from '../../shared/semanticScene';
import { REALTIME_TOOLS } from './tools';
import { VisualRequestSchema } from './visualRequests';

/**
 * The prompt, the live tool schemas, and the shared validators must agree
 * exactly: every live tool is taught, and nothing removed (like the old
 * live blueprint authorship) is ever mentioned as available.
 */

const prompt = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'realtime.md'),
  'utf8',
);
const liveToolNames = REALTIME_TOOLS.map((tool) => tool.name as string);

describe('realtime prompt / tool-surface consistency', () => {
  it('teaches every live tool by name', () => {
    for (const name of liveToolNames) {
      expect(prompt, `prompt must mention live tool ${name}`).toContain(`\`${name}\``);
    }
  });

  it('never mentions removed tools or unavailable actions', () => {
    expect(prompt).not.toContain('create_lesson_blueprint');
    expect(liveToolNames).not.toContain('create_lesson_blueprint');
    // Phase 3a replaced geometry-carrying plans with intent-only requests:
    // the old tool must be gone from both the prompt and the live surface.
    expect(prompt).not.toContain('semantic_visual_plan');
    expect(liveToolNames).not.toContain('semantic_visual_plan');
    expect(liveToolNames).toContain('request_visual');
    // Replace is not a live action in any form; the prompt may say it does
    // not exist, but never offer it as a backticked action.
    expect(prompt).not.toMatch(/`replace`/);
    expect(prompt).not.toMatch(/`clear`/);
  });

  it('teaches intent-only visuals: the voice model never supplies geometry or templates', () => {
    // The prompt must not teach template names as request vocabulary; the
    // Director and compiler own all scene geometry now.
    for (const template of VisualTemplateSchema.options) {
      expect(prompt, `prompt must not offer template ${template}`).not.toContain(`\`${template}\``);
    }
    expect(prompt).toContain('INTENT');
    expect(prompt).toContain('never supply geometry');
    // Director/compiler-only vocabulary must never be taught to the voice model.
    expect(prompt).not.toMatch(/kind":"arc"/);
    expect(prompt).not.toMatch(/kind":"curve"/);
    expect(prompt).not.toMatch(/kind":"asset"/);
    expect(prompt).not.toMatch(/kind":"draggable"/);
    expect(prompt).not.toMatch(/kind":"snapZone"/);
    expect(prompt).not.toMatch(/kind":"tappable"/);
    expect(prompt).not.toMatch(/kind":"image"/);
    expect(prompt).not.toContain('generate_illustration');
    expect(prompt).not.toContain('handwritten');
  });

  it('uses only identifiers the shared validators know', () => {
    const allowed = new Set<string>([
      ...liveToolNames,
      ...LessonStageKindSchema.options,
      ...BoardPurposeSchema.options,
      ...VisualTemplateSchema.options,
      'board_led',
      'conversation_led',
    ]);
    const tokens = [...prompt.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((match) => match[1]);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(allowed.has(token), `prompt backticks unknown snake_case identifier ${token}`).toBe(true);
    }
  });

  it('describes the tutor as an executor of the compiled lesson', () => {
    expect(prompt).toContain('Current stage');
    expect(prompt).toContain('storyboard');
    expect(prompt).not.toMatch(/create the lesson blueprint/i);
  });

  it('keeps the Board Director available in conversation-led lessons', () => {
    expect(prompt).toContain('conversation_led');
    expect(prompt).toContain('request_visual');
    expect(prompt).not.toMatch(/just talk/);
    expect(prompt).toMatch(/does\s+not disable drawing/i);
  });

  it('routes every new representation through intent, validation, and vision', () => {
    expect(prompt).toMatch(/any new representation/i);
    expect(prompt).toMatch(/learner's real browser/i);
    expect(prompt).toMatch(/vision-checks/i);
    expect(prompt).toMatch(/never promise a picture is on the board/i);
  });

  it('treats learner-stroke vector features as hints and asks on vector/vision conflict', () => {
    expect(prompt).toMatch(/see the drawing, then interpret/i);
    expect(prompt).toMatch(/vector features are\s+spatial hints/i);
    expect(prompt).toMatch(/explicit confidence/i);
    expect(prompt).toMatch(/vector geometry and the image disagree/i);
  });

  it('advertises board_ops only as the fast increment path', () => {
    const tool = REALTIME_TOOLS.find((candidate) => candidate.name === 'board_ops');
    expect(tool?.description).toMatch(/blank board/i);
    expect(tool?.description).toMatch(/first paint/i);
    expect(tool?.description).toMatch(/go through request_visual/i);
  });
});

/**
 * The `request_visual` JSON schema advertised to the provider and the
 * runtime `VisualRequestSchema` that validates the call must agree exactly:
 * a payload the provider was told is legal must parse, and every advertised
 * bound must actually be enforced. Drift fails here in CI, not at runtime.
 */
describe('request_visual tool schema ↔ VisualRequestSchema', () => {
  interface JsonProperty {
    type?: string;
    enum?: readonly string[];
    minLength?: number;
    maxLength?: number;
    maxItems?: number;
    items?: { minLength?: number; maxLength?: number };
  }
  const tool = REALTIME_TOOLS.find((candidate) => candidate.name === 'request_visual') as unknown as {
    parameters: { properties: Record<string, JsonProperty>; required: string[] };
  };
  const properties = tool.parameters.properties;
  const required = new Set(tool.parameters.required);
  const base: Record<string, unknown> = {
    schemaVersion: '3.0.0',
    requestId: 'drift-check',
    action: 'establish',
    purpose: 'Show the relation',
    idea: 'Both fractions on one scale',
    density: 'minimal',
  };
  const parses = (payload: Record<string, unknown>) => VisualRequestSchema.safeParse(payload).success;

  it('exposes exactly the fields the runtime validator knows', () => {
    expect(Object.keys(properties).sort()).toEqual(Object.keys(VisualRequestSchema.shape).sort());
  });

  it('agrees on which fields are required', () => {
    expect(parses(base)).toBe(true);
    for (const key of Object.keys(properties)) {
      const payload = { ...base };
      delete payload[key];
      expect(parses(payload), `omitting ${key} must ${required.has(key) ? 'fail' : 'pass'} the runtime validator`)
        .toBe(!required.has(key));
    }
  });

  it('agrees on every advertised enum value and rejects values outside it', () => {
    for (const [key, property] of Object.entries(properties)) {
      if (!property.enum) continue;
      for (const value of property.enum) {
        expect(parses({ ...base, [key]: value }), `${key}=${value} is advertised and must parse`).toBe(true);
      }
      expect(parses({ ...base, [key]: 'not-a-real-value' }), `${key} must reject values outside the advertised enum`).toBe(false);
    }
    // Nothing the runtime accepts is missing from the advertisement.
    expect([...VisualRequestSchema.shape.action.options].sort()).toEqual([...(properties.action.enum ?? [])].sort());
    expect([...VisualRequestSchema.shape.density.options].sort()).toEqual([...(properties.density.enum ?? [])].sort());
  });

  it('agrees on advertised string and array bounds', () => {
    for (const [key, property] of Object.entries(properties)) {
      if (property.enum) continue;
      if (property.type === 'string' && typeof property.maxLength === 'number') {
        expect(parses({ ...base, [key]: 'x'.repeat(property.maxLength) }), `${key} at maxLength must parse`).toBe(true);
        expect(parses({ ...base, [key]: 'x'.repeat(property.maxLength + 1) }), `${key} beyond maxLength must fail`).toBe(false);
        if (property.minLength === 1) {
          expect(parses({ ...base, [key]: '' }), `${key} advertises minLength 1 and must reject empty`).toBe(false);
        }
      }
      if (property.type === 'array' && typeof property.maxItems === 'number') {
        const item = 'x'.repeat(property.items?.maxLength ?? 1);
        expect(parses({ ...base, [key]: Array.from({ length: property.maxItems }, () => item) }), `${key} at maxItems must parse`).toBe(true);
        expect(parses({ ...base, [key]: Array.from({ length: property.maxItems + 1 }, () => item) }), `${key} beyond maxItems must fail`).toBe(false);
        if (typeof property.items?.maxLength === 'number') {
          expect(parses({ ...base, [key]: ['x'.repeat(property.items.maxLength + 1)] }), `${key} items beyond maxLength must fail`).toBe(false);
        }
      }
    }
  });
});
