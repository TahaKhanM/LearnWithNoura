import { DeliveredTaskSchema, type DeliveredTask } from '../../shared/lessonTurn.js';
import { reduceLesson, responseHandoff } from '../lesson/orchestrator.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { identityForResponse } from './responseRegistry.js';
import { recordTerminalResponseTelemetry } from './telemetryGlue.js';
import { handleToolCall } from './toolHandling.js';
import { requestModelResponse, setEndpointingEagerness } from './turnFloor.js';
import { replayBoard } from './sessionRestore.js';

/**
 * Dispatches one sideband provider event into the coordinator. Audio itself
 * never appears here: it flows browser ↔ provider on the WebRTC media plane.
 * The sideband carries transcripts, VAD, tool calls, and response lifecycle.
 */

export interface UpstreamEvent {
  type: string;
  [key: string]: unknown;
}

async function deliverTask(ctx: CoordinatorContext, responseId: string, task: DeliveredTask): Promise<void> {
  const { state } = ctx;
  ctx.sendClient({ type: 'learner_task', task, response_id: responseId }, identityForResponse(ctx, responseId), {
    ...(task.semanticGroupId ? { semanticObjectId: task.semanticGroupId } : {}),
  });
  await ctx.repo.addEvent(ctx.sessionId, 'learner_task', { task });
  try {
    state.lessonState = reduceLesson(state.lessonState, {
      type: 'QUESTION_DELIVERED', taskId: task.taskId, text: task.prompt, responseMode: task.responseMode,
    });
  } catch { /* the next deterministic decision will recover */ }
  // A short spoken answer should endpoint eagerly; drawing and typing turns
  // keep patient endpointing so the child can pause and think aloud.
  setEndpointingEagerness(ctx, task.responseMode === 'voice' ? 'high' : 'medium');
}

