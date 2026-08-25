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
  kind: 'observation';
  observation: Exclude<MetricObservation, { legacy: true }>;
  context: MetricContext;
};

type GapEntry = {
  kind: 'gap';
  reason: TelemetryGapReason;
  value: number;
  context: MetricContext;
};

type QueueEntry = ObservationEntry | GapEntry;

export class SessionTelemetryWriter {
  private readonly queue: QueueEntry[] = [];
  private readonly pressureTotals = new Map<TelemetryGapReason, GapEntry>();
  private readonly capacity: number;
  private readonly gapCapacity: number;
  private drainPromise: Promise<void> | null = null;
  private normalCount = 0;
  private gapCount = 0;

  constructor(
    private readonly repo: SessionTelemetryRepository,
    private readonly sessionId: string,
    options: { capacity?: number } = {},
  ) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
    this.gapCapacity = this.capacity + 3;
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

  private enqueue(
    observation: Exclude<MetricObservation, { legacy: true }>,
    context: MetricContext,
  ): boolean {
    if (observation.name === 'telemetry_gap') {
      this.appendGap(
        observation.dimensions.reason,
        observation.value,
        context,
      );
      this.startDrain();
      return true;
    }
    const inFlightNormal = this.drainPromise &&
      this.queue[0]?.kind === 'observation'
      ? 1
      : 0;
    if (
      this.normalCount - inFlightNormal >= this.capacity ||
      this.pressureTotals.size > 0
    ) {
      this.appendGap(
        'server_queue_overflow',
        1,
        context,
      );
      this.startDrain();
      return false;
    }
    this.queue.push({ kind: 'observation', observation, context });
    this.normalCount += 1;
    this.startDrain();
    return true;
  }

  private appendGap(
    reason: TelemetryGapReason,
    value: number,
    context: MetricContext,
  ): void {
    const previous = this.queue.at(-1);
    if (
      previous?.kind === 'gap' &&
      previous.reason === reason &&
      sameContext(previous.context, context) &&
      Number.isSafeInteger(previous.value + value)
    ) {
      previous.value += value;
      return;
    }
    if (this.gapCount >= this.gapCapacity) {
      const pending = this.pressureTotals.get(reason);
      if (pending && Number.isSafeInteger(pending.value + value)) {
        pending.value += value;
      } else if (!pending) {
        this.pressureTotals.set(reason, {
          kind: 'gap',
          reason,
          value,
          context,
        });
      }
      return;
    }
    this.queue.push({ kind: 'gap', reason, value, context });
    this.gapCount += 1;
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    this.materializePressureTotals();
    if (this.queue.length === 0) return;

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
      const entry = this.queue[0];
      if (!entry) return false;
      if (entry.kind === 'gap') {
        const observation = gapObservation(
          this.sessionId,
          entry.reason,
          entry.value,
          entry.context,
        );
        if (!observation) return true;
        try {
          await this.repo.appendMetric(this.sessionId, observation);
          this.queue.shift();
          this.gapCount -= 1;
          this.materializePressureTotals();
        } catch {
          return true;
        }
        continue;
      }

      try {
        await this.repo.appendMetric(this.sessionId, entry.observation);
        this.queue.shift();
        this.normalCount -= 1;
      } catch {
        this.queue[0] = {
          kind: 'gap',
          reason: 'server_persistence_failure',
          value: 1,
          context: entry.context,
        };
        this.normalCount -= 1;
        this.gapCount += 1;
      }
    }
    return false;
  }

  private materializePressureTotals(): void {
    while (this.gapCount < this.gapCapacity && this.pressureTotals.size > 0) {
      const pending = this.pressureTotals.entries().next().value as
        | [TelemetryGapReason, GapEntry]
        | undefined;
      if (!pending) return;
      this.pressureTotals.delete(pending[0]);
      this.queue.push(pending[1]);
      this.gapCount += 1;
    }
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

function sameContext(left: MetricContext, right: MetricContext): boolean {
  return left.connectionEpoch === right.connectionEpoch &&
    left.turnId === right.turnId &&
    left.generationId === right.generationId &&
    left.providerResponseId === right.providerResponseId;
}
