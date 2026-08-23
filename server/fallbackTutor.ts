import type OpenAI from 'openai';
import { createRuntimeEvent, type GenerationIdentity, type RuntimeEventEnvelope } from '../shared/runtimeProtocol.js';
import { adaptSemanticScene } from '../shared/semanticScene.js';
import { ResponseTaxonomySchema, TeachingMoveSchema, type ResponseTaxonomy } from '../shared/pedagogy.js';
import { createLessonState, reduceLesson, responseHandoff } from './lesson/orchestrator.js';
import { buildInstructions } from './realtime/instructions.js';
import { REALTIME_TOOLS } from './realtime/tools.js';
import type { FallbackTurnIdentity, Repo } from './store/repo.js';

/** Captions-only degraded mode. It deliberately shares the semantic visual,
 * pedagogy, evidence, and generation-envelope contracts with Realtime. */

const MAX_ROUNDS = 10;
const DEFAULT_TIMEOUT_MS = 20_000;
const ALLOWED_TOOLS = new Set(['semantic_visual_plan', 'propose_teaching_move', 'record_evidence']);
const FALLBACK_TOOLS: OpenAI.Chat.ChatCompletionTool[] = REALTIME_TOOLS
  .filter((tool) => ALLOWED_TOOLS.has(tool.name))
  .map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));

export interface FallbackTurnRequest extends GenerationIdentity {
  idempotencyKey: string;
  userText: string;
}

export type FallbackEvent = RuntimeEventEnvelope<Record<string, unknown>>;

interface ActiveFallback {
  idempotencyKey: string;
  controller: AbortController;
  promise: Promise<FallbackEvent[]>;
}

export class FallbackTurnCoordinator {
  private activeBySession = new Map<string, ActiveFallback>();

  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async run(
    client: OpenAI,
    model: string,
    repo: Repo,
    request: FallbackTurnRequest,
    onEvent: (event: FallbackEvent) => void,
    requestSignal?: AbortSignal,
  ): Promise<'completed' | 'replayed'> {
    const identity = persistedIdentity(request);
    const claim = repo.claimFallbackTurn(identity);
    if (claim.kind === 'completed') {
      for (const event of claim.steps) onEvent(event as FallbackEvent);
      return 'replayed';
    }
    if (claim.kind === 'active') {
      const running = this.activeBySession.get(request.sessionId);
      if (!running || running.idempotencyKey !== request.idempotencyKey) {
        throw new Error('Fallback request is already active in another process.');
      }
      await running.promise;
      const stored = repo.getFallbackTurn(identity);
      if (stored?.status !== 'completed') throw new Error('Fallback request did not complete.');
      for (const event of stored.steps) onEvent(event as FallbackEvent);
      return 'replayed';
    }
    if (claim.kind === 'failed') throw new Error('This idempotency key already failed and cannot be reused.');

    const previous = this.activeBySession.get(request.sessionId);
    previous?.controller.abort('superseded by a newer fallback generation');
    const controller = new AbortController();
    const signal = composeAbortSignal([controller.signal, requestSignal], this.timeoutMs);
    const promise = executeFallbackTurn(client, model, repo, request, onEvent, signal);
    const active = { idempotencyKey: request.idempotencyKey, controller, promise };
    this.activeBySession.set(request.sessionId, active);
    try {
      await promise;
      return 'completed';
    } finally {
      if (this.activeBySession.get(request.sessionId) === active) this.activeBySession.delete(request.sessionId);
    }
  }
}

export const fallbackTurns = new FallbackTurnCoordinator();

