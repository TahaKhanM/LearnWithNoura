import {
  TELEMETRY_SCHEMA_VERSION,
  type MetricContext,
  type MetricObservation,
  type TelemetryGapReason,
} from '../../shared/sessionTelemetry.js';
import type { DomainRepository } from '../store/domain.js';
import { prepareMetric, prepareProviderUsage } from './telemetryRecorder.js';

const DEFAULT_CAPACITY = 256;

type PendingGap = {
  value: number;
  context: MetricContext;
};

export class SessionTelemetryWriter {
  private readonly queue: MetricObservation[] = [];
  private readonly pendingGaps = new Map<TelemetryGapReason, PendingGap>();
  private readonly capacity: number;
  private drainPromise: Promise<void> | null = null;
  private retryRequested = false;

  constructor(
    private readonly repo: DomainRepository,
    private readonly sessionId: string,
    options: { capacity?: number } = {},
  ) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY));
  }

  submit(input: unknown, context: MetricContext): boolean {
    const observation = prepareMetric(this.sessionId, input, context);
    return observation ? this.enqueue(observation) : false;
  }

  submitProviderUsage(usage: unknown, context: MetricContext): boolean {
    const observation = prepareProviderUsage(this.sessionId, usage, context);
    return observation ? this.enqueue(observation) : false;
  }

  async flush(): Promise<void> {
    this.startDrain();
    while (this.drainPromise) {
      const current = this.drainPromise;
      await current;
      if (this.drainPromise === current) await Promise.resolve();
    }
  }

  private enqueue(observation: MetricObservation): boolean {
    if ('legacy' in observation) return false;
    if (this.queue.length >= this.capacity) {
      this.addGap(
        'server_queue_overflow',
        1,
        contextFromObservation(observation),
      );
      this.startDrain();
      return false;
    }
    this.queue.push(observation);
    this.startDrain();
    return true;
  }

  private addGap(
    reason: TelemetryGapReason,
    value: number,
    context: MetricContext,
  ): void {
    const current = this.pendingGaps.get(reason);
    if (current) {
      current.value += value;
      return;
    }
    this.pendingGaps.set(reason, { value, context });
  }

  private startDrain(): void {
    if (this.drainPromise) {
      this.retryRequested = true;
      return;
    }
    if (this.queue.length === 0 && this.pendingGaps.size === 0) return;

    this.retryRequested = false;
    const current = this.drain();
    this.drainPromise = current;
    void current.finally(() => {
      if (this.drainPromise !== current) return;
      this.drainPromise = null;
      if (this.retryRequested) {
        this.retryRequested = false;
        this.startDrain();
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 || this.pendingGaps.size > 0) {
      const pendingGap = this.pendingGaps.entries().next().value as
        | [TelemetryGapReason, PendingGap]
        | undefined;
      if (pendingGap) {
        const [reason, gap] = pendingGap;
        const observation = prepareMetric(this.sessionId, {
          schemaVersion: TELEMETRY_SCHEMA_VERSION,
          name: 'telemetry_gap',
          unit: 'count',
          value: gap.value,
          dimensions: { reason },
        }, gap.context);
        if (!observation) {
          this.pendingGaps.delete(reason);
          continue;
        }
        try {
          await this.repo.addEvent(this.sessionId, 'metric', observation);
          this.pendingGaps.delete(reason);
        } catch {
          return;
        }
        continue;
      }

      const observation = this.queue.shift();
      if (!observation || 'legacy' in observation) continue;
      try {
        await this.repo.addEvent(this.sessionId, 'metric', observation);
      } catch {
        this.addGap(
          'server_persistence_failure',
          1,
          contextFromObservation(observation),
        );
      }
    }
  }
}

function contextFromObservation(observation: MetricObservation): MetricContext {
  if ('legacy' in observation) {
    throw new Error('Legacy observations cannot enter the telemetry writer.');
  }
  return {
    connectionEpoch: observation.connectionEpoch,
    turnId: observation.turnId,
    generationId: observation.generationId,
    ...(observation.providerResponseId
      ? { providerResponseId: observation.providerResponseId }
      : {}),
  };
}
