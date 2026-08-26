import type { RuntimeEventEnvelope } from '../../shared/runtimeProtocol.js';
import { MetricInputSchema, TELEMETRY_SCHEMA_VERSION } from '../../shared/sessionTelemetry.js';
import { BoardSubmissionSchema } from '../../shared/lessonTurn.js';
import { evaluateManipulativeCheck } from '../../shared/manipulativeCheck.js';
import { reduceLesson } from '../lesson/orchestrator.js';
import { metricContextFromIdentity } from '../session/telemetryRecorder.js';
import { loadReleasedBoardContext } from './boardContext.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { addBounded, identityForResponse } from './responseRegistry.js';
import { refreshBoardInstructions } from './sessionConfig.js';
import { conversationContext, learnerBoardOps, safeBoardImage } from './sessionRestore.js';
import { advanceStoryboardRun, pauseStoryboardRun } from './storyboardRunner.js';
import { isAllowedClientMetric, MAX_PENDING_VOICE_BARGE_INS, recordClientPlaybackStop, trustedClientResponseId } from './telemetryGlue.js';
import { requestModelResponse, setEndpointingEagerness } from './turnFloor.js';

/** Dispatches one accepted browser envelope into the coordinator. */

export interface ClientMessage {
  type: string;
  [key: string]: unknown;
}

