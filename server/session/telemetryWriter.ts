import {
  TELEMETRY_SCHEMA_VERSION,
  type MetricContext,
  type MetricObservation,
  type TelemetryGapReason,
} from '../../shared/sessionTelemetry.js';
import { prepareMetric, prepareProviderUsage } from './telemetryRecorder.js';
import type { SessionTelemetryRepository } from './telemetryRepository.js';

const DEFAULT_CAPACITY = 256;

type ObservationEntry = {
  observation: Exclude<MetricObservation, { legacy: true }>;
  context: MetricContext;
};

type GapCounter = {
  value: number;
  context: MetricContext | null;
};

const GAP_REASONS: readonly TelemetryGapReason[] = [
  'server_queue_overflow',
  'server_persistence_failure',
  'server_history_failure',
  'server_accounting_overflow',
  'client_queue_overflow',
];

export class TelemetryIncompleteFlushError extends Error {
  readonly code = 'TELEMETRY_INCOMPLETE_FLUSH';

  constructor(message = 'Telemetry persistence made no progress; flush is incomplete.') {
    super(message);
    this.name = 'TelemetryIncompleteFlushError';
  }
}

export class SessionTelemetryWriter {
  private readonly queue: ObservationEntry[] = [];
  private readonly gaps: Record<TelemetryGapReason, GapCounter> =
    Object.fromEntries(GAP_REASONS.map((reason) => [
      reason,
      { value: 0, context: null },
    ])) as Record<TelemetryGapReason, GapCounter>;
  private readonly capacity: number;
  private drainPromise: Promise<void> | null = null;
  private unregister: (() => void) | null = null;
  private accepting = true;

  constructor(
    private readonly repo: SessionTelemetryRepository,
    private readonly sessionId: string,
    options: { capacity?: number } = {},
  ) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
    this.unregister = repo.registerWriter?.(this) ?? null;
  }

  submit(input: unknown, context: MetricContext): boolean {
    if (!this.accepting) return false;
    const observation = prepareMetric(this.sessionId, input, context);
    return observation ? this.enqueue(observation, context) : false;
  }

  submitProviderUsage(usage: unknown, context: MetricContext): boolean {
    if (!this.accepting) return false;
    const observation = prepareProviderUsage(this.sessionId, usage, context);
    return observation ? this.enqueue(observation, context) : false;
  }

  async flush(): Promise<void> {
    while (this.queue.length > 0 || this.hasPendingGap()) {
      this.startDrain();
      const current = this.drainPromise;
      if (!current) {
        throw new TelemetryIncompleteFlushError();
      }
      await current;
    }
  }

  async close(): Promise<void> {
    this.accepting = false;
    await this.flush();
    this.unregister?.();
    this.unregister = null;
  }

  private enqueue(
    observation: Exclude<MetricObservation, { legacy: true }>,
    context: MetricContext,
  ): boolean {
    if (observation.name === 'telemetry_gap') {
      this.addGap(
        observation.dimensions.reason,
        observation.value,
        context,
      );
      this.startDrain();
      return true;
    }
    if (this.hasPendingGap() || this.queue.length >= this.capacity) {
      this.addGap(
        'server_queue_overflow',
        1,
        context,
      );
      this.startDrain();
      return false;
    }
    this.queue.push({ observation, context });
    this.startDrain();
    return true;
  }

  private addGap(
    reason: TelemetryGapReason,
    value: number,
    context: MetricContext,
  ): void {
    const counter = this.gaps[reason];
    const next = counter.value + value;
    if (!Number.isSafeInteger(next)) {
      this.gaps.server_accounting_overflow.value = 1;
      this.gaps.server_accounting_overflow.context ??= context;
      return;
    }
    counter.value = next;
    counter.context ??= context;
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    if (this.queue.length === 0 && !this.hasPendingGap()) return;

    const current = Promise.resolve()
      .then(() => this.drain())
      .then((complete) => {
        if (!complete) throw new TelemetryIncompleteFlushError();
      });
    this.drainPromise = current;
    void current.finally(() => {
      if (this.drainPromise !== current) return;
      this.drainPromise = null;
    }).catch(() => {
      // The original promise remains rejected for flush/close; this observer
      // prevents a background drain from becoming an unhandled rejection.
    });
  }

  private async drain(): Promise<boolean> {
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) break;
      try {
        await this.repo.appendMetric(this.sessionId, entry.observation);
      } catch {
        this.addGap('server_persistence_failure', 1, entry.context);
      }
    }
    while (this.hasPendingGap()) {
      let progressed = false;
      for (const reason of GAP_REASONS) {
        const counter = this.gaps[reason];
        if (counter.value < 1 || !counter.context) continue;
        const attemptedValue = counter.value;
        const attemptedContext = counter.context;
        const observation = gapObservation(
          this.sessionId,
          reason,
          attemptedValue,
          attemptedContext,
        );
        if (!observation) return false;
        try {
          await this.repo.appendMetric(this.sessionId, observation);
          counter.value -= attemptedValue;
          if (counter.value === 0) counter.context = null;
          progressed = true;
        } catch {
          return false;
        }
      }
      if (!progressed) return false;
    }
    return this.queue.length === 0 && !this.hasPendingGap();
  }

  private hasPendingGap(): boolean {
    return GAP_REASONS.some((reason) => this.gaps[reason].value > 0);
  }
}

function gapObservation(
  sessionId: string,
  reason: TelemetryGapReason,
  value: number,
  context: MetricContext,
): Exclude<MetricObservation, { legacy: true }> | null {
  return prepareMetric(sessionId, {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    name: 'telemetry_gap',
    unit: 'count',
    value,
    dimensions: { reason },
  }, context);
}

