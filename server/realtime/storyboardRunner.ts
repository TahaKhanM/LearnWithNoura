import type { BoardOp } from '../../shared/boardOps.js';
import { TELEMETRY_SCHEMA_VERSION } from '../../shared/sessionTelemetry.js';
import { metricContextFromIdentity } from '../session/telemetryRecorder.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { addBounded } from './responseRegistry.js';
import { sendResponseCreate, tutorFloorIsFree } from './turnFloor.js';
import { recordVisualSceneComplete } from './visualTelemetry.js';

/**
 * The interleaved reveal-narrate engine. One runner plays ANY storyboard —
 * the compiled anchor scene or a Director-authored scene — as: reveal step k
 * at a playback boundary → narrate it with a beat response (`response.create`
 * with per-response instructions and a token cap) → reveal step k+1 when that
 * narration has audibly finished.
 *
 * The server never tracks playback itself: each step cue is tagged with the
 * response whose playback boundary should release it, and the client's cue
 * timeline (the Phase 1 machinery) holds it until that response stops
 * playing. Forward progress is driven purely by `ops_shown` confirmations,
 * so the fail-closed visibility barrier and the released-events ledger keep
 * working unchanged. Beats are tutor-floor continuations: they never flip
 * floor or handoff state. After the last beat, one ordinary (unmarked)
 * handoff response delivers the stage's check/task through the existing
 * delivered-task contract.
 */

const MAX_TRACKED_BEATS = 64;
/** Narration beats are one or two sentences; cap runaway generations while
 * leaving room for audio tokens. The closing handoff response is uncapped
 * because it must finish a tool call plus the spoken task. */
const BEAT_MAX_OUTPUT_TOKENS = 1_200;

export type StoryboardSource = 'anchor' | 'director';

export interface StoryboardRunStep {
  id: string;
  reveal: string;
  narration: string;
  objectIds: string[];
  ops: BoardOp[];
}

export interface StoryboardRunState {
  runId: string;
  source: StoryboardSource;
  groupId: string;
  groupLabel: string;
  steps: StoryboardRunStep[];
  /** Steps confirmed visible on the learner's screen (ops_shown). */
  revealedSteps: number;
  /** Steps whose narration beat has been created. */
  narratedSteps: number;
  /** A beat/handoff response.create is in flight, awaiting response.created. */
  beatCreateInFlight: boolean;
  /** The step the in-flight beat narrates; null means the closing handoff. */
  pendingBeatStepIndex: number | null;
  /** The created closing-handoff response. The run stays open until this
   * response terminates: a create-rejection or a barge-in cancellation must
   * still have a runner left to retry the handoff. */
  handoffResponseId: string | null;
  /** The learner took the floor after the beat create was sent. */
  cancelPendingBeat: boolean;
  /** The persisted event id of the step cue awaiting ops_shown. */
  pendingStepEventId: number | null;
  /** Reserves step creation across the repository await so append/advance
   * cannot enqueue the same step twice. */
  stepCueCreateInFlight: boolean;
  /** The pending cue may have been dropped by an interruption. */
  needsResend: boolean;
  stepTimer: ReturnType<typeof setTimeout> | null;
  /** Framing lines prepended to the next beat (resume, announcements). */
  nextBeatFraming: string[];
  /** Instruction lines for the final beat's handoff duty. */
  handoff: string;
  /** Server wall-clock start of the accepted visual intent. Restored runs
   * omit it rather than reporting a reconnect-relative latency. */
  visualIntentStartedAtMs: number | null;
  firstPaintRecorded: boolean;
  sceneCompleteRecorded: boolean;
  /** True while the Director may append more validated steps. Reaching the
   * current step count cannot create the closing handoff until intake closes. */
  streamOpen: boolean;
  /** Per-run write tail. Progress events must reach durable storage in the
   * same order they were decided, especially terminal abandonment. */
  progressWrite: Promise<void>;
}

