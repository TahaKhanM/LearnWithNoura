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

/**
 * The session-facing face of the lesson compiler. Session creation calls
 * normalize() inside the request, then start() writes a pending record and
 * compiles in the background; the lesson page polls the record's status.
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

/** Real compiler: Chat Completions authorship + headless scene validation. */
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
        // Fail closed: without the real client pipeline no scene is trusted,
        // and the compiler falls back toward conversation-led lessons.
        return { ok: false, issues: ['No board harness URL is configured for scene validation.'] };
      }
      validator ??= createHeadlessSceneValidator({ harnessUrl: options.harnessUrl });
      return validator.validate(ops);
    },
  };

  return {
    normalize: (input) => normalizeGoal(deps, input),
    start: async (input) => {
      const pending = await options.repo.upsertCompiledLesson(input.sessionId, { status: 'pending' });
      const work = (async () => {
        try {
          const lesson = await compileLesson(deps, {
            lessonKey: input.sessionId,
            goal: input.goal,
            objective: input.objective,
            learnerName: input.learnerName,
            learnerAge: input.learnerAge,
          });
          await options.repo.upsertCompiledLesson(input.sessionId, { status: 'ready', lesson });
        } catch (error) {
          const reasons = error instanceof LessonCompileError && error.reasons.length > 0
            ? error.reasons
            : [String(error instanceof Error ? error.message : error).slice(0, 300)];
          options.onCompileError?.(input.sessionId, reasons);
          await Promise.resolve(options.repo.upsertCompiledLesson(input.sessionId, {
            status: 'failed',
            failureReason: reasons.join('; ').slice(0, 600),
          })).catch(() => {});
        }
      })();
      if (!options.harnessUrl) {
        await work;
        return (await options.repo.getCompiledLesson(input.sessionId)) ?? pending;
      }
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
