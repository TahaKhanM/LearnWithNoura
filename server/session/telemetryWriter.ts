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

  constructor(
    private readonly repo: SessionTelemetryRepository,
    private readonly sessionId: string,
    options: { capacity?: number } = {},
  ) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
    this.unregister = repo.registerWriter?.(this) ?? null;
  }

  submit(input: unknown, context: MetricContext): boolean {
    const observation = prepareMetric(this.sessionId, input, context);
    return observation ? this.enqueue(observation, context) : false;
  }

  submitProviderUsage(usage: unknown, context: MetricContext): boolean {
    const observation = prepareProviderUsage(this.sessionId, usage, context);
    return observation ? this.enqueue(observation, context) : false;
  }

  async flush(): Promise<void> {
    this.startDrain();
    const current = this.drainPromise;
    if (current) await current;
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.unregister?.();
      this.unregister = null;
    }
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

    let blocked = false;
    const current = Promise.resolve()
      .then(() => this.drain())
      .then((wasBlocked) => {
        blocked = wasBlocked;
      });
    this.drainPromise = current;
    void current.then(() => {
      if (this.drainPromise !== current) return;
      this.drainPromise = null;
      if (!blocked && this.queue.length > 0) {
        this.startDrain();
      }
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
      if (!observation) return true;
      try {
        await this.repo.appendMetric(this.sessionId, observation);
        counter.value -= attemptedValue;
        if (counter.value === 0) counter.context = null;
      } catch {
        return true;
      }
    }
    return false;
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