export interface StoryboardRunInput {
  runId: string;
  source: StoryboardSource;
  groupId: string;
  groupLabel: string;
  steps: StoryboardRunStep[];
  /** The response whose playback boundary releases the first reveal; null
   * defers the first reveal until the floor is free. */
  revealAfterResponseId: string | null;
  firstBeatFraming?: string[];
  handoff: string;
  /** Steps already confirmed visible (reconnect restoration). */
  alreadyRevealedSteps?: number;
  /** Hold the run until the next response resolves (reconnect: the resume
   * greeting speaks first; the build continues at its playback boundary). */
  startPaused?: boolean;
  /** Captured before anchor preflight or Director composition begins. */
  visualIntentStartedAtMs?: number;
  streamOpen?: boolean;
}

/** Derives runnable steps from any anchor-shaped scene (compiled anchor or
 * Director output): each step carries the add operations it reveals. */
export function storyboardRunSteps(scene: { ops: BoardOp[]; storyboard: ReadonlyArray<{ id: string; reveal: string; narration: string; objectIds: string[] }> }): StoryboardRunStep[] {
  const addOps = scene.ops.filter((op) => op.op === 'add');
  return scene.storyboard.map((step) => ({
    id: step.id,
    reveal: step.reveal,
    narration: step.narration,
    objectIds: step.objectIds,
    ops: addOps.filter((op) => step.objectIds.includes(op.id)),
  }));
}

export function startStoryboardRun(ctx: CoordinatorContext, input: StoryboardRunInput): void {
  const revealed = Math.min(input.alreadyRevealedSteps ?? 0, input.steps.length);
  const run: StoryboardRunState = {
    runId: input.runId,
    source: input.source,
    groupId: input.groupId,
    groupLabel: input.groupLabel,
    steps: input.steps,
    revealedSteps: revealed,
    narratedSteps: revealed,
    beatCreateInFlight: false,
    pendingBeatStepIndex: null,
    handoffResponseId: null,
    cancelPendingBeat: false,
    pendingStepEventId: null,
    stepCueCreateInFlight: false,
    needsResend: false,
    stepTimer: null,
    nextBeatFraming: [...(input.firstBeatFraming ?? [])],
    handoff: input.handoff,
    visualIntentStartedAtMs: input.visualIntentStartedAtMs ?? null,
    firstPaintRecorded: false,
    sceneCompleteRecorded: false,
    streamOpen: input.streamOpen ?? false,
    progressWrite: Promise.resolve(),
  };
  ctx.state.storyboardRun = run;
  persistProgress(ctx, run, 'active');
  if (run.steps.length === 0 && !run.streamOpen) {
    completeStoryboardRun(ctx, 'completed');
    return;
  }
  if (input.startPaused) return;
  if (run.revealedSteps >= run.steps.length && !run.streamOpen) {
    // Everything was revealed before this (re)start — a reconnect landed in
    // the handoff window. The closing handoff must still be delivered.
    advanceStoryboardRun(ctx);
    return;
  }
  if (input.revealAfterResponseId !== null) {
    ctx.trackSideEffect(sendStepCue(ctx, input.revealAfterResponseId));
    return;
  }
  // No boundary to bind to yet: the first reveal waits for a free floor.
  advanceStoryboardRun(ctx);
}

export function appendIncrementalStoryboardStepState(
  run: StoryboardRunState,
  step: StoryboardRunStep,
): boolean {
  if (!run.streamOpen || run.steps.some((candidate) => candidate.id === step.id)) return false;
  const existingIds = new Set(run.steps.flatMap((candidate) => candidate.objectIds));
  if (step.objectIds.some((id) => existingIds.has(id))) return false;
  run.steps.push({
    ...step,
    objectIds: [...step.objectIds],
    ops: [...step.ops],
  });
  return true;
}

export function appendStoryboardRunStep(
  ctx: CoordinatorContext,
  runId: string,
  step: StoryboardRunStep,
): boolean {
  const run = ctx.state.storyboardRun;
  if (!run || run.runId !== runId || !appendIncrementalStoryboardStepState(run, step)) return false;
  persistProgress(ctx, run, 'active');
  advanceStoryboardRun(ctx);
  return true;
}

export function closeIncrementalStoryboardState(run: StoryboardRunState): boolean {
  if (!run.streamOpen || run.steps.length === 0) return false;
  run.streamOpen = false;
  return true;
}