async function executeFallbackTurn(
  client: OpenAI,
  model: string,
  repo: Repo,
  request: FallbackTurnRequest,
  onEvent: (event: FallbackEvent) => void,
  signal: AbortSignal,
): Promise<FallbackEvent[]> {
  const session = repo.getSession(request.sessionId);
  const child = session ? repo.getChild(session.childId) : null;
  if (!session || !child) throw new Error('unknown session');
  if (session.status !== 'active') throw new Error('session has ended');

  const identity = persistedIdentity(request);
  const runtimeIdentity: GenerationIdentity = request;
  const steps: FallbackEvent[] = [];
  let sequence = 0;
  let learnerEventId: number | null = null;
  let lessonState = createLessonState(session.goal, request.generationId);

  const assertActive = () => {
    if (signal.aborted || !repo.isFallbackTurnActive(identity)) throw abortError(signal.reason);
  };
  const ensureLearnerEvent = () => {
    assertActive();
    learnerEventId ??= repo.addFallbackEvent(identity, 'learner_said', { text: request.userText, via: 'text-fallback' });
    return learnerEventId;
  };
  const emit = (type: string, payload: Record<string, unknown>, optional: Parameters<typeof createRuntimeEvent>[4] = {}) => {
    assertActive();
    const event = createRuntimeEvent(runtimeIdentity, sequence++, type, payload, {
      ...optional,
      idempotencyKey: request.idempotencyKey,
    }) as FallbackEvent;
    steps.push(event);
    onEvent(event);
    return event;
  };

  const instructions = buildInstructions({ childName: child.name, childAge: child.age, goal: session.goal });
  const history: OpenAI.Chat.ChatCompletionMessageParam[] = repo
    .listEvents(request.sessionId, 400)
    .filter((event) => ['tutor_said', 'learner_said'].includes(event.type))
    .slice(-40)
    .map((event) => ({
      role: event.type === 'tutor_said' ? ('assistant' as const) : ('user' as const),
      content: (event.payload as { text?: string }).text ?? '',
    }))
    .filter((message) => message.content);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: `${instructions}\n\nVoice is unavailable, so words appear as captions. Use semantic_visual_plan rather than board_ops. Keep the same short spoken style.` },
    ...history,
    { role: 'user', content: request.userText },
  ];

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      assertActive();
      const response = await client.chat.completions.create({
        model,
        messages,
        tools: FALLBACK_TOOLS,
        tool_choice: 'auto',
        reasoning_effort: 'none',
      }, { signal });
      assertActive();
      const message = response.choices[0]?.message;
      if (!message) throw new Error('Fallback provider returned no message.');

      if (message.content?.trim()) {
        ensureLearnerEvent();
        repo.addFallbackEvent(identity, 'tutor_said', { text: message.content.trim() });
        emit('fallback_caption', { text: message.content.trim() });
      }
      messages.push(message);

      for (const call of message.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        assertActive();
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; }
        catch { /* handled by tool result */ }
        let output: Record<string, unknown> = { ok: false };

        if (call.function.name === 'semantic_visual_plan') {
          try {
            const { plan, ops, checkpoints } = adaptSemanticScene(args);
            ensureLearnerEvent();
            for (const checkpoint of checkpoints) {
              const eventId = repo.addFallbackEvent(identity, 'semantic_scene', {
                plan,
                ops: checkpoint.ops,
                checkpointId: checkpoint.id,
                reveal: checkpoint.reveal,
              }, false);
              emit('board_ops', {
                ops: checkpoint.ops,
                event_id: eventId,
                response_id: `fallback-${request.generationId}`,
                groupLabel: checkpoint.groupLabel,
                checkpoint: checkpoint.reveal,
              }, { visualCueId: checkpoint.id, semanticObjectId: checkpoint.semanticObjectId });
            }
            output = { ok: true, accepted: true, applied: ops.length, checkpoints: checkpoints.length, noBoard: ops.length === 0 };
          } catch (error) {
            output = { ok: false, accepted: false, error: String(error).slice(0, 260) };
          }
        } else if (call.function.name === 'propose_teaching_move') {
          const parsed = TeachingMoveSchema.safeParse(args);
          if (parsed.success) {
            try {
              lessonState = reduceLesson(lessonState, { type: 'MOVE_PROPOSED', move: parsed.data });
              const state = {
                activeConcept: lessonState.microObjective,
                strategy: lessonState.strategy,
                nextStep: lessonState.owedAction,
                phase: lessonState.phase,
                activeSemanticObjectId: lessonState.activeSemanticObjectId,
                characterAttentionTarget: lessonState.characterAttentionTarget,
              };
              ensureLearnerEvent();
              repo.addFallbackEvent(identity, 'lesson_state', state);
              emit('lesson_state', { state }, lessonState.activeSemanticObjectId ? { semanticObjectId: lessonState.activeSemanticObjectId } : {});
              output = { ok: true, legalPhase: lessonState.phase, owedAction: lessonState.owedAction };
            } catch (error) { output = { ok: false, error: String(error).slice(0, 220) }; }
          } else output = { ok: false, error: 'teaching move failed schema validation' };
        } else if (call.function.name === 'record_evidence') {
          const sourceEventId = ensureLearnerEvent();
          const concept = String(args.concept ?? '').slice(0, 120);
          const observation = String(args.observation ?? '').slice(0, 500);
          const classification = ResponseTaxonomySchema.safeParse(args.classification).success
            ? args.classification as ResponseTaxonomy
            : 'uncertain_or_ambiguous';
          if (concept && observation) {
            const stored = repo.addFallbackEvidence(identity, {
              concept,
              observation,
              verdict: fallbackVerdict(classification),
              confidence: ['low', 'medium', 'high'].includes(String(args.confidence)) ? args.confidence as 'low' | 'medium' | 'high' : 'low',
              excerpt: verifiedExcerpt(request.userText, args.excerpt),
              classification,
              confidenceBasis: String(args.confidence_basis ?? 'Fallback model classification.').slice(0, 400),
              sourceEventIds: [sourceEventId],
              taskId: String(args.task_id ?? lessonState.deliveredQuestionTaskId ?? 'fallback-opportunity').slice(0, 160),
              independenceLevel: classification === 'self_corrected' ? 'reduced' : 'independent',
              opportunityKind: ['recall', 'explanation', 'application', 'retrieval'].includes(String(args.opportunity_kind))
                ? args.opportunity_kind as 'recall' | 'explanation' | 'application' | 'retrieval'
                : 'recall',
              retrievalOf: typeof args.retrieval_of === 'string' ? args.retrieval_of.slice(0, 160) : undefined,
              contradicts: Array.isArray(args.contradicts) ? args.contradicts.filter((value): value is string => typeof value === 'string').map((value) => value.slice(0, 160)).slice(0, 8) : [],
              supersedes: Array.isArray(args.supersedes) ? args.supersedes.filter((value): value is string => typeof value === 'string').map((value) => value.slice(0, 160)).slice(0, 8) : [],
            });
            repo.addFallbackEvent(identity, 'evidence', { evidenceId: stored.evidenceId, concept, verdict: stored.verdict });
            emit('evidence', { entry: stored });
            lessonState = reduceLesson(lessonState, { type: 'ASSESSED', classification, evidenceId: stored.evidenceId });
            output = { ok: true, evidenceId: stored.evidenceId };
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      }

      if (message.tool_calls?.length) continue;
      const delivered = message.content?.trim() ?? '';
      if (/[?？]\s*$/.test(delivered)) {
        lessonState = reduceLesson(lessonState, { type: 'QUESTION_DELIVERED', taskId: `fallback-question-${request.turnId}`, text: delivered });
        break;
      }
      const handoff = responseHandoff(lessonState, delivered);
      if (handoff === 'wait') break;
      if (handoff === 'bounded_continuation') {
        lessonState = { ...lessonState, continuationAttempts: lessonState.continuationAttempts + 1 };
        messages.push({ role: 'system', content: 'Complete the promised teaching move now. End with exactly one short, concrete question or small task, then wait.' });
        continue;
      }
      const safeQuestion = 'Tell me one thing you notice about the idea we just explored?';
      ensureLearnerEvent();
      repo.addFallbackEvent(identity, 'tutor_said', { text: safeQuestion, deterministic: true });
      emit('safe_question', { text: safeQuestion });
      break;
    }
    assertActive();
    if (!repo.finishFallbackTurn(identity, 'completed', steps)) throw abortError('superseded before completion');
    return steps;
  } catch (error) {
    const aborted = signal.aborted || !repo.isFallbackTurnActive(identity);
    repo.finishFallbackTurn(identity, aborted ? 'cancelled' : 'failed');
    throw error;
  }
}

function persistedIdentity(request: FallbackTurnRequest): FallbackTurnIdentity {
  return {
    sessionId: request.sessionId,
    idempotencyKey: request.idempotencyKey,
    connectionEpoch: request.connectionEpoch,
    turnId: request.turnId,
    generationId: request.generationId,
  };
}

function composeAbortSignal(signals: Array<AbortSignal | undefined>, timeoutMs: number): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  available.push(AbortSignal.timeout(timeoutMs));
  return AbortSignal.any(available);
}

function abortError(reason: unknown): Error {
  const error = new Error(typeof reason === 'string' ? reason : 'Fallback generation aborted.');
  error.name = 'AbortError';
  return error;
}

function fallbackVerdict(value: ResponseTaxonomy): 'progressing' | 'struggling' | 'misconception' {
  if (value === 'confident_misconception') return 'misconception';
  if (['incorrect', 'confusion', 'missing_prerequisite', 'no_meaningful_response'].includes(value)) return 'struggling';
  return 'progressing';
}

function verifiedExcerpt(source: string, candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const excerpt = candidate.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 300);
  const normalizedSource = source.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return excerpt && normalizedSource.includes(excerpt) ? excerpt : undefined;
}
