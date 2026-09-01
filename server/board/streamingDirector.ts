import type { AddOp } from '../../shared/boardOps.js';
import type { SceneValidator } from '../lesson/compiler.js';
import type { SceneRenderer } from '../lesson/headlessSceneValidator.js';
import type { DirectorResult, DirectorSceneRequest } from './director.js';
import { buildDirectedScene } from './directorSchema.js';
import {
  IncrementalDirectorStreamParser,
  type ParsedDirectorStep,
} from './directorStreamParser.js';
import type { DirectorStreamModelPort } from './directorStreamingService.js';
import type { DirectorReasoningEffort, OpenAiTelemetryModel } from '../../shared/sessionTelemetry.js';

export interface StreamingDirectorStep extends ParsedDirectorStep {
  cumulativeOps: AddOp[];
}

/** A realtime callback may reject a step before it mutates runner state.
 * This preserves eligibility for the single M1 medium-effort retry. */
export class StreamingDirectorPrecommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamingDirectorPrecommitError';
  }
}

export interface StreamingDirectorDeps {
  model: DirectorStreamModelPort;
  validateScene: SceneValidator;
  renderScene: SceneRenderer;
  composition?: { model: OpenAiTelemetryModel; reasoningEffort: DirectorReasoningEffort };
}

export type StreamingBoardDirector = (
  request: DirectorSceneRequest,
  options: {
    signal: AbortSignal;
    onStep: (step: StreamingDirectorStep) => Promise<void>;
    onFirstValidatedOp?: (input: { model: OpenAiTelemetryModel; reasoningEffort: DirectorReasoningEffort }) => void;
  },
) => Promise<DirectorResult>;

/** Streams and validates a diagram one complete step at a time. The callback
 * is the only handoff point to staging: malformed, policy-rejected, or
 * browser-rejected partial JSON never reaches it. */
export async function streamVisual(
  deps: StreamingDirectorDeps,
  request: DirectorSceneRequest,
  options: {
    signal: AbortSignal;
    onStep: (step: StreamingDirectorStep) => Promise<void>;
    onFirstValidatedOp?: (input: { model: OpenAiTelemetryModel; reasoningEffort: DirectorReasoningEffort }) => void;
  },
): Promise<DirectorResult> {
  const renderScene = request.renderScene ?? deps.renderScene;
  const validateScene = request.validateScene ?? deps.validateScene;
  const boardImage = request.currentBoardOps.length > 0
    ? await renderScene(request.currentBoardOps)
    : null;
  throwIfAborted(options.signal);
  const parser = new IncrementalDirectorStreamParser({
    density: request.density,
    visibleObjectIds: request.visibleObjectIds,
  });
  const cumulativeOps: AddOp[] = [];
  let firstValidatedOpReported = false;
  let deliveredSteps = 0;
  let failurePhase: 'provider' | 'parse' | 'validate' | 'callback' = 'provider';
  try {
    const chunks = deps.model.streamProposal({ request, boardImage, signal: options.signal });
    for await (const chunk of chunks) {
      throwIfAborted(options.signal);
      failurePhase = 'parse';
      const parsedSteps = parser.push(chunk);
      failurePhase = 'provider';
      for (const step of parsedSteps) {
        // M4 owns the parallel image lane. Until then an illustration header
        // must fail before any overlay callback can queue or reveal a partial
        // scene that the completed stream is guaranteed to reject.
        if (step.header.representation === 'illustration') {
          return {
            ok: false,
            reasons: ['Streaming illustration composition is deferred to the parallel illustration lane.'],
            fallback: 'classic_illustration',
          };
        }
        cumulativeOps.push(...step.ops);
        failurePhase = 'validate';
        const verdict = await validateScene([...cumulativeOps]);
        throwIfAborted(options.signal);
        if (!verdict.ok) {
          return {
            ok: false,
            reasons: verdict.issues.map((issue) =>
              `Step ${step.step.id} failed browser preflight: ${issue}`),
            retryable: deliveredSteps === 0,
          };
        }
        failurePhase = 'callback';
        await options.onStep({ ...step, cumulativeOps: [...cumulativeOps] });
        throwIfAborted(options.signal);
        deliveredSteps += 1;
        if (!firstValidatedOpReported && deps.composition) {
          firstValidatedOpReported = true;
          try { options.onFirstValidatedOp?.(deps.composition); }
          catch { /* telemetry observers cannot alter composition */ }
        }
        failurePhase = 'provider';
      }
    }
    failurePhase = 'parse';
    const proposal = parser.finish();
    if (proposal.representation === 'illustration') {
      return {
        ok: false,
        reasons: ['Streaming illustration composition is deferred to the parallel illustration lane.'],
        fallback: 'classic_illustration',
      };
    }
    const scene = buildDirectedScene({
      groupId: request.sectionId,
      groupLabel: proposal.groupLabel,
      ops: [...cumulativeOps],
      storyboard: proposal.storyboard,
    });
    return { ok: true, scene };
  } catch (error) {
    if (isAbortError(error) || options.signal.aborted) throw abortError();
    return {
      ok: false,
      reasons: [String(error instanceof Error ? error.message : error).slice(0, 500)],
      retryable: deliveredSteps === 0 &&
        (failurePhase === 'parse' || error instanceof StreamingDirectorPrecommitError),
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortError(): Error {
  const error = new Error('Director stream aborted by visual request epoch.');
  error.name = 'AbortError';
  return error;
}
