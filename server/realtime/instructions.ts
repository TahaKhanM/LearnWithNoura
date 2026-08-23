import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(here, '..', 'prompts', 'realtime.md');

let cached: string | null = null;

function template(): string {
  if (cached === null) cached = readFileSync(PROMPT_PATH, 'utf8');
  return cached;
}

export function assertRealtimePromptReadable(): void {
  template();
}

export interface SessionProfile {
  childName: string;
  childAge: number | null;
  goal: string;
}

/** Builds the live tutor's instructions for one session. */
export function buildInstructions(profile: SessionProfile): string {
  const ageClause =
    profile.childAge !== null && Number.isFinite(profile.childAge)
      ? `, who is ${profile.childAge} years old. Pitch explanations to that age`
      : '. Pitch explanations to the level their questions imply';
  return template()
    .replaceAll('{{CHILD_NAME}}', sanitize(profile.childName) || 'the learner')
    .replaceAll('{{CHILD_AGE_CLAUSE}}', ageClause)
    .replaceAll('{{GOAL}}', sanitize(profile.goal) || 'whatever the learner wants to explore');
}

/** Profile fields come from user input; keep them prompt-shaped. */
function sanitize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200);
}
