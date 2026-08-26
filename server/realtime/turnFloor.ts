import type { CoordinatorContext, ResponseCreateSource } from './coordinatorContext.js';

/**
 * Turn and floor coordination: the single owner of `response.create`.
 *
 * Semantic VAD only chunks and transcribes speech (`create_response: false`);
 * every model response is created here, keyed and idempotent, and never
 * while the learner is composing a drawing draft.
 */

/** Stop auto-continuing tool chains after this many rounds per turn. */
export const MAX_TOOL_CONTINUES = 14;

/** Every `response.create` flows through here so the coordinator always
 * knows whether one is in flight (the storyboard runner must never race a
 * learner-turn response with a narration beat). Optional per-response
 * params carry beat-scoped `instructions` and `max_output_tokens`. */
export function sendResponseCreate(
  ctx: CoordinatorContext,
  source: ResponseCreateSource,
  response?: { instructions: string; max_output_tokens?: number },
): void {
  ctx.state.lastCreateSource = source;
  ctx.state.pendingResponseCreates += 1;
  ctx.sendUpstream({ type: 'response.create', ...(response ? { response } : {}) });
}

export function noteResponseCreateSettled(ctx: CoordinatorContext): void {
  ctx.state.pendingResponseCreates = Math.max(0, ctx.state.pendingResponseCreates - 1);
}

/**
 * True when the tutor genuinely holds a quiet floor: nobody is speaking or
 * composing, no response is active or being created, and no delivered task
 * is awaiting the learner. The storyboard runner schedules beats and
 * recovery responses only through this gate.
 */
export function tutorFloorIsFree(ctx: CoordinatorContext): boolean {
  const { state } = ctx;
  return !state.childHoldsFloor &&
    !state.draftOpen &&
    !state.speechInProgress &&
    state.activeResponseId === null &&
    state.pendingResponseCreates === 0 &&
    state.lessonState.phase !== 'AWAIT_LEARNER';
}

export function requestModelResponse(
  ctx: CoordinatorContext,
  source: Exclude<ResponseCreateSource, 'tool' | 'beat'>,
  key: string,
): boolean {
  const { state } = ctx;
  if (state.usedResponseKeys.has(key)) return false;
  if (source !== 'user' && state.draftOpen) return false;
  state.usedResponseKeys.add(key);
  if (state.usedResponseKeys.size > 512) state.usedResponseKeys.delete(state.usedResponseKeys.values().next().value as string);
  state.childHoldsFloor = false;
  state.toolContinues = 0;
  // A genuine learner turn starts the next teaching turn: the one-plan
  // visual budget and the erase guard reset here and nowhere else, and any
  // in-flight asynchronous visual work becomes stale (its completion is
  // abandoned explicitly rather than built mid-turn).
  state.visualRequestEpoch += 1;
  state.planStagedThisTurn = false;
  state.planAttemptsThisTurn = 0;
  if (state.visualPlanState !== 'rendering') state.visualPlanState = 'none';
  state.objectsCreatedThisTurn = new Set();
  sendResponseCreate(ctx, source);
  return true;
}

/**
 * Reports a tool result and lets the model keep talking — unless the
 * child has already interrupted this response, in which case the child
 * holds the floor and the model must wait for them. A storyboard-bearing
 * acceptance suppresses the continuation deliberately: the runner owns the
 * next responses (the narration beats), so free continuation speech would
 * narrate a scene that is not visible yet.
 */
export function finishTool(
  ctx: CoordinatorContext,
  callId: string,
  responseId: string,
  output: unknown,
  options: { continueResponse?: boolean } = {},
): void {
  const { state } = ctx;
  ctx.sendUpstream({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
  });
  if (options.continueResponse === false) return;
  if (state.cancelledResponses.has(responseId) || state.childHoldsFloor) return;
  if (state.storyboardRun) return;
  if (state.toolContinues >= MAX_TOOL_CONTINUES) return;
  // Creating a follow-up while the "okay" response is still active is
  // rejected by the provider (`conversation_already_has_active_response`)
  // and used to be dropped for tool-sourced creates — the learner heard
  // the acknowledgement, then silence. Wait for that response to finish,
  // and coalesce several tools from the same turn into one continuation.
  if (state.activeResponseId !== null || state.pendingResponseCreates > 0) {
    state.toolContinueAfterResponseId = state.activeResponseId ?? state.toolContinueAfterResponseId;
    state.lastCreateSource = 'tool';
    return;
  }
  state.toolContinues += 1;
  sendResponseCreate(ctx, 'tool');
}

export function setEndpointingEagerness(ctx: CoordinatorContext, eagerness: 'medium' | 'high'): void {
  if (ctx.state.endpointingEagerness === eagerness) return;
  ctx.state.endpointingEagerness = eagerness;
  ctx.sendUpstream({
    type: 'session.update',
    session: {
      type: 'realtime',
      audio: { input: { turn_detection: semanticTurnDetection(eagerness) } },
    },
  });
}

export function semanticTurnDetection(eagerness: 'medium' | 'high') {
  return {
    type: 'semantic_vad',
    eagerness,
    // The server-side coordinator is the only owner of response.create.
    // VAD still chunks and transcribes speech, but a drawing draft, a mixed
    // voice+drawing answer, and an explicit Done all decide response timing
    // deterministically rather than the provider.
    create_response: false,
    // Client-side sustained-speech confirmation owns cancellation; provider
    // VAD alone must not stop Noura on incidental noise.
    interrupt_response: false,
  } as const;
}
