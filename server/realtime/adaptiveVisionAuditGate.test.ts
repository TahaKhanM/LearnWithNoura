import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VisionAuditPort } from '../board/visionAudit.js';
import { createAdaptiveVisionAuditGate } from './adaptiveVisionAuditGate.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import type { StoryboardRunState } from './storyboardRunner.js';

afterEach(() => vi.useRealTimers());

describe('adaptive realtime vision audit gate', () => {
  it('holds step 1 until an in-budget approval and never blocks composition completion', async () => {
    const harness = gateHarness();
    const compositionAbandon = vi.fn();
    harness.run.onAbandoned = compositionAbandon;
    let resolveAudit!: (value: { outcome: 'approved'; issues: string[] }) => void;
    const audit = new Promise<{ outcome: 'approved'; issues: string[] }>((resolve) => { resolveAudit = resolve; });
    const gate = createAdaptiveVisionAuditGate({
      ...harness.input,
      port: port(() => audit),
      raster: Promise.resolve('data:image/jpeg;base64,YXVkaXQ='),
    });
    gate.markCompositionComplete(3);
    expect(harness.run.firstRevealHeld).toBe(true);
    resolveAudit({ outcome: 'approved', issues: [] });
    await expect(gate.terminal).resolves.toMatchObject({ safe: true, outcome: 'approved' });
    expect(harness.run.firstRevealHeld).toBe(false);
    expect(harness.run.subsequentRevealsHeld).toBe(false);
    harness.run.onAbandoned?.();
    expect(compositionAbandon).toHaveBeenCalledOnce();
  });

  it('authorizes step 1 at budget and never revokes it on a late rejection', async () => {
    vi.useFakeTimers();
    const harness = gateHarness();
    let resolveAudit!: (value: { outcome: 'rejected'; issues: string[] }) => void;
    const audit = new Promise<{ outcome: 'rejected'; issues: string[] }>((resolve) => { resolveAudit = resolve; });
    const gate = createAdaptiveVisionAuditGate({
      ...harness.input,
      port: port(() => audit),
      raster: Promise.resolve('data:image/jpeg;base64,YXVkaXQ='),
      budgetMs: 30,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30);
    expect(harness.run.firstRevealHeld).toBe(false);
    resolveAudit({ outcome: 'rejected', issues: ['untrusted free-form text'] });
    await Promise.resolve();
    expect(harness.aborted).toBe(false);
    expect(harness.ctx.state.storyboardRun).toBe(harness.run);

    harness.run.onFirstPaint?.();
    await Promise.resolve();
    expect(harness.ctx.state.storyboardRun).toBe(harness.run);
    harness.run.onFirstDurable?.();
    await expect(gate.terminal).resolves.toMatchObject({ safe: false, outcome: 'rejected' });
    expect(harness.aborted).toBe(true);
    expect(harness.ctx.state.storyboardRun).toBeNull();
    expect(harness.upstreamText()).not.toContain('untrusted free-form text');
  });

  it('terminates a post-budget rejection when the client never paints', async () => {
    vi.useFakeTimers();
    const harness = gateHarness({ stepRevealTimeoutMs: 40 });
    let resolveAudit!: (value: { outcome: 'rejected'; issues: string[] }) => void;
    const audit = new Promise<{ outcome: 'rejected'; issues: string[] }>((resolve) => { resolveAudit = resolve; });
    const gate = createAdaptiveVisionAuditGate({
      ...harness.input,
      port: port(() => audit),
      raster: Promise.resolve('data:image/jpeg;base64,YXVkaXQ='),
      budgetMs: 10,
    });
    let terminal: Awaited<typeof gate.terminal> | null = null;
    void gate.terminal.then((result) => { terminal = result; });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    resolveAudit({ outcome: 'rejected', issues: ['untrusted free-form text'] });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(39);
    expect(terminal).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(terminal).toMatchObject({ safe: false, aborted: false, outcome: 'rejected' });
    expect(harness.aborted).toBe(true);
    expect(harness.ctx.state.storyboardRun).toBeNull();
    expect(harness.upstreamText()).not.toContain('untrusted free-form text');
  });

  it('resolves a pending late rejection when reconnect abandons the run', async () => {
    vi.useFakeTimers();
    const harness = gateHarness();
    let resolveAudit!: (value: { outcome: 'rejected'; issues: string[] }) => void;
    const audit = new Promise<{ outcome: 'rejected'; issues: string[] }>((resolve) => { resolveAudit = resolve; });
    const gate = createAdaptiveVisionAuditGate({
      ...harness.input,
      port: port(() => audit),
      raster: Promise.resolve('data:image/jpeg;base64,YXVkaXQ='),
      budgetMs: 10,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    resolveAudit({ outcome: 'rejected', issues: ['untrusted reconnect text'] });
    await Promise.resolve();
    harness.run.onAbandoned?.();

    await expect(gate.terminal).resolves.toMatchObject({ safe: false, aborted: false, outcome: 'rejected' });
    expect(harness.aborted).toBe(true);
    expect(harness.upstreamText()).not.toContain('untrusted reconnect text');
  });

  it('times out at the real next-reveal boundary and aborts only the audit request', async () => {
    vi.useFakeTimers();
    const harness = gateHarness();
    let auditAborted = false;
    const gate = createAdaptiveVisionAuditGate({
      ...harness.input,
      port: port(async (_request, options) => {
        options.signal.addEventListener('abort', () => { auditAborted = true; }, { once: true });
        return new Promise(() => {});
      }),
      raster: Promise.resolve('data:image/jpeg;base64,YXVkaXQ='),
      budgetMs: 20,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(harness.run.firstRevealHeld).toBe(false);
    harness.run.onSubsequentRevealBlocked?.();
    await expect(gate.terminal).resolves.toMatchObject({ safe: true, outcome: 'timeout' });
    expect(auditAborted).toBe(true);
    expect(harness.aborted).toBe(false);
    expect(harness.run.subsequentRevealsHeld).toBe(false);
  });

  it('fails open on render/provider availability and emits no outcome on epoch abort', async () => {
    const renderFailure = gateHarness();
    const renderGate = createAdaptiveVisionAuditGate({
      ...renderFailure.input,
      port: port(async () => ({ outcome: 'approved', issues: [] })),
      raster: Promise.resolve(null),
    });
    await expect(renderGate.terminal).resolves.toMatchObject({ safe: true, outcome: 'error' });

    const aborted = gateHarness();
    const controller = new AbortController();
    const inspect = vi.fn(async () => ({ outcome: 'approved' as const, issues: [] }));
    controller.abort('epoch changed');
    const abortedGate = createAdaptiveVisionAuditGate({
      ...aborted.input,
      parentSignal: controller.signal,
      port: port(inspect),
      raster: Promise.resolve('data:image/jpeg;base64,YXVkaXQ='),
    });
    await expect(abortedGate.terminal).resolves.toEqual({ safe: false, aborted: true });
    expect(inspect).not.toHaveBeenCalled();
    expect(aborted.outcomes).toEqual([]);
  });
});

function gateHarness(options: { stepRevealTimeoutMs?: number } = {}) {
  const run = openRun();
  const sentUpstream: unknown[] = [];
  const outcomes: string[] = [];
  let aborted = false;
  const ctx = {
    sessionId: 'session',
    stepRevealTimeoutMs: options.stepRevealTimeoutMs ?? 45_000,
    state: {
      storyboardRun: run,
      visualPlanState: 'rendering',
      pendingVisibility: new Map(),
      pendingBoardOps: new Map(),
      childHoldsFloor: true,
      speechInProgress: false,
      draftOpen: false,
      responseCreateInFlight: false,
      activeResponseId: null,
      lastCompletedResponseId: null,
    },
    repo: { addEvent: async () => 1 },
    sendClient: () => {},
    sendUpstream: (event: unknown) => { sentUpstream.push(event); },
    trackSideEffect: () => {},
    telemetryWriter: { submit: () => {} },
    log: () => {},
  } as unknown as CoordinatorContext;
  return {
    ctx,
    run,
    outcomes,
    get aborted() { return aborted; },
    upstreamText: () => JSON.stringify(sentUpstream),
    input: {
      ctx,
      runId: run.runId,
      request: { purpose: 'teach', idea: 'two boxes', constraints: null },
      parentSignal: new AbortController().signal,
      abortComposition: () => { aborted = true; },
      onOutcome: (event: { outcome: string }) => { outcomes.push(event.outcome); },
    },
  };
}

function openRun(): StoryboardRunState {
  return {
    runId: 'run-audit', source: 'director', groupId: 'group', groupLabel: 'Audit',
    steps: [{
      id: 's1', reveal: 'outline', narration: 'First.', objectIds: ['a'],
      ops: [{ op: 'add', id: 'a', spec: { kind: 'box', at: [300, 220], text: 'A' } }],
    }],
    revealedSteps: 0, narratedSteps: 0, beatCreateInFlight: false,
    pendingBeatStepIndex: null, handoffResponseId: null, cancelPendingBeat: false,
    pendingStepEventId: null, stepCueCreateInFlight: false,
    firstRevealHeld: true, subsequentRevealsHeld: true, firstRevealAfterResponseId: null,
    onFirstPaint: null, onFirstDurable: null, onSubsequentRevealBlocked: null, onAbandoned: null,
    auditBoundaryResponseId: null,
    needsResend: false, stepTimer: null, nextBeatFraming: [], handoff: 'Continue.',
    visualIntentStartedAtMs: 1, firstPaintRecorded: false, sceneCompleteRecorded: false,
    streamOpen: true, progressWrite: Promise.resolve(),
  };
}

function port(inspect: VisionAuditPort['inspect']): VisionAuditPort {
  return { model: 'gpt-5.6-luna', reasoningEffort: 'low', inspect };
}
