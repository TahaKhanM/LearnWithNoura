export type LiveEvalPhase = 'warmup' | 'composition' | 'judge' | 'vision_audit' | 'sketch' | 'layout_correction' | 'recovery_escalation' | 'image_grounding';
export type LiveEvalModel = 'gpt-5.6-terra' | 'gpt-5.6-luna';

export interface SpendUsageEvidence {
  model: LiveEvalModel;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  usageComplete: boolean;
}

export interface SpendLedgerEvent {
  sequence: number;
  runId: string;
  callId: string;
  status: 'reserved' | 'started' | 'completed' | 'failed';
  phase: LiveEvalPhase;
  models: LiveEvalModel[];
  reserveUsd: number;
  providerCallCount: number;
  observedCostUsd: number;
  upperBoundUsd: number;
  usage: SpendUsageEvidence[];
  cumulativeProviderCalls: number;
  cumulativeObservedCostUsd: number;
  cumulativeAccountedCostUsd: number;
  openReservationUsd: number;
}

export interface SpendLedgerSnapshot {
  schemaVersion: '1.0.0';
  runId: string;
  maxSpendUsd: number;
  providerCalls: number;
  observedCostUsd: number;
  accountedCostUsd: number;
  openReservationUsd: number;
  entries: SpendLedgerEvent[];
}

export class SpendCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendCapError';
  }
}

interface PendingCall {
  callId: string;
  phase: LiveEvalPhase;
  models: LiveEvalModel[];
  reserveUsd: number;
  providerCallCount: number;
}

export class LiveSpendLedger {
  readonly entries: SpendLedgerEvent[] = [];
  providerCalls = 0;
  observedCostUsd = 0;
  accountedCostUsd = 0;
  private pending = new Map<string, PendingCall>();
  private nextCall = 0;
  private nextSequence = 0;