export async function handleUpstreamEvent(ctx: CoordinatorContext, event: UpstreamEvent): Promise<void> {
  const { state } = ctx;
  switch (event.type) {
    case 'session.updated': {
      if (!state.upstreamReady) {
        state.upstreamReady = true;
        await replayBoard(ctx);
        ctx.sendClient({ type: 'ready' });
      }
      break;
    }

    case 'response.created': {
      // Responses are only created by the deterministic coordinator
      // (requestModelResponse / finishTool), which already owns the floor.
      // A response starting therefore never *changes* floor ownership here.
      // High eagerness is a one-turn accelerator (barge-in or a delivered
      // voice question). Ordinary turns retain medium semantic endpointing
      // so a child can pause and think.
      setEndpointingEagerness(ctx, 'medium');
      const response = event.response as { id?: string } | undefined;
      if (response?.id && state.clientIdentity) {
        state.activeResponseId = response.id;
        state.responseIdentities.set(response.id, { ...state.clientIdentity });
      }
      ctx.sendClient({ type: 'response_started', response_id: response?.id }, identityForResponse(ctx, response?.id));
      break;
    }

    case 'response.output_audio_transcript.delta': {
      const responseId = String(event.response_id ?? '');
      if (!responseId || state.cancelledResponses.has(responseId) || typeof event.delta !== 'string') break;
      if (typeof event.item_id === 'string' && event.item_id) {
        state.responseItems.set(responseId, event.item_id);
        if (state.responseItems.size > 64) {
          state.responseItems.delete(state.responseItems.keys().next().value as string);
        }
      }
      // Captions release on arrival in the client, paced against the actual
      // playback boundaries the browser observes on its data channel.
      ctx.sendClient({
        type: 'transcript_delta',
        delta: event.delta,
        response_id: responseId,
        item_id: event.item_id,
      }, identityForResponse(ctx, responseId));
      break;
    }

    case 'response.output_audio_transcript.done': {
      const text = String(event.transcript ?? '');
      const responseId = String(event.response_id ?? '');
      if (state.cancelledResponses.has(responseId)) break;
      if (text.trim()) await ctx.repo.addEvent(ctx.sessionId, 'tutor_said', { text });
      if (typeof event.response_id === 'string') state.responseTranscript.set(event.response_id, text);
      if (text.trim()) {
        ctx.sendClient({ type: 'transcript_done', text, response_id: responseId }, identityForResponse(ctx, responseId));
      }
      break;
    }

    case 'conversation.item.input_audio_transcription.completed': {
      const text = String(event.transcript ?? '').trim();
      if (text) {
        state.lastLearnerEventId = await ctx.repo.addEvent(ctx.sessionId, 'learner_said', { text });
        ctx.sendClient({ type: 'user_transcript', text });
        try { state.lessonState = reduceLesson(state.lessonState, { type: 'LEARNER_RESPONSE_RECEIVED' }); }
        catch { /* unsolicited learner turns are still valid input; the next move re-orients */ }
      }
      break;
    }

    case 'input_audio_buffer.speech_started':
      state.toolContinues = 0;
      state.childHoldsFloor = true;
      state.speechInProgress = true;
      ctx.sendClient({ type: 'speech_started' });
      break;

    case 'input_audio_buffer.speech_stopped':
      state.speechInProgress = false;
      ctx.sendClient({ type: 'speech_stopped', draft_open: state.draftOpen });
      // VAD no longer creates responses (`create_response: false`). A voice
      // turn completes here only when no drawing draft is open; while the
      // learner composes, their words accumulate as context for the one
      // response created by their explicit Done.
      if (!state.draftOpen) {
        state.childHoldsFloor = false;
        requestModelResponse(ctx, 'voice', `voice-turn-${++state.voiceTurnCounter}`);
      }
      break;

    case 'response.function_call_arguments.done': {
      await handleToolCall(
        ctx,
        String(event.name ?? ''),
        String(event.arguments ?? '{}'),
        String(event.call_id ?? ''),
        String(event.response_id ?? ''),
      );
      break;
    }

    case 'response.done': {
      const response = event.response as
        | { id?: string; status?: string; output?: { type: string }[]; usage?: unknown }
        | undefined;
      const status = response?.status ?? 'unknown';
      if (status === 'cancelled' && response?.id) state.cancelledResponses.add(response.id);
      const responseIdentity = identityForResponse(ctx, response?.id);
      recordTerminalResponseTelemetry(ctx, response, status);
      const hasFunctionCall = response?.output?.some((item) => item.type === 'function_call') ?? false;
      const delivered = response?.id ? (state.responseTranscript.get(response.id) ?? '') : '';
      // Explicit handoff: a task proposed via propose_teaching_move is
      // delivered once the model finishes speaking it — question mark or
      // imperative alike. The client shows the task banner when playback of
      // this response actually finishes.
      if (status === 'completed' && response?.id && !state.cancelledResponses.has(response.id) &&
          state.pendingDeliveredTask && (delivered.trim() || !hasFunctionCall)) {
        const task = state.pendingDeliveredTask;
        state.pendingDeliveredTask = null;
        await deliverTask(ctx, response.id, task);
      } else if (status === 'completed' && response?.id && !hasFunctionCall && !state.cancelledResponses.has(response.id)) {
        if (/[?？]\s*$/.test(delivered.trim())) {
          // A spoken question without a structured move still yields the
          // floor as a voice-mode task.
          const task: DeliveredTask = DeliveredTaskSchema.parse({
            taskId: `question-${response.id}`,
            prompt: delivered.trim().slice(0, 500),
            responseMode: 'voice',
            submitPolicy: 'vad',
          });
          await deliverTask(ctx, response.id, task);
        } else if (responseHandoff(state.lessonState, delivered) === 'bounded_continuation' && !state.childHoldsFloor) {
          // Only a promised-but-undelivered question move continues.
          // Explanations are allowed to end without an injected question.
          state.lessonState = { ...state.lessonState, continuationAttempts: state.lessonState.continuationAttempts + 1 };
          ctx.sendUpstream({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [{
                type: 'input_text',
                text: 'You proposed asking a question but have not asked it yet. Ask that one short, concrete question or small task now, then wait.',
              }],
            },
          });
          state.lastCreateSource = 'tool';
          ctx.sendUpstream({ type: 'response.create' });
        }
      }
      ctx.sendClient({ type: 'response_done', response_id: response?.id, status }, responseIdentity);
      if (response?.id === state.activeResponseId) state.activeResponseId = null;
      if (state.retryCreateOnDone) {
        // The child asked something while a response was still running;
        // their question must not be dropped.
        state.retryCreateOnDone = false;
        ctx.sendUpstream({ type: 'response.create' });
      }
      break;
    }

    case 'error': {
      const error = event.error as { message?: string; code?: string } | undefined;
      // Expected races, harmless: cancelling a turn that just finished, or
      // continuing after a tool call when VAD already started a response.
      const alreadyActive =
        error?.code === 'conversation_already_has_active_response' ||
        /active response in progress/i.test(error?.message ?? '');
      if (alreadyActive && ['user', 'board', 'voice'].includes(state.lastCreateSource)) state.retryCreateOnDone = true;
      const benign = error?.code === 'response_cancel_not_active' || alreadyActive;
      ctx.log(`session ${ctx.sessionId}: upstream error ${JSON.stringify(event.error).slice(0, 300)}`);
      if (!benign) {
        ctx.sendClient({ type: 'error', message: 'Noura hit a snag — it will recover in a moment.' });
      }
      break;
    }

    default:
      break;
  }
}
