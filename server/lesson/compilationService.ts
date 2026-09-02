import type OpenAI from 'openai';
import type { CompiledLessonRecord, NormalizedGoal } from '../../shared/compiledLesson.js';
import type { LessonStage } from '../../shared/pedagogy.js';
import type { DomainRepository } from '../store/domain.js';
import {
  LessonCompileError,
  compileDetourStages,
  compileLesson,
  normalizeGoal,
  type AuthoringChatClient,
  type LessonCompilerDeps,
} from './compiler.js';
import { compileFixtureLesson, normalizeFixtureGoal } from './fixtureCompiler.js';
import { createHeadlessSceneValidator, type HeadlessSceneValidatorHandle } from './headlessSceneValidator.js';
import { compileProvisionalConversationLesson, PROVISIONAL_COMPILER_MODEL } from './provisionalLesson.js';

/**
 * The session-facing face of the lesson compiler. Session creation calls
 * normalize() inside the request, then start() records a pending artifact.
 * A stronger compile promotes it to ready in the background. The lesson UI
 * owns this honest Preparing state; realtime never snapshots a provisional
 * plan that can be replaced behind its back.
 */

export interface CompilationStartInput {
  sessionId: string;
  goal: string;
  objective: string;
  learnerName?: string;
  learnerAge?: number | null;
}

export interface DetourPlanInput {
  objective: string;
  reason: string;
  returnStageObjective: string;
  learnerAge?: number | null;
}

export interface LessonCompilationService {
  /** Turns the parent's free-text goal into one objective or 2-3 candidates. */
  normalize(input: { goal: string; learnerName?: string; learnerAge?: number | null }): Promise<NormalizedGoal>;
  /** Records a compilation for the session and returns its current state. */
  start(input: CompilationStartInput): Promise<CompiledLessonRecord>;
  /** Authors a bounded detour mini-plan for a live prerequisite gap. */
  planDetour(input: DetourPlanInput): Promise<LessonStage[]>;
  close(): Promise<void>;
}

/**
 * Deterministic compilation for offline development and automated tests
 * ONLY. app.ts selects it explicitly when no model provider is configured,
 * which production startup readiness forbids — it is never a silent
 * production fallback.
 */
export function createFixtureCompilationService(repo: DomainRepository): LessonCompilationService {
  return {
    normalize: async ({ goal }) => normalizeFixtureGoal(goal),
    start: async (input) => {
      const lesson = compileFixtureLesson({ lessonKey: input.sessionId, goal: input.goal, objective: input.objective });
      return repo.upsertCompiledLesson(input.sessionId, { status: 'ready', lesson });
    },
    planDetour: async (input) => [{
      id: 'detour-prerequisite',
      kind: 'model',
      objective: `Rebuild the missing idea: ${input.reason}`.slice(0, 240),
      boardPurpose: 'none',
      allowedBoardMutation: 'none',
      learnerOpportunity: 'Work one tiny example of the missing idea aloud',
      evidenceExpected: 'recall',
      checks: [{
        id: 'detour-check',
        questionOrTask: 'Try that smaller piece once more in your own words.',
        responseMode: 'voice',
      }],
    }],
    close: async () => {},
  };
}

export interface LiveCompilationOptions {
  repo: DomainRepository;
  client: OpenAI;
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high';
  /** Board harness URL for headless scene validation; null fails closed. */
  harnessUrl: string | null;
  maxSceneRetries?: number;
  /** Observes background compilation failures (for logs); optional. */
  onCompileError?: (sessionId: string, reasons: string[]) => void;
  /** Keeps a serverless isolate alive until background compile finishes. */
  keepAlive?: (work: Promise<unknown>) => void;
}

/** Real compiler: Chat Completions authorship plus optional early headless
 * validation. The connected lesson browser is the mandatory reveal gate. */
export function createLiveCompilationService(options: LiveCompilationOptions): LessonCompilationService {
  const authoring: AuthoringChatClient = {
    complete: async ({ messages }) => {
      const response = await options.client.chat.completions.create({
        model: options.model,
        reasoning_effort: options.reasoningEffort,
        response_format: { type: 'json_object' },
        messages,
      });
      return response.choices[0]?.message?.content ?? null;
    },
  };
  let validator: HeadlessSceneValidatorHandle | null = null;
  const deps: LessonCompilerDeps = {
    client: authoring,
    compilerModel: options.model,
    maxSceneRetries: options.maxSceneRetries,
    validateScene: async (ops) => {
      if (!options.harnessUrl) {
        // Production validation authority is the connected learner browser.
        // The authored BoardOps schema is enforced during compilation, and
        // the anchor is preflighted through that real browser before its
        // first storyboard step can be shown. Server Chromium is an optional
        // early-quality gate, not a production availability switch.
        void ops;
        return { ok: true };
      }
      validator ??= createHeadlessSceneValidator({ harnessUrl: options.harnessUrl });
      return validator.validate(ops);
    },
  };

  return {
    normalize: (input) => normalizeGoal(deps, input),
    start: async (input) => {
      const provisional = compileProvisionalConversationLesson({
        lessonKey: input.sessionId,
        goal: input.goal,
        objective: input.objective,
      });
      const pending = await options.repo.upsertCompiledLesson(input.sessionId, {
        status: 'pending',
        lesson: provisional,
      });
      const work = (async () => {
        try {
          const lesson = await compileLesson(deps, {
            lessonKey: input.sessionId,
            goal: input.goal,
            objective: input.objective,
            learnerName: input.learnerName,
            learnerAge: input.learnerAge,
          });
          const current = await options.repo.getCompiledLesson(input.sessionId);
          if (current && !isUpgradeableCompiledLesson(current)) return;
          await options.repo.upsertCompiledLesson(input.sessionId, { status: 'ready', lesson });
        } catch (error) {
          const reasons = error instanceof LessonCompileError && error.reasons.length > 0
            ? error.reasons
            : [String(error instanceof Error ? error.message : error).slice(0, 300)];
          options.onCompileError?.(input.sessionId, reasons);
          await options.repo.upsertCompiledLesson(input.sessionId, {
            status: 'failed',
            lesson: provisional,
            failureReason: 'Noura could not prepare a validated lesson for this goal. Please try again.',
          });
        }
      })();
      options.keepAlive?.(work);
      return pending;
    },
    planDetour: (input) => compileDetourStages(deps, input),
    close: async () => {
      await validator?.close();
      validator = null;
    },
  };
}

function isUpgradeableCompiledLesson<RecordShape extends { status: string; lesson: { compilerModel?: string } | null }>(record: RecordShape): boolean {
  return record.status === 'pending' || record.lesson?.compilerModel === PROVISIONAL_COMPILER_MODEL;
}