export async function handleClientEvent(
  ctx: CoordinatorContext,
  message: ClientMessage,
  envelope: RuntimeEventEnvelope,
): Promise<void> {
  const { state } = ctx;
  switch (message.type) {
    case 'start': {
      if (state.started) break;
      state.started = true;
      state.toolContinues = 0;
      const resume = await conversationContext(ctx);
      if (resume) {
        ctx.sendUpstream({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: resume }],
          },
        });
      }
      const startEventId = await ctx.repo.addEvent(ctx.sessionId, 'session_started', {
        resumed: Boolean(resume),
        connectionEpoch: envelope.connectionEpoch,
      });
      requestModelResponse(ctx, 'start', 'session-start');
      const historyTask = ctx.telemetryRepo
        .hasPriorReleasedSessionStart(ctx.sessionId, startEventId)
        .then((hadPriorStart) => {
          if (!hadPriorStart) return;
          ctx.telemetryWriter.submit({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            name: 'session_reconnect',
            unit: 'count',
            value: 1,
          }, metricContextFromIdentity(envelope));
        })
        .catch(() => {
          ctx.telemetryWriter.submit({
            schemaVersion: TELEMETRY_SCHEMA_VERSION,
            name: 'telemetry_gap',
            unit: 'count',
            value: 1,
            dimensions: { reason: 'server_history_failure' },
          }, metricContextFromIdentity(envelope));
        });
      ctx.trackTelemetry(historyTask);
      break;
    }

    case 'user_text': {
      const text = String(message.text ?? '').trim().slice(0, 2000);
      if (!text) break;
      const idempotencyKey = String(message.idempotencyKey ?? '').slice(0, 200);
      if (idempotencyKey.length < 8 || state.seenIdempotencyKeys.has(idempotencyKey)) break;
      state.seenIdempotencyKeys.add(idempotencyKey);
      if (state.seenIdempotencyKeys.size > 500) state.seenIdempotencyKeys.delete(state.seenIdempotencyKeys.values().next().value as string);
      state.toolContinues = 0;
      state.childHoldsFloor = false;
      state.lastLearnerEventId = await ctx.repo.addEvent(ctx.sessionId, 'learner_said', { text, via: 'text' });
      ctx.sendClient({ type: 'user_transcript', text });
      try { state.lessonState = reduceLesson(state.lessonState, { type: 'LEARNER_RESPONSE_RECEIVED' }); }
      catch { /* unsolicited typed turns are still valid input */ }
      ctx.sendUpstream({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      });
      requestModelResponse(ctx, 'user', `user-text-${idempotencyKey}`);
      break;
    }

    case 'interrupt': {
      // The client already stopped local playback (data-channel clear plus
      // muting the remote track); make the model stop too, and keep tool
      // chains from restarting it while the child speaks.
      const interruptedResponseId = state.activeResponseId;
      const interruptedIdentity = interruptedResponseId
        ? identityForResponse(ctx, interruptedResponseId)
        : null;
      const recordVoiceGate = message.reason === 'voice' &&
        interruptedResponseId !== null &&
        interruptedIdentity !== null &&
        !state.pendingVoiceBargeInResponses.has(interruptedResponseId);
      if (recordVoiceGate) {
        addBounded(
          state.pendingVoiceBargeInResponses,
          interruptedResponseId,
          MAX_PENDING_VOICE_BARGE_INS,
        );
      }
      state.childHoldsFloor = true;
      if (state.activeResponseId) state.cancelledResponses.add(state.activeResponseId);
      // A barge-in mid-storyboard cancels the current beat via the ordinary
      // generation machinery below; the runner pauses and later resumes at
      // the first unrevealed step. Revealed objects stay visible.
      pauseStoryboardRun(ctx);
      state.lessonState = reduceLesson(state.lessonState, { type: 'INTERRUPTED' });
      if (message.reason === 'voice') setEndpointingEagerness(ctx, 'high');
      ctx.sendUpstream({ type: 'response.cancel' });
      // Truthful truncation: the browser reports how much it actually played
      // before stopping; the conversation item is looked up server-side so
      // the model's memory matches what the child heard.
      const heardMs = typeof message.heardMs === 'number' && Number.isFinite(message.heardMs)
        ? Math.max(0, Math.floor(message.heardMs))
        : null;
      const interruptedItemId = interruptedResponseId
        ? state.responseItems.get(interruptedResponseId)
        : undefined;
      if (heardMs !== null && interruptedItemId) {
        ctx.sendUpstream({
          type: 'conversation.item.truncate',
          item_id: interruptedItemId,
          content_index: 0,
          audio_end_ms: heardMs,
        });
        await ctx.repo.addEvent(ctx.sessionId, 'interrupted', { audio_end_ms: heardMs });
      }
      if (recordVoiceGate) {
        ctx.telemetryWriter.submit({
          schemaVersion: TELEMETRY_SCHEMA_VERSION,
          name: 'barge_in_gate_outcome',
          unit: 'count',
          value: 1,
          dimensions: { outcome: 'confirmed' },
        }, metricContextFromIdentity(interruptedIdentity, interruptedResponseId));
      }
      break;
    }

    case 'playback_boundary': {
      // The browser relays output_audio_buffer boundaries from its WebRTC
      // data channel; `stopped` carries the played duration for telemetry.
      if (message.boundary === 'stopped') recordClientPlaybackStop(ctx, message);
      break;
    }

    case 'draft_state': {
      // The learner opened or closed a drawing draft. While a draft is
      // open nothing may auto-create a response; pauses between strokes
      // belong to the learner.
      const draftId = String(message.draftId ?? '').slice(0, 160);
      const open = message.open === true;
      if (!draftId) break;
      if (state.draftOpen !== open) {
        state.draftOpen = open;
        await ctx.repo.addEvent(ctx.sessionId, 'learner_draft', { draftId, open });
        // A cancelled draft frees the floor without a learner turn; a
        // paused storyboard build may continue.
        if (!open) advanceStoryboardRun(ctx);
      }
      break;
    }

    case 'board_submission': {
      // The learner pressed Done (or explicitly finished): one frozen,
      // idempotent submission, one persisted learner event, one response.
      const parsedSubmission = BoardSubmissionSchema.safeParse(message);
      if (!parsedSubmission.success) {
        ctx.sendClient({ type: 'board_submission_error', submissionId: String(message.submissionId ?? ''), reason: 'The submission was malformed. Your drawing is still on the board — press Done to try again.' });
        break;
      }
      const submission = parsedSubmission.data;
      if (state.respondedSubmissionIds.has(submission.submissionId)) {
        ctx.sendClient({ type: 'board_submission_ack', submissionId: submission.submissionId, duplicate: true });
        break;
      }
      const description = submission.description.trim().slice(0, 4000);
      const ops = learnerBoardOps(submission.ops, {
        manipulativeTargetIds: state.boardContext.learnerUpdatableManipulativeIds(),
      });
      const imageDataUrl = safeBoardImage(submission.imageDataUrl);
      const analysis = submission.analysis ?? null;
      const manipulativeCheck = submission.manipulativeCheck ?? null;
      state.boardContext.apply(ops, 'learner', submission.semanticGroupId, submission.semanticGroupLabel);
      const manipulativeResult = manipulativeCheck
        ? evaluateManipulativeCheck({
          check: manipulativeCheck,
          items: state.boardContext.manipulativeSceneItems(),
        })
        : null;
      if (!description && ops.length === 0 && !manipulativeResult) {
        ctx.sendClient({ type: 'board_submission_ack', submissionId: submission.submissionId, empty: true });
        break;
      }
      state.respondedSubmissionIds.add(submission.submissionId);
      state.draftOpen = false;
      const eventId = await ctx.repo.addEvent(ctx.sessionId, 'learner_board', {
        description,
        ops,
        submissionId: submission.submissionId,
        draftId: submission.draftId,
        hasVisualContext: Boolean(imageDataUrl),
        baseBoardRevision: submission.baseBoardRevision,
        submittedBoardRevision: submission.submittedBoardRevision,
        ...(submission.taskId ? { taskId: submission.taskId } : {}),
        ...(submission.semanticGroupId ? { semanticObjectId: submission.semanticGroupId } : {}),
        ...(submission.semanticGroupLabel ? { groupLabel: submission.semanticGroupLabel } : {}),
        ...(analysis ? { analysis } : {}),
        ...(manipulativeCheck ? { manipulativeCheck } : {}),
        ...(manipulativeResult ? { manipulativeResult, localCheckPassed: manipulativeResult.passed } : {}),
      });
      // Evidence recorded for this answer cites the board event itself.
      state.lastLearnerEventId = eventId;
      if (analysis) state.boardContext.observeLearnerAnalysis(analysis);
      refreshBoardInstructions(ctx);
      try { state.lessonState = reduceLesson(state.lessonState, { type: 'LEARNER_RESPONSE_RECEIVED' }); }
      catch { /* a spontaneous drawing outside a task is still valid input */ }
      const content: Array<Record<string, unknown>> = [{
        type: 'input_text',
        text: [
          '[The learner finished a drawing on the shared board and pressed Done. This is their complete submitted answer, not a partial stroke.]',
          submission.taskId ? `It answers task ${submission.taskId}.` : '',
          description,
          manipulativeResult
            ? `Local manipulative check (${manipulativeResult.predicate} on ${manipulativeResult.targetId}): ${manipulativeResult.passed ? 'passed' : 'not yet correct'}. ${manipulativeResult.summary}`
            : '',
          analysis ? `Deterministic vector analysis (spatial hints, not meaning): ${analysis.summary}` : '',
          imageDataUrl
            ? 'Use the attached full-board/detail image to interpret the drawing. If its meaning is ambiguous, ask the learner rather than guessing.'
            : 'No image is attached; rely on the vector analysis and board state. If the meaning is ambiguous, ask the learner rather than guessing.',
        ].filter(Boolean).join(' '),
      }];
      if (imageDataUrl) content.push({ type: 'input_image', image_url: imageDataUrl, detail: 'high' });
      ctx.sendUpstream({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content,
        },
      });
      ctx.sendClient({ type: 'board_submission_ack', submissionId: submission.submissionId });
      // Mixed voice+drawing: if the learner is mid-utterance, speech stop
      // completes the turn with this drawing already in context — still
      // exactly one response.
      if (!state.speechInProgress) requestModelResponse(ctx, 'board', submission.submissionId);
      break;
    }

    case 'visual_preflight_result': {
      const preflightId = String(message.preflight_id ?? '');
      const resolver = state.pendingPreflights.get(preflightId);
      if (resolver) resolver({
        accepted: message.accepted === true,
        reasons: Array.isArray(message.reasons) ? message.reasons.filter((reason): reason is string => typeof reason === 'string').map((reason) => reason.slice(0, 200)).slice(0, 8) : [],
      });
      break;
    }

    case 'ops_shown': {
      // The child has actually seen this batch; it is now part of the board.
      if (typeof message.event_id === 'number') {
        await ctx.repo.markEventReleased(ctx.sessionId, message.event_id);
        const pending = state.pendingBoardOps.get(message.event_id);
        if (pending) {
          if (pending.replacesGroup) state.boardContext.applyReplacement(pending.ops, pending.replacesGroup, pending.groupLabel);
          else state.boardContext.apply(pending.ops, 'tutor', pending.semanticGroupId, pending.groupLabel);
          state.pendingBoardOps.delete(message.event_id);
        } else {
          // Covers acknowledgement after an unusual connection handoff.
          state.boardContext = await loadReleasedBoardContext(ctx.repo, ctx.sessionId);
        }
        refreshBoardInstructions(ctx);
        // The visibility barrier: a staged plan's tool result waits here.
        state.pendingVisibility.get(message.event_id)?.(true);
      }
      break;
    }

    case 'ops_rejected': {
      const eventId = typeof message.event_id === 'number' ? message.event_id : null;
      if (eventId !== null) {
        state.pendingBoardOps.delete(eventId);
        state.pendingVisibility.get(eventId)?.(false);
      }
      const reason = String(message.reason ?? 'The board checkpoint failed client layout validation.').slice(0, 300);
      await ctx.repo.addEvent(ctx.sessionId, 'board_rejected', { eventId, reason });
      state.boardContext.observeBoardRejection(reason);
      refreshBoardInstructions(ctx);
      ctx.sendUpstream({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{
            type: 'input_text',
            text: `[Board checkpoint rejected by deterministic layout validation.] ${reason} Inspect the visible board, simplify the visual, and reuse existing objects. Do not refer to the rejected marks as visible.`,
          }],
        },
      });
      break;
    }

    case 'metric': {
      const metric = MetricInputSchema.safeParse(envelope.payload);
      if (!metric.success || !isAllowedClientMetric(metric.data)) break;
      const trustedResponseId = trustedClientResponseId(ctx, metric.data, envelope);
      if (metric.data.name === 'board_reveal_to_narration' && !trustedResponseId) {
        break;
      }
      ctx.telemetryWriter.submit(
        metric.data,
        metricContextFromIdentity(envelope, trustedResponseId),
      );
      break;
    }

    default:
      break;
  }
}
