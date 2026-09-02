import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnchorScene } from '../../shared/compiledLesson.js';
import type { LessonBlueprint, LessonStage } from '../../shared/pedagogy.js';

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

/**
 * Per-stage execution context injected by the application. The compiled
 * blueprint is authored before the session; this hands the stage executor
 * the current stage's objective, its exact check questions, and — for the
 * anchor-establishing stage — the storyboard narration beats.
 */
export function lessonExecutionContext(
  blueprint: LessonBlueprint | null,
  stage: LessonStage | null,
  anchorScene: AnchorScene | null,
): string {
  if (!blueprint || !stage) return '';
  const lines: string[] = [
    '## Current stage (injected by the application)',
    `Lesson goal: ${blueprint.goal}`,
    `Success criteria: ${blueprint.successCriteria.join(' | ')}`,
    `Stage ${stage.id} (${stage.kind}) — objective: ${stage.objective}`,
    `Board purpose: ${stage.boardPurpose}; allowed board mutation: ${stage.allowedBoardMutation}.`,
    `Learner opportunity to create: ${stage.learnerOpportunity}`,
    `Evidence this stage expects: ${stage.evidenceExpected}`,
  ];
  if (blueprint.mode === 'conversation_led' || !anchorScene) {
    lines.push(
      'This lesson has no pre-validated anchor. Allowed board mutation none means no required scene change — it does not forbid a useful visual. When a new representation would help or the learner asks for one, call request_visual with action establish; the Board Director designs it and the learner browser validates it. Use board_ops only for a small increment on work that is already visible. Never tell the learner you cannot draw.',
    );
  }
  if (blueprint.detourStack.length > 0) {
    const top = blueprint.detourStack[blueprint.detourStack.length - 1];
    lines.push(`You are on a prerequisite detour (${top.reason}); after it resolves, the lesson returns to its recorded stage automatically.`);
  }
  const checks = stage.checks ?? [];
  if (checks.length > 0) {
    lines.push('Check questions for this stage — deliver the wording verbatim as questionOrTask:');
    for (const check of checks) {
      const targets = check.targetObjectIds?.length ? `; target objects: ${check.targetObjectIds.join(', ')}` : '';
      lines.push(`- [${check.id}] "${check.questionOrTask}" (answer by ${check.responseMode}${targets})`);
      for (const branch of check.misconceptions ?? []) {
        lines.push(`  - If the learner answers roughly "${branch.anticipatedAnswer}": ${branch.tactic}`);
      }
    }
  }
  if (anchorScene && stage.allowedBoardMutation === 'establish') {
    lines.push(
      `Anchor scene for section ${anchorScene.groupId} (${anchorScene.groupLabel}): when your establish request is accepted, the pre-validated scene builds step by step and the application prompts you to narrate each beat as its objects appear.`,
      'Do not describe or narrate parts of the scene before you are prompted, and never refer to objects that have not appeared yet.',
    );
  }
  lines.push('Adapt freely inside this stage — rephrase, add examples, change tactics — but do not skip to another stage, change the anchor representation, or invent new check questions when a pre-authored one fits.');
  return lines.join('\n');
}