export function closeStoryboardRunIntake(ctx: CoordinatorContext, runId: string): boolean {
  const run = ctx.state.storyboardRun;
  if (!run || run.runId !== runId || !closeIncrementalStoryboardState(run)) return false;
  if (run.revealedSteps === run.steps.length && !run.sceneCompleteRecorded) {
    run.sceneCompleteRecorded = true;
    recordVisualSceneComplete(ctx, run);
  }
  persistProgress(ctx, run, 'active');
  advanceStoryboardRun(ctx);
  return true;
}

/** The learner took the floor (confirmed interrupt or speech start): stop
 * scheduling, remember that a pending cue may have been dropped, and cancel
 * a beat whose creation is still in flight. Revealed objects stay visible —
 * permanence — and progress resumes after the learner's turn resolves. */
export function pauseStoryboardRun(ctx: CoordinatorContext): void {
  const run = ctx.state.storyboardRun;
  if (!run) return;
  clearStepTimer(run);
  if (run.pendingStepEventId !== null) run.needsResend = true;
  if (run.beatCreateInFlight) run.cancelPendingBeat = true;
  if (run.nextBeatFraming.length === 0) {
    run.nextBeatFraming.push(
      'You were interrupted while the picture was building and have just finished responding to the learner. Briefly reconnect to the build (for example “Back to our picture —”) before this beat.',
    );
  }
}

/**
 * Single scheduler evaluation. Called whenever the world may have changed
 * (a response finished, a step was confirmed, a draft closed). It creates
 * at most one beat or one reveal cue, and only while the tutor genuinely
 * holds a quiet floor.
 */
export function advanceStoryboardRun(ctx: CoordinatorContext): void {
  const run = ctx.state.storyboardRun;
  if (!run || run.beatCreateInFlight || run.stepCueCreateInFlight) return;
  // The closing handoff already exists: the run is waiting for it to
  // finish (noteStoryboardResponseDone completes or retries it).
  if (run.handoffResponseId !== null) return;
  if (!tutorFloorIsFree(ctx)) return;
  if (run.narratedSteps < run.revealedSteps) {
    createBeat(ctx, run.revealedSteps - 1);
    return;
  }
  if (run.revealedSteps >= run.steps.length) {
    if (run.streamOpen) return;
    // Everything is revealed and narrated: one ordinary handoff response
    // (never marked as a beat) delivers the stage's check/task through the
    // existing delivered-task contract.
    createHandoff(ctx);
    return;
  }
  if (run.pendingStepEventId !== null) {
    if (run.needsResend) {
      run.needsResend = false;
      resendPendingStepCue(ctx);
    }
    return;
  }
  ctx.trackSideEffect(sendStepCue(ctx, ctx.state.lastCompletedResponseId));
}

/** Matches a provider response to the beat/handoff creation in flight. */
export function noteStoryboardResponseCreated(ctx: CoordinatorContext, responseId: string): void {
  const { state } = ctx;
  const run = state.storyboardRun;
  if (!run || !run.beatCreateInFlight) return;
  run.beatCreateInFlight = false;
  const stepIndex = run.pendingBeatStepIndex;
  run.pendingBeatStepIndex = null;
  if (run.cancelPendingBeat || state.childHoldsFloor || state.speechInProgress) {
    // The learner took the floor while this beat was being created: it
    // must not speak over them. It is recreated on resume.
    run.cancelPendingBeat = false;
    state.cancelledResponses.add(responseId);
    ctx.sendUpstream({ type: 'response.cancel' });
    return;
  }
  if (stepIndex === null) {
    // The closing handoff response exists. The run stays open until it
    // FINISHES: if this create is later rejected or the response is
    // cancelled, the runner must still be there to retry the handoff.
    run.handoffResponseId = responseId;
    return;
  }
  addBounded(state.beatResponses, responseId, MAX_TRACKED_BEATS);
  run.narratedSteps = stepIndex + 1;
  // Pipelined reveal-at-playback-boundary: the next step's cue rides now,
  // tagged with this beat, and the client applies it exactly when this
  // beat's audio stops.
  if (run.revealedSteps < run.steps.length && run.pendingStepEventId === null) {
    ctx.trackSideEffect(sendStepCue(ctx, responseId));
  }
}

