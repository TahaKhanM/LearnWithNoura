import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BoardPurposeSchema, LessonStageKindSchema } from '../../shared/pedagogy';
import { VisualTemplateSchema } from '../../shared/semanticScene';
import { REALTIME_TOOLS } from './tools';

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
    // Replace is not a live action in any form; the prompt may say it does
    // not exist, but never offer it as a backticked action.
    expect(prompt).not.toMatch(/`replace`/);
    expect(prompt).not.toMatch(/`clear`/);
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
});
