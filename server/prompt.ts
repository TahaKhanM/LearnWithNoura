import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_WIDTH, BOARD_HEIGHT } from '../src/whiteboard/types';

/**
 * Seneca's teaching instructions live in Markdown, not in a template
 * literal, so that how the tutor teaches can be worked on without touching
 * the code that runs it. The file is read per turn, so editing the prompt
 * takes effect on the next question with no restart.
 */

const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'prompts', 'seneca.md');

// Board dimensions belong to the code, so the prompt refers to them by name
// and cannot drift out of step with the real board.
const PLACEHOLDERS: Record<string, string> = {
  BOARD_WIDTH: String(BOARD_WIDTH),
  BOARD_HEIGHT: String(BOARD_HEIGHT),
};

/** Substitutes {{NAME}} placeholders. Exported for testing. */
export function fillPlaceholders(template: string, values = PLACEHOLDERS): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name] : whole,
  );
}

export function loadSystemPrompt(): string {
  return fillPlaceholders(readFileSync(PROMPT_PATH, 'utf8'));
}

/**
 * Reads the prompt once so a missing or unreadable file fails loudly at
 * boot rather than in the middle of a child's lesson.
 */
export function assertPromptReadable(): void {
  const prompt = loadSystemPrompt();
  if (!prompt.trim()) throw new Error(`Prompt at ${PROMPT_PATH} is empty.`);
}