export function noteStoryboardResponseDone(ctx: CoordinatorContext, responseId: string | null, status: string): void {
  const run = ctx.state.storyboardRun;
  if (!run) return;
  if (responseId !== null && responseId === run.handoffResponseId) {
    if (status === 'completed') {
      completeStoryboardRun(ctx, 'completed');
      return;
    }
    // Cancelled, failed, or any other non-terminal-success: the stage check
    // was not delivered. Clear the id so the next quiet floor retries.
    run.handoffResponseId = null;
    return;
  }
  advanceStoryboardRun(ctx);
}

/** A beat's response.create failed (conversation already active): let the
 * next quiet floor recreate it instead of leaving the run stuck. */
export function noteStoryboardCreateRejected(ctx: CoordinatorContext): void {
  const run = ctx.state.storyboardRun;
  if (!run || !run.beatCreateInFlight) return;
  run.beatCreateInFlight = false;
  run.pendingBeatStepIndex = null;
  run.cancelPendingBeat = false;
}

/**
 * A confirmed barge-in advances the client's generation identity, so a step
 * cue re-sent before the first new-identity envelope arrived was rejected by
 * the client's gate. The identity change is that first envelope: re-send the
 * pending step under the fresh identity (applying the same board event twice
 * is idempotent on every layer).
 */
export function noteStoryboardClientIdentityChanged(ctx: CoordinatorContext): void {
  const run = ctx.state.storyboardRun;
  if (!run) return;
  if (run.pendingStepEventId !== null) run.needsResend = true;
  advanceStoryboardRun(ctx);
}

async function sendStepCue(ctx: CoordinatorContext, tagResponseId: string | null): Promise<void> {
  const { state } = ctx;
  const run = state.storyboardRun;
  if (!run || run.pendingStepEventId !== null || run.stepCueCreateInFlight || run.revealedSteps >= run.steps.length) return;
  run.stepCueCreateInFlight = true;
  const step = run.steps[run.revealedSteps];
  try {
    const eventId = await ctx.repo.addEvent(ctx.sessionId, 'semantic_scene', {
      ops: step.ops,
      checkpointId: step.id,
      reveal: step.reveal,
      semanticObjectId: run.groupId,
      groupLabel: run.groupLabel,
      runId: run.runId,
    }, false);
    if (state.storyboardRun !== run) return;
    run.pendingStepEventId = eventId;
    state.pendingBoardOps.set(eventId, { ops: step.ops, semanticGroupId: run.groupId, groupLabel: run.groupLabel });
    state.pendingVisibility.set(eventId, (shown) => {
      state.pendingVisibility.delete(eventId);
      ctx.trackSideEffect(onStepVisibility(ctx, run, eventId, shown));
    });
    for (const op of step.ops) if (op.op === 'add') state.objectsCreatedThisTurn.add(op.id);
    armStepTimer(ctx, run);
    const safeTag = tagResponseId && !state.cancelledResponses.has(tagResponseId) ? tagResponseId : null;
    sendCueEnvelope(ctx, run, step, eventId, safeTag);
  } catch (error) {
    if (state.storyboardRun === run) {
      ctx.log(`session ${ctx.sessionId}: storyboard step persistence failed ${String(error).slice(0, 200)}`);
      abandonStoryboardRun(ctx, { injectNote: true });
    }
  } finally {
    run.stepCueCreateInFlight = false;
  }
}

/** Re-sends the persisted pending step cue after an interruption dropped
 * it client-side. Applying the same event twice is idempotent. */
function resendPendingStepCue(ctx: CoordinatorContext): void {
  const { state } = ctx;
  const run = state.storyboardRun;
  if (!run || run.pendingStepEventId === null) return;
  const step = run.steps[run.revealedSteps];
  const tag = state.lastCompletedResponseId && !state.cancelledResponses.has(state.lastCompletedResponseId)
    ? state.lastCompletedResponseId
    : null;
  armStepTimer(ctx, run);
  sendCueEnvelope(ctx, run, step, run.pendingStepEventId, tag);
}

