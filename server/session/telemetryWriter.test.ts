import { describe, expect, it, vi } from 'vitest';
import type { MetricObservation } from '../../shared/sessionTelemetry.js';
import type { SessionTelemetryRepository } from './telemetryRepository.js';
import { SessionTelemetryWriter } from './telemetryWriter.js';

const context = {
  connectionEpoch: 1,
  turnId: 'turn-private',
  generationId: 'generation-private',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function metric(value: number) {
  return {
    schemaVersion: '1.0.0',
    name: 'speech_end_to_first_audio',
    unit: 'ms',
    value,
  } as const;
}

describe('SessionTelemetryWriter', () => {
  it('returns before invoking even a synchronously blocking persistence adapter', async () => {
    const calls: number[] = [];
    const storage = {
      appendMetric(_sessionId: string, observation: MetricObservation) {
        const started = Date.now();
        while (Date.now() - started < 20) {
          // Deliberately blocks if the writer invokes it inline.
        }
        calls.push(observation.value);
        return Promise.resolve(calls.length);
      },
      hasPriorReleasedSessionStart: async () => false,
    } satisfies SessionTelemetryRepository;
    const writer = new SessionTelemetryWriter(storage, 'session-1');

    expect(writer.submit(metric(10), context)).toBe(true);
    expect(calls).toEqual([]);
    await writer.flush();
    expect(calls).toEqual([10]);
  });

  it('submits without awaiting and persists successful observations in FIFO order', async () => {
    const firstWrite = deferred<number>();
    const persisted: MetricObservation[] = [];
    let callCount = 0;
    const appendMetric = vi.fn((_sessionId: string, payload: MetricObservation) => {
      persisted.push(payload);
      callCount += 1;
      return callCount === 1 ? firstWrite.promise : Promise.resolve(callCount);
    });
    const writer = new SessionTelemetryWriter(
      { appendMetric, hasPriorReleasedSessionStart: async () => false },
      'session-1',
    );

    expect(writer.submit(metric(10), context)).toBe(true);
    expect(writer.submit(metric(20), context)).toBe(true);
    expect(writer.submit(metric(30), context)).toBe(true);
    expect(appendMetric).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(appendMetric).toHaveBeenCalledTimes(1);

    firstWrite.resolve(1);
    await writer.flush();

    expect(persisted.map((entry) => entry.value)).toEqual([10, 20, 30]);
    expect(persisted.every((entry) => JSON.stringify(entry).includes('turn-private'))).toBe(false);
  });

  it('persists A, B, then the overflow gap for C without moving the gap forward', async () => {
    const firstWrite = deferred<number>();
    const firstWriteStarted = deferred<void>();
    const persisted: MetricObservation[] = [];
    let callCount = 0;
    const appendMetric = vi.fn((_sessionId: string, payload: MetricObservation) => {
      persisted.push(payload);
      callCount += 1;
      if (callCount === 1) {
        firstWriteStarted.resolve();
        return firstWrite.promise;
      }
      return Promise.resolve(callCount);
    });
    const writer = new SessionTelemetryWriter(
      { appendMetric, hasPriorReleasedSessionStart: async () => false },
      'session-1',
      { capacity: 1 },
    );

    expect(writer.submit(metric(10), context)).toBe(true);
    await firstWriteStarted.promise;
    expect(writer.submit(metric(20), context)).toBe(true);
    expect(writer.submit(metric(30), context)).toBe(false);
    firstWrite.resolve(1);
    await writer.flush();

    expect(persisted.map((entry) => entry.name)).toEqual([
      'speech_end_to_first_audio',
      'speech_end_to_first_audio',
      'telemetry_gap',
    ]);
    expect(persisted[2]).toMatchObject({
      value: 1,
      dimensions: { reason: 'server_queue_overflow' },
    });
  });

  it('turns persistence rejection into an ordered gap without rejecting lesson work', async () => {
    const persisted: MetricObservation[] = [];
    let attempt = 0;
    const appendMetric = vi.fn(async (_sessionId: string, payload: MetricObservation) => {
      attempt += 1;
      if (attempt === 1) throw new Error('store unavailable');
      persisted.push(payload);
      return attempt;
    });
    const writer = new SessionTelemetryWriter(
      { appendMetric, hasPriorReleasedSessionStart: async () => false },
      'session-1',
    );

    expect(writer.submit(metric(10), context)).toBe(true);
    expect(writer.submit(metric(20), context)).toBe(true);
    await expect(writer.flush()).resolves.toBeUndefined();

    expect(persisted.map((entry) => entry.name)).toEqual([
      'telemetry_gap',
      'speech_end_to_first_audio',
    ]);
    expect(persisted[0]).toMatchObject({
      value: 1,
      dimensions: { reason: 'server_persistence_failure' },
    });
  });

  it('keeps a failed gap pending until a later flush can persist it', async () => {
    const persisted: MetricObservation[] = [];
    let available = false;
    const appendMetric = vi.fn(async (_sessionId: string, payload: MetricObservation) => {
      if (!available) throw new Error('store unavailable');
      persisted.push(payload);
      return persisted.length;
    });
    const writer = new SessionTelemetryWriter(
      { appendMetric, hasPriorReleasedSessionStart: async () => false },
      'session-1',
    );

    writer.submit(metric(10), context);
    writer.submit(metric(20), context);
    await writer.flush();
    expect(persisted).toEqual([]);

    available = true;
    await writer.flush();
    expect(persisted.map((entry) => entry.name)).toEqual([
      'telemetry_gap',
      'speech_end_to_first_audio',
    ]);
    expect(persisted[0]).toMatchObject({
      value: 1,
      dimensions: { reason: 'server_persistence_failure' },
    });
  });

  it('retries a failed client gap with its original reason and value before later telemetry', async () => {
    const attempted: MetricObservation[] = [];
    const persisted: MetricObservation[] = [];
    let failClientGap = true;
    const writer = new SessionTelemetryWriter({
      async appendMetric(_sessionId, observation) {
        attempted.push(observation);
        if (
          failClientGap &&
          observation.name === 'telemetry_gap' &&
          observation.dimensions.reason === 'client_queue_overflow'
        ) {
          throw new Error('gap store unavailable');
        }
        persisted.push(observation);
        return attempted.length;
      },
      hasPriorReleasedSessionStart: async () => false,
    }, 'session-1');

    writer.submit({
      schemaVersion: '1.0.0',
      name: 'telemetry_gap',
      unit: 'count',
      value: 7,
      dimensions: { reason: 'client_queue_overflow' },
    }, context);
    writer.submit(metric(20), context);
    await writer.flush();
    expect(persisted).toEqual([]);

    failClientGap = false;
    await writer.flush();
    expect(persisted).toEqual([
      expect.objectContaining({
        name: 'telemetry_gap',
        value: 7,
        dimensions: { reason: 'client_queue_overflow' },
      }),
      expect.objectContaining({ name: 'speech_end_to_first_audio', value: 20 }),
    ]);
    expect(attempted.filter((entry) =>
      entry.name === 'telemetry_gap' &&
      entry.dimensions.reason === 'server_persistence_failure')).toEqual([]);
  });
});
