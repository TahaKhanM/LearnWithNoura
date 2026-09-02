import type { AddOp } from '../../shared/boardOps.js';
import type { SceneValidator } from '../lesson/compiler.js';
import type { SceneRenderer } from '../lesson/headlessSceneValidator.js';
import type { DirectorResult, DirectorSceneRequest } from './director.js';
import { buildDirectedScene } from './directorSchema.js';
import {
  IncrementalDirectorStreamParser,
  type ParsedDirectorStep,
} from './directorStreamParser.js';
import type { SceneModelPort } from './directorStreamingService.js';
import { correctLayoutOnce, type LayoutCorrectionPort } from './layoutCorrection.js';
import type { DirectorReasoningEffort, OpenAiTelemetryModel } from '../../shared/sessionTelemetry.js';
import { extractIntentTemplateScene } from './templateLane.js';

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
  model: SceneModelPort;
  validateScene: SceneValidator;
  renderScene: SceneRenderer;
  layoutCorrection?: LayoutCorrectionPort;
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
  const providerController = new AbortController();
  const abortProvider = () => providerController.abort(options.signal.reason);
  options.signal.addEventListener('abort', abortProvider, { once: true });
  let streamPrefix = '';
  try {
    const chunks = deps.model.streamPropose({ request, boardImage, signal: providerController.signal });
    for await (const chunk of chunks) {
      throwIfAborted(options.signal);
      streamPrefix += chunk;
      const template = completedStreamHeadTemplate(streamPrefix);
      if (template) {
        const templateName = template as NonNullable<ParsedDirectorStep['header']['template']>;
        const scene = extractIntentTemplateScene({
          idea: request.idea,
          constraints: request.constraints,
          sectionId: request.sectionId,
        });
        if (!scene || scene.template !== templateName) {
          return { ok: false, reasons: ['director_template_parameters_unresolved'], retryable: true };
        }
        providerController.abort('deterministic template short circuit');
        const addOps = scene.ops.filter((op): op is AddOp => op.op === 'add');
        const emittedIds = new Set<string>();
        const header: ParsedDirectorStep['header'] = {
          template: templateName,
          groupLabel: scene.groupLabel,
          representation: 'diagram',
          illustration: null,
        };
        for (const [index, storyboardStep] of scene.storyboard.entries()) {
          const priorOps = [...cumulativeOps];
          const objectIds = new Set(storyboardStep.objectIds);
          const acceptedOps = addOps.filter((op) => objectIds.has(op.id) && !emittedIds.has(op.id));
          acceptedOps.forEach((op) => emittedIds.add(op.id));
          cumulativeOps.push(...acceptedOps);
          failurePhase = 'validate';
          const verdict = await validateScene([...request.currentBoardOps, ...cumulativeOps]);
          throwIfAborted(options.signal);
          if (!verdict.ok) {
            return {
              ok: false,
              reasons: verdict.issues.map((issue) => `Template step ${storyboardStep.id} failed browser preflight: ${issue}`),
              retryable: false,
            };
          }
          failurePhase = 'callback';
          await options.onStep({
            index,
            header,
            step: {
              id: storyboardStep.id,
              reveal: storyboardStep.reveal,
              narration: storyboardStep.narration,
              ops: acceptedOps,
            },
            ops: acceptedOps,
            priorOps,
            cumulativeOps: [...cumulativeOps],
          });
          deliveredSteps += 1;
          if (!firstValidatedOpReported && deps.composition) {
            firstValidatedOpReported = true;
            try { options.onFirstValidatedOp?.(deps.composition); }
            catch { /* telemetry observers cannot alter composition */ }
          }
        }
        return { ok: true, scene };
      }
      failurePhase = 'parse';
      const parsedSteps = parser.push(chunk);
      failurePhase = 'provider';
      for (const step of parsedSteps) {
        const priorOps = [...cumulativeOps];
        let acceptedOps = step.ops;
        cumulativeOps.push(...acceptedOps);
        failurePhase = 'validate';
        let verdict = await validateScene([...request.currentBoardOps, ...cumulativeOps]);
        throwIfAborted(options.signal);
        if (!verdict.ok && verdict.layoutIssues?.length && deps.layoutCorrection) {
          const corrected = await correctLayoutOnce(deps.layoutCorrection, {
            request,
            priorOps,
            rejectedOps: acceptedOps,
            layoutIssues: verdict.layoutIssues,
            signal: options.signal,
          });
          throwIfAborted(options.signal);
          if (corrected.ok) {
            acceptedOps = corrected.ops;
            cumulativeOps.splice(priorOps.length, cumulativeOps.length - priorOps.length, ...acceptedOps);
            verdict = await validateScene([...request.currentBoardOps, ...cumulativeOps]);
            throwIfAborted(options.signal);
          }
        }
        if (!verdict.ok) {
          return {
            ok: false,
            reasons: verdict.issues.map((issue) =>
              `Step ${step.step.id} failed browser preflight: ${issue}`),
            retryable: deliveredSteps === 0,
          };
        }
        failurePhase = 'callback';
        await options.onStep({ ...step, ops: acceptedOps, priorOps, cumulativeOps: [...cumulativeOps] });
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
    const scene = buildDirectedScene({
      groupId: request.sectionId,
      groupLabel: proposal.groupLabel,
      ops: [...cumulativeOps],
      storyboard: proposal.storyboard,
    });
    return {
      ok: true,
      scene,
      ...(proposal.illustration ? { illustrationBrief: proposal.illustration } : {}),
    };
  } catch (error) {
    if (isAbortError(error) || options.signal.aborted) throw abortError();
    return {
      ok: false,
      reasons: [`director_stream_error:${failurePhase}`],
      retryable: deliveredSteps === 0 &&
        (failurePhase === 'provider' || failurePhase === 'parse' || error instanceof StreamingDirectorPrecommitError),
    };
  } finally {
    options.signal.removeEventListener('abort', abortProvider);
  }
}

export function completedStreamHeadTemplate(text: string): string | null | undefined {
  const match = /^\s*\{\s*"template"\s*:\s*(null|"([a-z0-9_]+)")\s*,/i.exec(text);
  if (!match) return undefined;
  return match[1] === 'null' ? null : match[2];
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