function sendCueEnvelope(
  ctx: CoordinatorContext,
  run: StoryboardRunState,
  step: StoryboardRunStep,
  eventId: number,
  tagResponseId: string | null,
): void {
  // Runner cues always ride the CURRENT client identity: after an
  // interruption the client's generation moved on, and an old response's
  // identity would be rejected by the client gate. The response tag only
  // decides which playback boundary releases the reveal.
  ctx.sendClient({
    type: 'board_ops',
    ops: step.ops,
    ...(tagResponseId ? { response_id: tagResponseId } : {}),
    event_id: eventId,
    groupLabel: run.groupLabel,
    checkpoint: step.reveal,
    await_narration: true,
  }, ctx.state.clientIdentity, {
    visualCueId: step.id,
    semanticObjectId: run.groupId,
  });
}

async function onStepVisibility(ctx: CoordinatorContext, run: StoryboardRunState, eventId: number, shown: boolean): Promise<void> {
  if (ctx.state.storyboardRun !== run || run.pendingStepEventId !== eventId) return;
  clearStepTimer(run);
  run.pendingStepEventId = null;
  run.needsResend = false;
  if (!shown) {
    // The client already recorded the rejection and injected the honest
    // system note (ops_rejected); the runner just stops cleanly.
    abandonStoryboardRun(ctx, { injectNote: false });
    return;
  }
  run.revealedSteps += 1;
  if (!run.streamOpen && run.revealedSteps === run.steps.length && !run.sceneCompleteRecorded) {
    run.sceneCompleteRecorded = true;
    recordVisualSceneComplete(ctx, run);
  }
  // The step boundary is crossed only once it is durable: a sideband
  // reconnect between ops_shown and this write landing must restore the
  // step it can prove, never skip past it.
  try {
    await queueProgressWrite(ctx, run, 'active');
  } catch (error) {
    ctx.log(`session ${ctx.sessionId}: storyboard progress write failed ${String(error).slice(0, 200)}`);
  }
  if (ctx.state.storyboardRun !== run) return;
  advanceStoryboardRun(ctx);
}

function createBeat(ctx: CoordinatorContext, stepIndex: number): void {
  const run = ctx.state.storyboardRun;
  if (!run) return;
  const step = run.steps[stepIndex];
  const framing = run.nextBeatFraming.splice(0);
  run.beatCreateInFlight = true;
  run.pendingBeatStepIndex = stepIndex;
  run.cancelPendingBeat = false;
  sendResponseCreate(ctx, 'beat', {
    instructions: beatInstructions(run, step, framing),
    max_output_tokens: BEAT_MAX_OUTPUT_TOKENS,
  });
}

function createHandoff(ctx: CoordinatorContext): void {
  const run = ctx.state.storyboardRun;
  if (!run) return;
  const framing = run.nextBeatFraming.splice(0);
  run.beatCreateInFlight = true;
  run.pendingBeatStepIndex = null;
  run.cancelPendingBeat = false;
  sendResponseCreate(ctx, 'beat', {
    instructions: [
      PERSONA_LINE,
      ...framing,
      'The picture you were building is now complete on the board.',
      run.handoff,
    ].join('\n'),
  });
}

const PERSONA_LINE = 'You are Noura, a warm, plain-spoken voice tutor teaching one child at a shared whiteboard. You are continuing your own explanation; the learner has not spoken.';

function beatInstructions(run: StoryboardRunState, step: StoryboardRunStep, framing: string[]): string {
  return [
    PERSONA_LINE,
    ...framing,
    `The board just revealed, in the section called “${run.groupLabel}”: ${step.objectIds.join(', ')}.`,
    `Say one or two short sentences conveying exactly this beat, in your own warm spoken voice: “${step.narration}”`,
    'Refer to what appeared by what it is. Never say object ids, coordinates, or markup, and never mention drawing, waiting, or tools.',
    'Do not greet, do not recap earlier steps, do not ask a question, and do not call tools. Stop after this beat.',
  ].join('\n');
}

function armStepTimer(ctx: CoordinatorContext, run: StoryboardRunState): void {
  clearStepTimer(run);
  const timer = setTimeout(() => {
    if (ctx.state.storyboardRun !== run) return;
    abandonStoryboardRun(ctx, { injectNote: true });
  }, ctx.stepRevealTimeoutMs);
  timer.unref?.();
  run.stepTimer = timer;
}