  constructor(
    readonly maxSpendUsd: number,
    private readonly onEvent?: (entry: SpendLedgerEvent) => void,
    readonly runId = 'scripted-live-eval',
  ) {
    if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0 || maxSpendUsd > 30) {
      throw new Error('Live spend cap must be a finite positive value no greater than $30.');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(runId)) {
      throw new Error('Live evaluation run id is invalid.');
    }
  }

  get estimatedCostUsd(): number {
    return this.observedCostUsd;
  }

  get openReservationUsd(): number {
    return money([...this.pending.values()].reduce((total, pending) => total + pending.reserveUsd, 0));
  }

  begin(input: { phase: LiveEvalPhase; models: LiveEvalModel[]; reserveUsd: number }): string {
    if (input.models.length === 0 || new Set(input.models).size !== input.models.length) {
      throw new Error('A live provider call requires one or more unique model roles.');
    }
    const reserveUsd = money(input.reserveUsd);
    if (!Number.isFinite(input.reserveUsd) || reserveUsd <= 0) {
      throw new Error('A live provider call requires a finite positive reservation.');
    }
    if (this.accountedCostUsd + this.openReservationUsd + reserveUsd > this.maxSpendUsd) {
      throw new SpendCapError(`The next provider call could cross the $${this.maxSpendUsd} spend cap.`);
    }
    const callId = `${this.runId}:call-${++this.nextCall}`;
    const pending: PendingCall = {
      callId,
      phase: input.phase,
      models: [...input.models],
      reserveUsd,
      providerCallCount: 0,
    };
    this.pending.set(callId, pending);
    this.emit(pending, 'reserved', 0, reserveUsd, []);
    return callId;
  }

  noteProviderCalls(callId: string, count: number): void {
    const pending = this.requirePending(callId);
    if (!Number.isInteger(count) || count < 1) throw new Error('Provider call count must be a positive integer.');
    if (pending.providerCallCount !== 0) throw new Error(`Provider call ${callId} was already started.`);
    if (count !== pending.models.length) {
      throw new Error(`Provider call ${callId} must start exactly one request per reserved model.`);
    }
    pending.providerCallCount += count;
    this.providerCalls += count;
    this.emit(pending, 'started', 0, pending.reserveUsd, []);
  }

  complete(callId: string, input: {
    status: 'completed' | 'failed';
    observedCostUsd: number;
    upperBoundUsd: number;
    usage: SpendUsageEvidence[];
  }): void {
    const pending = this.requirePending(callId);
    if (pending.providerCallCount === 0) throw new Error(`Provider call ${callId} cannot settle before it starts.`);
    validateUsage(input.usage, pending.models);
    if (!Number.isFinite(input.observedCostUsd) || !Number.isFinite(input.upperBoundUsd)) {
      throw new Error(`Provider call ${callId} has non-finite cost evidence.`);
    }
    const observed = money(Math.max(0, input.observedCostUsd));
    const requestedUpper = input.status === 'failed' ? pending.reserveUsd : input.upperBoundUsd;
    const upper = money(Math.max(observed, requestedUpper));
    const reservationExceeded = upper > pending.reserveUsd;
    this.pending.delete(callId);
    this.observedCostUsd = money(this.observedCostUsd + observed);
    this.accountedCostUsd = money(this.accountedCostUsd + upper);
    this.emit(pending, input.status, observed, upper, input.usage);
    if (reservationExceeded) {
      throw new SpendCapError(
        `Provider call ${callId} exceeded its $${pending.reserveUsd} conservative reservation with a $${upper} upper bound.`,
      );
    }
    if (this.accountedCostUsd + this.openReservationUsd > this.maxSpendUsd) {
      throw new SpendCapError(`Observed upper-bound cost crossed the $${this.maxSpendUsd} spend cap.`);
    }
  }

  snapshot(): SpendLedgerSnapshot {
    return {
      schemaVersion: '1.0.0',
      runId: this.runId,
      maxSpendUsd: this.maxSpendUsd,
      providerCalls: this.providerCalls,
      observedCostUsd: this.observedCostUsd,
      accountedCostUsd: this.accountedCostUsd,
      openReservationUsd: this.openReservationUsd,
      entries: this.entries.map((entry) => ({
        ...entry,
        models: [...entry.models],
        usage: entry.usage.map(copyUsage),
      })),
    };
  }

  private requirePending(callId: string): PendingCall {
    const pending = this.pending.get(callId);
    if (!pending) throw new Error(`Unknown or settled spend-ledger call ${callId}.`);
    return pending;
  }

  private emit(
    pending: PendingCall,
    status: SpendLedgerEvent['status'],
    observedCostUsd: number,
    upperBoundUsd: number,
    usage: SpendUsageEvidence[],
  ): void {
    const entry: SpendLedgerEvent = {
      sequence: ++this.nextSequence,
      runId: this.runId,
      callId: pending.callId,
      status,
      phase: pending.phase,
      models: [...pending.models],
      reserveUsd: pending.reserveUsd,
      providerCallCount: pending.providerCallCount,
      observedCostUsd,
      upperBoundUsd,
      usage: usage.map(copyUsage),
      cumulativeProviderCalls: this.providerCalls,
      cumulativeObservedCostUsd: this.observedCostUsd,
      cumulativeAccountedCostUsd: this.accountedCostUsd,
      openReservationUsd: this.openReservationUsd,
    };
    this.entries.push(entry);
    this.onEvent?.(entry);
  }
}

function money(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

function copyUsage(usage: SpendUsageEvidence): SpendUsageEvidence {
  return {
    model: usage.model,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    usageComplete: usage.usageComplete,
  };
}

function validateUsage(usage: SpendUsageEvidence[], models: LiveEvalModel[]): void {
  if (usage.length > models.length) throw new Error('Spend usage has more rows than reserved models.');
  const seen = new Set<LiveEvalModel>();
  for (const row of usage) {
    if (!models.includes(row.model) || seen.has(row.model)) {
      throw new Error('Spend usage models must uniquely match the reserved model set.');
    }
    seen.add(row.model);
    for (const value of [
      row.inputTokens,
      row.cachedInputTokens,
      row.cacheWriteTokens,
      row.outputTokens,
    ]) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('Spend usage token counts must be non-negative integers.');
      }
    }
    if (row.cachedInputTokens + row.cacheWriteTokens > row.inputTokens) {
      throw new Error('Cached reads and cache writes cannot exceed total input tokens.');
    }
  }
}
