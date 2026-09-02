import type OpenAI from 'openai';
import { createRuntimeEvent, type GenerationIdentity, type RuntimeEventEnvelope } from '../shared/runtimeProtocol.js';
import { adaptSemanticScene, normalizeVisualAction, VISUAL_PLAN_VERSION, VisualTemplateSchema } from '../shared/semanticScene.js';
import { ResponseTaxonomySchema, TeachingMoveSchema, type ResponseTaxonomy } from '../shared/pedagogy.js';
import { createLessonState, reduceLesson, responseHandoff } from './lesson/orchestrator.js';
import { buildInstructions } from './realtime/instructions.js';
import { REALTIME_TOOLS } from './realtime/tools.js';
import { loadReleasedBoardContext } from './realtime/boardContext.js';
import type { DomainRepository } from './store/domain.js';
import type { FallbackTurnIdentity } from './store/repo.js';

/** Captions-only degraded mode. It deliberately shares the semantic visual,
 * pedagogy, evidence, and generation-envelope contracts with Realtime. */

const MAX_ROUNDS = 10;
const DEFAULT_TIMEOUT_MS = 20_000;
const ALLOWED_TOOLS = new Set(['inspect_board', 'propose_teaching_move', 'record_evidence', 'update_lesson_state']);
const FALLBACK_VISUAL_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'semantic_visual_plan',
    description: 'Captions-only visual fallback. Request one deterministic educational template by semantic content; code owns all geometry. Use establish for a first scene, compare for an additive side scene, emphasize for visible object ids, or none. Never replace or clear visible work.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        schemaVersion: { type: 'string', enum: [VISUAL_PLAN_VERSION] },
        planId: { type: 'string', minLength: 1, maxLength: 120 },
        intent: {
          type: 'object', additionalProperties: false,
          properties: {
            objective: { type: 'string', minLength: 1, maxLength: 300 },
            domain: { type: 'string', enum: ['geometry', 'quantitative', 'algebra', 'comparison', 'process', 'argument', 'history', 'grammar', 'table', 'timeline', 'none'] },
            relevance: { type: 'string', enum: ['essential', 'supportive', 'none'] },
            questionAnswered: { type: 'string', minLength: 1, maxLength: 300 },
            rationale: { type: 'string', minLength: 1, maxLength: 400 },
            action: { type: 'string', enum: ['establish', 'emphasize', 'compare', 'none'] },
            targetObjectIds: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 160 } },
            density: { type: 'string', enum: ['minimal', 'standard'] },
            noBoardReason: { type: 'string', maxLength: 300 },
          },
          required: ['objective', 'domain', 'relevance', 'questionAnswered', 'rationale', 'action', 'density'],
        },
        groups: {
          type: 'array', minItems: 0, maxItems: 1,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 80 },
              label: { type: 'string', minLength: 1, maxLength: 160 },
              revealOrder: { type: 'array', minItems: 1, items: { type: 'string', enum: ['outline', 'relation', 'label', 'connector', 'emphasis'] } },
              template: { type: 'string', enum: VisualTemplateSchema.options },
              parameters: { type: 'object' },
            },
            required: ['id', 'label', 'revealOrder', 'template', 'parameters'],
          },
        },
      },
      required: ['schemaVersion', 'planId', 'intent', 'groups'],
    },
  },
};
const FALLBACK_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  ...REALTIME_TOOLS
  .filter((tool) => ALLOWED_TOOLS.has(tool.name))
  .map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }) as OpenAI.Chat.ChatCompletionTool),
  FALLBACK_VISUAL_TOOL,
];

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
    repo: DomainRepository,
    request: FallbackTurnRequest,
    onEvent: (event: FallbackEvent) => void,
    requestSignal?: AbortSignal,
  ): Promise<'completed' | 'replayed'> {
    const identity = persistedIdentity(request);
    const claim = await repo.claimFallbackTurn(identity);
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
      const stored = await repo.getFallbackTurn(identity);
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
  repo: DomainRepository,
  request: FallbackTurnRequest,
  onEvent: (event: FallbackEvent) => void,
  signal: AbortSignal,
): Promise<FallbackEvent[]> {
  const session = await repo.getSession(request.sessionId);
  const child = session ? await repo.getChild(session.childId) : null;
  if (!session || !child) throw new Error('unknown session');
  if (session.status !== 'active') throw new Error('session has ended');

  const identity = persistedIdentity(request);
  const runtimeIdentity: GenerationIdentity = request;
  const steps: FallbackEvent[] = [];
  let sequence = 0;
  let learnerEventId: number | null = null;
  let lessonState = createLessonState(session.goal, request.generationId);

  const assertActive = async () => {
    if (signal.aborted || !(await repo.isFallbackTurnActive(identity))) throw abortError(signal.reason);
  };
  const ensureLearnerEvent = async () => {
    await assertActive();
    learnerEventId ??= await repo.addFallbackEvent(identity, 'learner_said', { text: request.userText, via: 'text-fallback' });
    return learnerEventId;
  };
  const emit = async (type: string, payload: Record<string, unknown>, optional: Parameters<typeof createRuntimeEvent>[4] = {}) => {
    await assertActive();
    const event = createRuntimeEvent(runtimeIdentity, sequence++, type, payload, {
      ...optional,
      idempotencyKey: request.idempotencyKey,
    }) as FallbackEvent;
    steps.push(event);
    onEvent(event);
    return event;
  };

  const instructions = buildInstructions({ childName: child.name, childAge: child.age, goal: session.goal });
  const boardContext = await loadReleasedBoardContext(repo, request.sessionId);
  const storedHistory = await repo.listEvents(request.sessionId, 400);
  const history: OpenAI.Chat.ChatCompletionMessageParam[] = storedHistory
    .filter((event) => ['tutor_said', 'learner_said'].includes(event.type))
    .slice(-40)
    .map((event) => ({
      role: event.type === 'tutor_said' ? ('assistant' as const) : ('user' as const),
      content: (event.payload as { text?: string }).text ?? '',
    }))
    .filter((message) => message.content);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: `${instructions}\n\n${boardContext.prompt()}\n\nVoice is unavailable, so words appear as captions. The live request_visual and board_ops paths are unavailable in this one-way fallback. For a new board scene, use semantic_visual_plan and its deterministic templates. Keep the same short spoken style.` },
    ...history,
    { role: 'user', content: request.userText },
  ];

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      await assertActive();
      const response = await client.chat.completions.create({
        model,
        messages,
        tools: FALLBACK_TOOLS,
        tool_choice: 'auto',
        reasoning_effort: 'none',
      }, { signal });
      await assertActive();
      const message = response.choices[0]?.message;
      if (!message) throw new Error('Fallback provider returned no message.');

      if (message.content?.trim()) {
        await ensureLearnerEvent();
        await repo.addFallbackEvent(identity, 'tutor_said', { text: message.content.trim() });
        await emit('fallback_caption', { text: message.content.trim() });
      }
      messages.push(message);

      for (const call of message.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        await assertActive();
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; }
        catch { /* handled by tool result */ }
        let output: Record<string, unknown> = { ok: false };

        if (call.function.name === 'inspect_board') {
          output = { ok: true, board: boardContext.toolSnapshot(typeof args.focus === 'string' ? args.focus.slice(0, 160) : undefined) };
        } else if (call.function.name === 'semantic_visual_plan') {
          try {
            const { plan, ops, checkpoints } = adaptSemanticScene(args);
            const action = normalizeVisualAction(plan.intent.action);
            // Visible tutor work never disappears — in fallback mode too.
            if (action === 'replace') {
              output = {
                ok: false,
                accepted: false,
                reason: 'Visible board work never disappears. Replacement is not available: extend or emphasize instead, or add a comparison beside it.',
                board: boardContext.toolSnapshot(),
              };
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
              continue;
            }
            if (action === 'none') {
              output = {
                ok: true,
                accepted: true,
                action,
                relevance: plan.intent.relevance,
                questionAnswered: plan.intent.questionAnswered,
                board: boardContext.toolSnapshot(),
              };
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
              continue;
            }
            if (action === 'emphasize') {
              const targets = (plan.intent.targetObjectIds ?? []).filter((id) => boardContext.hasObject(id)).slice(0, 12);
              if (targets.length === 0) {
                output = { ok: false, accepted: false, reason: 'Emphasize requires visible target object ids.', board: boardContext.toolSnapshot() };
              } else {
                await ensureLearnerEvent();
                const eventId = await repo.addFallbackEvent(identity, 'semantic_scene', {
                  ops: targets.map((id) => ({ op: 'highlight', id })),
                  checkpointId: `fallback-emphasize-${request.generationId}`,
                  reveal: 'emphasis',
                  semanticObjectId: 'fallback-visible-board',
                  groupLabel: 'Board',
                }, false);
                await emit('board_ops', {
                  ops: targets.map((id) => ({ op: 'highlight', id })),
                  event_id: eventId,
                  response_id: `fallback-${request.generationId}`,
                  groupLabel: 'Board',
                  checkpoint: 'emphasis',
                }, { visualCueId: `fallback-emphasize-${request.generationId}`, semanticObjectId: 'fallback-visible-board' });
                output = { ok: true, accepted: true, action, applied: targets.length, board: boardContext.toolSnapshot() };
              }
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
              continue;
            }
            const densityLimit = plan.intent.density === 'minimal' ? 14 : 30;
            if (ops.length > densityLimit) {
              output = {
                ok: false,
                accepted: false,
                reason: `The ${plan.intent.density} visual exceeds its ${densityLimit}-object density budget. Simplify or split the move.`,
                board: boardContext.toolSnapshot(),
              };
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
              continue;
            }
            const equivalent = boardContext.equivalentTutorScene(ops);
            if (equivalent.equivalent) {
              output = {
                ok: true,
                accepted: false,
                reason: 'An equivalent visual is already visible. Reuse its IDs and adapt it in place.',
                equivalentObjects: equivalent.duplicates,
                board: boardContext.toolSnapshot(),
              };
            } else {
              await ensureLearnerEvent();
              for (const checkpoint of checkpoints) {
                const eventId = await repo.addFallbackEvent(identity, 'semantic_scene', {
                  plan,
                  ops: checkpoint.ops,
                  checkpointId: checkpoint.id,
                  reveal: checkpoint.reveal,
                  semanticObjectId: checkpoint.semanticObjectId,
                  groupLabel: checkpoint.groupLabel,
                }, false);
                await emit('board_ops', {
                  ops: checkpoint.ops,
                  event_id: eventId,
                  response_id: `fallback-${request.generationId}`,
                  groupLabel: checkpoint.groupLabel,
                  checkpoint: checkpoint.reveal,
                }, { visualCueId: checkpoint.id, semanticObjectId: checkpoint.semanticObjectId });
              }
              output = {
                ok: true,
                accepted: true,
                applied: ops.length,
                checkpoints: checkpoints.length,
                noBoard: ops.length === 0,
                action: plan.intent.action,
                relevance: plan.intent.relevance,
                questionAnswered: plan.intent.questionAnswered,
                acceptedPendingObjectIds: ops.filter((op) => op.op === 'add').map((op) => op.id),
                board: boardContext.toolSnapshot(),
              };
            }
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
              await ensureLearnerEvent();
              await repo.addFallbackEvent(identity, 'lesson_state', state);
              await emit('lesson_state', { state }, lessonState.activeSemanticObjectId ? { semanticObjectId: lessonState.activeSemanticObjectId } : {});
              output = {
                ok: true,
                legalPhase: lessonState.phase,
                owedAction: lessonState.owedAction,
                board: boardContext.toolSnapshot(),
              };
            } catch (error) { output = { ok: false, error: String(error).slice(0, 220) }; }
          } else output = { ok: false, error: 'teaching move failed schema validation' };
        } else if (call.function.name === 'record_evidence') {
          const sourceEventId = await ensureLearnerEvent();
          const concept = String(args.concept ?? '').slice(0, 120);
          const observation = String(args.observation ?? '').slice(0, 500);
          const classification = ResponseTaxonomySchema.safeParse(args.classification).success
            ? args.classification as ResponseTaxonomy
            : 'uncertain_or_ambiguous';
          if (concept && observation) {
            const stored = await repo.addFallbackEvidence(identity, {
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
            await repo.addFallbackEvent(identity, 'evidence', { evidenceId: stored.evidenceId, concept, verdict: stored.verdict });
            await emit('evidence', { entry: stored });
            lessonState = reduceLesson(lessonState, { type: 'ASSESSED', classification, evidenceId: stored.evidenceId });
            output = { ok: true, evidenceId: stored.evidenceId };
          }
        } else if (call.function.name === 'update_lesson_state') {
          const state = {
            activeConcept: String(args.active_concept ?? '').slice(0, 160),
            strategy: args.strategy ? String(args.strategy).slice(0, 160) : undefined,
            nextStep: args.next_step ? String(args.next_step).slice(0, 240) : undefined,
          };
          if (state.activeConcept) {
            await ensureLearnerEvent();
            await repo.addFallbackEvent(identity, 'lesson_state', state);
            await emit('lesson_state', { state });
            output = { ok: true };
          } else output = { ok: false, error: 'active_concept is required' };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      }

      if (message.tool_calls?.length) continue;
      const delivered = message.content?.trim() ?? '';
      if (/[?？]\s*$/.test(delivered)) {
        lessonState = reduceLesson(lessonState, { type: 'QUESTION_DELIVERED', taskId: `fallback-question-${request.turnId}`, text: delivered });
        break;
      }
      // Explanations are allowed to end without an injected question; only a
      // promised-but-undelivered question move earns one bounded continuation.
      const handoff = responseHandoff(lessonState, delivered);
      if (handoff === 'wait') break;
      lessonState = { ...lessonState, continuationAttempts: lessonState.continuationAttempts + 1 };
      messages.push({ role: 'system', content: 'You proposed asking a question but have not asked it yet. Ask that one short, concrete question or small task now, then wait.' });
    }
    await assertActive();
    if (!(await repo.finishFallbackTurn(identity, 'completed', steps))) throw abortError('superseded before completion');
    return steps;
  } catch (error) {
    const aborted = signal.aborted || !(await repo.isFallbackTurnActive(identity));
    await repo.finishFallbackTurn(identity, aborted ? 'cancelled' : 'failed');
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