function clearStepTimer(run: StoryboardRunState): void {
  if (run.stepTimer !== null) clearTimeout(run.stepTimer);
  run.stepTimer = null;
}

function completeStoryboardRun(ctx: CoordinatorContext, outcome: 'completed'): void {
  const run = ctx.state.storyboardRun;
  if (!run) return;
  clearStepTimer(run);
  ctx.state.storyboardRun = null;
  persistProgress(ctx, run, outcome);
  submitOutcome(ctx, run, outcome);
}

/** Fail-closed stop: the tutor continues with what is visible. Revealed
 * steps stay on the board (permanence); unrevealed steps never appear. */
export function abandonStoryboardRun(
  ctx: CoordinatorContext,
  options: { injectNote: boolean; requestResponse?: boolean; persistBridge?: boolean },
): void {
  const { state } = ctx;
  const run = state.storyboardRun;
  if (!run) return;
  clearStepTimer(run);
  if (run.pendingStepEventId !== null) {
    // A cue may already be queued behind a playback boundary in the client.
    // Cancel by durable event id before dropping server bookkeeping. The
    // client deliberately ignores this once first paint has happened.
    ctx.sendClient({
      type: 'board_ops_cancelled',
      event_ids: [run.pendingStepEventId],
    }, state.clientIdentity);
    state.pendingVisibility.delete(run.pendingStepEventId);
    state.pendingBoardOps.delete(run.pendingStepEventId);
  }
  state.storyboardRun = null;
  state.visualPlanState = 'failed';
  persistProgress(ctx, run, 'abandoned');
  submitOutcome(ctx, run, 'abandoned');
  if (options.persistBridge) persistAbandonmentBridge(ctx, run);
  if (!options.injectNote) return;
  ctx.sendUpstream({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [{
        type: 'input_text',
        text: '[The board build stopped early; the remaining parts will not appear.] Continue teaching with what is visible now. Do not refer to parts that never appeared.',
      }],
    },
  });
  if (options.requestResponse !== false && tutorFloorIsFree(ctx)) sendResponseCreate(ctx, 'tool');
}

function persistAbandonmentBridge(ctx: CoordinatorContext, run: StoryboardRunState): void {
  const write = run.progressWrite
    .catch(() => undefined)
    .then(() => Promise.resolve(ctx.repo.addEvent(ctx.sessionId, 'storyboard_bridge_pending', {
      runId: run.runId,
      source: run.source,
    })))
    .then(() => undefined);
  run.progressWrite = write;
  ctx.trackSideEffect(write.catch((error) => {
    ctx.log(`session ${ctx.sessionId}: storyboard reconnect bridge write failed ${String(error).slice(0, 200)}`);
  }));
}

function persistProgress(
  ctx: CoordinatorContext,
  run: StoryboardRunState,
  status: 'active' | 'completed' | 'abandoned',
): void {
  ctx.trackSideEffect(queueProgressWrite(ctx, run, status).catch((error) => {
    ctx.log(`session ${ctx.sessionId}: storyboard progress write failed ${String(error).slice(0, 200)}`);
  }));
}

function queueProgressWrite(
  ctx: CoordinatorContext,
  run: StoryboardRunState,
  status: 'active' | 'completed' | 'abandoned',
): Promise<void> {
  const payload = {
    runId: run.runId,
    source: run.source,
    groupId: run.groupId,
    revealedSteps: run.revealedSteps,
    totalSteps: run.steps.length,
    status,
  };
  const write = run.progressWrite
    .catch(() => undefined)
    .then(() => Promise.resolve(ctx.repo.addEvent(ctx.sessionId, 'storyboard_progress', payload)))
    .then(() => undefined);
  run.progressWrite = write;
  return write;
}

function submitOutcome(ctx: CoordinatorContext, run: StoryboardRunState, outcome: 'completed' | 'abandoned'): void {
  const identity = ctx.state.clientIdentity;
  if (!identity) return;
  ctx.telemetryWriter.submit({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    name: 'storyboard_outcome',
    unit: 'count',
    value: 1,
    dimensions: {
      outcome,
      source: run.source,
      revealedSteps: run.revealedSteps,
      totalSteps: run.steps.length,
    },
  }, metricContextFromIdentity(identity));
}
