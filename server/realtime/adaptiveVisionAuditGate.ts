import type { VisionAuditOutcome } from '../../shared/sessionTelemetry.js';
import {
  closedVisionAuditIssues,
  VISION_AUDIT_BUDGET_MS,
  type VisionAuditEvent,
  type VisionAuditInput,
  type VisionAuditPort,
} from '../board/visionAudit.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import {
  abandonStoryboardRun,
  releaseStoryboardFirstReveal,
  releaseStoryboardSubsequentReveals,
} from './storyboardRunner.js';

export interface AdaptiveVisionAuditTerminal {
  safe: boolean;
  aborted: boolean;
  externalFailure?: boolean;
  outcome?: VisionAuditOutcome;
}

export interface AdaptiveVisionAuditGate {
  terminal: Promise<AdaptiveVisionAuditTerminal>;
  markCompositionComplete(totalSteps: number): void;
}

/** Realtime reveal controller. Composition continues independently while
 * this gate holds presentation: step 1 waits for the measured budget; after
 * budget it becomes irrevocably authorized and the verdict moves to the next
 * real reveal boundary. */
export function createAdaptiveVisionAuditGate(input: {
  ctx: CoordinatorContext;
  runId: string;
  port: VisionAuditPort;
  request: Omit<VisionAuditInput, 'candidateImage'>;
  raster: Promise<string | null>;
  parentSignal: AbortSignal;
  abortComposition: () => void;
  onRejected?: () => void;
  onOutcome?: (event: VisionAuditEvent) => void;
  budgetMs?: number;
}): AdaptiveVisionAuditGate {
  let resolveTerminal!: (result: AdaptiveVisionAuditTerminal) => void;
  const terminal = new Promise<AdaptiveVisionAuditTerminal>((resolve) => { resolveTerminal = resolve; });
  const auditController = new AbortController();
  const budgetMs = Math.max(0, input.budgetMs ?? VISION_AUDIT_BUDGET_MS);
  let budgetTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRejectionTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let providerTerminal = false;
  let outcomeRecorded = false;
  let budgetExpired = false;
  let firstPainted = false;
  let firstDurable = false;
  let pendingRejection: 'rejected' | 'invalid' | null = null;
  let completedStepCount: number | null = null;
  let auditStartedAtMs: number | null = null;
  let priorOnAbandoned: (() => void) | null = null;
  let auditAbandonHandler: (() => void) | null = null;

  const run = input.ctx.state.storyboardRun;
  if (run?.runId === input.runId) {
    run.onFirstPaint = () => {
      firstPainted = true;
      if (completedStepCount === 1 && budgetExpired && !providerTerminal) settleTimeout();
    };
    run.onFirstDurable = () => {
      firstDurable = true;
      if (pendingRejection) finalizeRejection(pendingRejection);
    };
    run.onSubsequentRevealBlocked = () => {
      if (!providerTerminal) settleTimeout();
    };
    priorOnAbandoned = run.onAbandoned;
    auditAbandonHandler = () => {
      settleExternalAbandonment();
      priorOnAbandoned?.();
    };
    run.onAbandoned = auditAbandonHandler;
  }

  const parentAbort = () => settleAborted();
  if (input.parentSignal.aborted) {
    settleAborted();
  } else {
    input.parentSignal.addEventListener('abort', parentAbort, { once: true });
    void begin();
  }

  return {
    terminal,
    markCompositionComplete(totalSteps) {
      completedStepCount = Math.max(0, totalSteps);
      if (completedStepCount === 1 && firstPainted && budgetExpired && !providerTerminal) {
        settleTimeout();
      }
    },
  };

  async function begin(): Promise<void> {
    let raster: string | null;
    try { raster = await input.raster; }
    catch { settleSafe('error'); return; }
    if (settled || input.parentSignal.aborted) { settleAborted(); return; }
    if (!raster) { settleSafe('error'); return; }
    const startedAtMs = Date.now();
    auditStartedAtMs = startedAtMs;
    budgetTimer = setTimeout(() => {
      if (settled || providerTerminal) return;
      budgetExpired = true;
      releaseStoryboardFirstReveal(input.ctx, input.runId);
    }, budgetMs);
    budgetTimer.unref?.();
    if (input.parentSignal.aborted) { settleAborted(); return; }
    try {
      const verdict = await input.port.inspect(
        { ...input.request, candidateImage: raster },
        { signal: auditController.signal },
      );
      if (settled) return;
      if (verdict.outcome === 'approved') settleSafe('approved', startedAtMs);
      else settleRejection(verdict.outcome, startedAtMs);
    } catch {
      if (settled) return;
      if (input.parentSignal.aborted) {
        settleAborted();
        return;
      }
      settleSafe('error', startedAtMs);
    }
  }

  function settleRejection(outcome: 'rejected' | 'invalid', startedAtMs: number): void {
    providerTerminal = true;
    clearBudget();
    recordOutcome(outcome, startedAtMs);
    if (!budgetExpired) {
      finalizeRejection(outcome);
      return;
    }
    pendingRejection = outcome;
    if (firstDurable) {
      finalizeRejection(outcome);
      return;
    }
    pendingRejectionTimer = setTimeout(() => finalizeRejection(outcome), input.ctx.stepRevealTimeoutMs);
    pendingRejectionTimer.unref?.();
  }

  function finalizeRejection(outcome: 'rejected' | 'invalid'): void {
    if (settled) return;
    settled = true;
    providerTerminal = true;
    pendingRejection = null;
    cleanup();
    input.onRejected?.();
    input.abortComposition();
    if (input.ctx.state.storyboardRun?.runId === input.runId) {
      abandonStoryboardRun(input.ctx, {
        injectNote: true,
        stage: 'audit_gate',
        reason: `vision_audit_${outcome}`,
      });
    }
    resolveTerminal({ safe: false, aborted: false, outcome });
  }

  function settleSafe(outcome: 'approved' | 'error', startedAtMs = Date.now()): void {
    if (settled) return;
    settled = true;
    providerTerminal = true;
    clearBudget();
    recordOutcome(outcome, startedAtMs);
    cleanup();
    releaseStoryboardFirstReveal(input.ctx, input.runId);
    releaseStoryboardSubsequentReveals(input.ctx, input.runId);
    resolveTerminal({ safe: true, aborted: false, outcome });
  }

  function settleTimeout(): void {
    if (settled || providerTerminal) return;
    settled = true;
    providerTerminal = true;
    auditController.abort('vision audit reached the next reveal boundary');
    clearBudget();
    recordOutcome('timeout', auditStartedAtMs ?? Date.now());
    cleanup();
    releaseStoryboardFirstReveal(input.ctx, input.runId);
    releaseStoryboardSubsequentReveals(input.ctx, input.runId);
    resolveTerminal({ safe: true, aborted: false, outcome: 'timeout' });
  }

  function settleAborted(): void {
    if (settled) return;
    settled = true;
    auditController.abort('visual request epoch ended');
    clearBudget();
    cleanup();
    resolveTerminal({ safe: false, aborted: true });
  }

  function settleExternalAbandonment(): void {
    if (settled) return;
    const rejection = pendingRejection;
    settled = true;
    auditController.abort('storyboard run ended before audit terminal');
    clearBudget();
    cleanup();
    if (rejection) input.onRejected?.();
    input.abortComposition();
    resolveTerminal({
      safe: false,
      aborted: false,
      externalFailure: !rejection,
      ...(rejection ? { outcome: rejection } : {}),
    });
  }

  function recordOutcome(outcome: VisionAuditOutcome, startedAtMs: number): void {
    if (outcomeRecorded) return;
    outcomeRecorded = true;
    const closedIssue = closedVisionAuditIssues(outcome);
    try {
      input.onOutcome?.({
        startedAtMs,
        model: input.port.model,
        reasoningEffort: input.port.reasoningEffort,
        outcome,
        issues: closedIssue,
      });
    } catch { /* telemetry cannot alter reveal authority */ }
  }

  function clearBudget(): void {
    if (budgetTimer !== null) clearTimeout(budgetTimer);
    budgetTimer = null;
  }

  function cleanup(): void {
    if (pendingRejectionTimer !== null) clearTimeout(pendingRejectionTimer);
    pendingRejectionTimer = null;
    input.parentSignal.removeEventListener('abort', parentAbort);
    const active = input.ctx.state.storyboardRun;
    if (active?.runId === input.runId) {
      active.onFirstPaint = null;
      active.onFirstDurable = null;
      active.onSubsequentRevealBlocked = null;
      if (active.onAbandoned === auditAbandonHandler) active.onAbandoned = priorOnAbandoned;
    }
  }
}
