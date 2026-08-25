import { describe, expect, it, vi } from 'vitest';
import type { MetricObservation } from '../../shared/sessionTelemetry.js';
import type { SessionTelemetryRepository } from './telemetryRepository.js';
import {
  SessionTelemetryWriter,
  TelemetryIncompleteFlushError,
} from './telemetryWriter.js';

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

  it('keeps accepted normal observations FIFO and reports later overflow', async () => {
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
      'speech_end_to_first_audio',
      'telemetry_gap',
    ]);
    expect(persisted[1]).toMatchObject({
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
    await expect(writer.flush()).rejects.toBeInstanceOf(TelemetryIncompleteFlushError);
    expect(persisted).toEqual([]);

    available = true;
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(persisted.map((entry) => entry.name)).toEqual([
      'telemetry_gap',
    ]);
    expect(persisted[0]).toMatchObject({
      value: 2,
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
    await expect(writer.flush()).rejects.toBeInstanceOf(TelemetryIncompleteFlushError);
    expect(persisted).toEqual([
      expect.objectContaining({
        name: 'telemetry_gap',
        value: 1,
        dimensions: { reason: 'server_queue_overflow' },
      }),
    ]);

    failClientGap = false;
    await writer.flush();
    expect(persisted).toEqual([
      expect.objectContaining({
        name: 'telemetry_gap',
        value: 1,
        dimensions: { reason: 'server_queue_overflow' },
      }),
      expect.objectContaining({
        name: 'telemetry_gap',
        value: 7,
        dimensions: { reason: 'client_queue_overflow' },
      }),
    ]);
    expect(attempted.filter((entry) =>
      entry.name === 'telemetry_gap' &&
      entry.dimensions.reason === 'server_persistence_failure')).toEqual([]);
  });

  it('keeps fixed exact per-reason totals under alternating saturation', async () => {
    const persisted: MetricObservation[] = [];
    const writer = new SessionTelemetryWriter({
      async appendMetric(_sessionId, observation) {
        persisted.push(observation);
        return persisted.length;
      },
      hasPriorReleasedSessionStart: async () => false,
    }, 'session-1', { capacity: 1 });
    const reasons = [
      'server_queue_overflow',
      'server_persistence_failure',
      'server_history_failure',
      'client_queue_overflow',
    ] as const;
    for (let index = 0; index < 400; index += 1) {
      const reason = reasons[index % reasons.length]!;
      writer.submit({
        schemaVersion: '1.0.0',
        name: 'telemetry_gap',
        unit: 'count',
        value: 1,
        dimensions: { reason },
      }, { ...context, connectionEpoch: index });
    }
    expect(writer.submit(metric(99), context)).toBe(false);
    await writer.flush();
    const totals = Object.fromEntries(persisted
      .filter((entry) => entry.name === 'telemetry_gap')
      .map((entry) => [entry.dimensions.reason, entry.value]));
    expect(totals).toMatchObject({
      server_queue_overflow: 101,
      server_persistence_failure: 100,
      server_history_failure: 100,
      client_queue_overflow: 100,
    });
  });

  it('fails completeness closed when an internal counter cannot add safely', async () => {
    const persisted: MetricObservation[] = [];
    const writer = new SessionTelemetryWriter({
      async appendMetric(_sessionId, observation) {
        persisted.push(observation);
        return persisted.length;
      },
      hasPriorReleasedSessionStart: async () => false,
    }, 'session-1');
    for (const value of [Number.MAX_SAFE_INTEGER, 1]) {
      writer.submit({
        schemaVersion: '1.0.0',
        name: 'telemetry_gap',
        unit: 'count',
        value,
        dimensions: { reason: 'server_queue_overflow' },
      }, context);
    }
    await writer.flush();
    expect(persisted).toContainEqual(expect.objectContaining({
      name: 'telemetry_gap',
      dimensions: { reason: 'server_accounting_overflow' },
      value: 1,
    }));
  });

  it('keeps a failed close registered and retries after persistence recovers', async () => {
    let available = false;
    let registered = true;
    const repo = {
      async appendMetric() {
        if (!available) throw new Error('offline');
        return 1;
      },
      hasPriorReleasedSessionStart: async () => false,
      registerWriter() {
        return () => { registered = false; };
      },
    } satisfies SessionTelemetryRepository;
    const writer = new SessionTelemetryWriter(repo, 'session-1');
    writer.submit(metric(10), context);
    await expect(writer.close()).rejects.toBeInstanceOf(TelemetryIncompleteFlushError);
    expect(registered).toBe(true);
    expect(writer.submit(metric(20), context)).toBe(false);
    available = true;
    await expect(writer.close()).resolves.toBeUndefined();
    expect(registered).toBe(false);
  });

  it('revisits an earlier gap reason added while a later reason persists', async () => {
    const clientGap = deferred<number>();
    const persisted: MetricObservation[] = [];
    const writer = new SessionTelemetryWriter({
      async appendMetric(_sessionId, observation) {
        persisted.push(observation);
        if (
          observation.name === 'telemetry_gap' &&
          observation.dimensions.reason === 'client_queue_overflow'
        ) return clientGap.promise;
        return persisted.length;
      },
      hasPriorReleasedSessionStart: async () => false,
    }, 'session-1');
    writer.submit({
      schemaVersion: '1.0.0', name: 'telemetry_gap', unit: 'count', value: 1,
      dimensions: { reason: 'client_queue_overflow' },
    }, context);
    await Promise.resolve();
    writer.submit({
      schemaVersion: '1.0.0', name: 'telemetry_gap', unit: 'count', value: 2,
      dimensions: { reason: 'server_queue_overflow' },
    }, context);
    clientGap.resolve(1);
    await writer.flush();
    expect(persisted.map((entry) =>
      entry.name === 'telemetry_gap' ? entry.dimensions.reason : entry.name))
      .toEqual(['client_queue_overflow', 'server_queue_overflow']);
  });
});
