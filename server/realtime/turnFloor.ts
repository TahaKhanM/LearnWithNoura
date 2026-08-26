import type { CoordinatorContext, ResponseCreateSource } from './coordinatorContext.js';

/**
 * Turn and floor coordination: the single owner of `response.create`.
 *
 * Semantic VAD only chunks and transcribes speech (`create_response: false`);
 * every model response is created here, keyed and idempotent, and never
 * while the learner is composing a drawing draft.
 */

/** Stop auto-continuing tool chains after this many rounds per turn. */
const MAX_TOOL_CONTINUES = 14;

export function requestModelResponse(
  ctx: CoordinatorContext,
  source: Exclude<ResponseCreateSource, 'tool'>,
  key: string,
): boolean {
  const { state } = ctx;
  if (state.usedResponseKeys.has(key)) return false;
  if (source !== 'user' && state.draftOpen) return false;
  state.usedResponseKeys.add(key);
  if (state.usedResponseKeys.size > 512) state.usedResponseKeys.delete(state.usedResponseKeys.values().next().value as string);
  state.childHoldsFloor = false;
  state.toolContinues = 0;
  state.lastCreateSource = source;
  // A genuine learner turn starts the next teaching turn: the one-plan
  // visual budget and the erase guard reset here and nowhere else.
  state.planStagedThisTurn = false;
  state.planAttemptsThisTurn = 0;
  if (state.visualPlanState !== 'rendering') state.visualPlanState = 'none';
  state.objectsCreatedThisTurn = new Set();
  ctx.sendUpstream({ type: 'response.create' });
  return true;
}

/**
 * Reports a tool result and lets the model keep talking — unless the
 * child has already interrupted this response, in which case the child
 * holds the floor and the model must wait for them.
 */
export function finishTool(ctx: CoordinatorContext, callId: string, responseId: string, output: unknown): void {
  const { state } = ctx;
  ctx.sendUpstream({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
  });
  if (state.cancelledResponses.has(responseId) || state.childHoldsFloor) return;
  if (state.toolContinues >= MAX_TOOL_CONTINUES) return;
  state.toolContinues += 1;
  state.lastCreateSource = 'tool';
  ctx.sendUpstream({ type: 'response.create' });
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
