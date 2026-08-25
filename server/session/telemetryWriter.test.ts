import { describe, expect, it, vi } from 'vitest';
import type { MetricObservation } from '../../shared/sessionTelemetry.js';
import type { DomainRepository } from '../store/domain.js';
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
  it('submits without awaiting and persists successful observations in FIFO order', async () => {
    const firstWrite = deferred<number>();
    const persisted: MetricObservation[] = [];
    let callCount = 0;
    const addEvent = vi.fn((_sessionId: string, _type: string, payload: unknown) => {
      persisted.push(payload as MetricObservation);
      callCount += 1;
      return callCount === 1 ? firstWrite.promise : Promise.resolve(callCount);
    });
    const writer = new SessionTelemetryWriter(
      { addEvent } as unknown as DomainRepository,
      'session-1',
    );

    expect(writer.submit(metric(10), context)).toBe(true);
    expect(writer.submit(metric(20), context)).toBe(true);
    expect(writer.submit(metric(30), context)).toBe(true);
    expect(addEvent).toHaveBeenCalledTimes(1);

    firstWrite.resolve(1);
    await writer.flush();

    expect(persisted.map((entry) => entry.value)).toEqual([10, 20, 30]);
    expect(persisted.every((entry) => JSON.stringify(entry).includes('turn-private'))).toBe(false);
  });

  it('records an overflow gap before the next queued observation', async () => {
    const firstWrite = deferred<number>();
    const persisted: MetricObservation[] = [];
    let callCount = 0;
    const addEvent = vi.fn((_sessionId: string, _type: string, payload: unknown) => {
      persisted.push(payload as MetricObservation);
      callCount += 1;
      return callCount === 1 ? firstWrite.promise : Promise.resolve(callCount);
    });
    const writer = new SessionTelemetryWriter(
      { addEvent } as unknown as DomainRepository,
      'session-1',
      { capacity: 1 },
    );

    expect(writer.submit(metric(10), context)).toBe(true);
    expect(writer.submit(metric(20), context)).toBe(true);
    expect(writer.submit(metric(30), context)).toBe(false);
    firstWrite.resolve(1);
    await writer.flush();

    expect(persisted.map((entry) => entry.name)).toEqual([
      'speech_end_to_first_audio',
      'telemetry_gap',
      'speech_end_to_first_audio',
    ]);
    expect(persisted[1]).toMatchObject({
      value: 1,
      dimensions: { reason: 'server_queue_overflow' },
    });
  });

  it('turns persistence rejection into an ordered gap without rejecting lesson work', async () => {
    const persisted: MetricObservation[] = [];
    let attempt = 0;
    const addEvent = vi.fn(async (_sessionId: string, _type: string, payload: unknown) => {
      attempt += 1;
      if (attempt === 1) throw new Error('store unavailable');
      persisted.push(payload as MetricObservation);
      return attempt;
    });
    const writer = new SessionTelemetryWriter(
      { addEvent } as unknown as DomainRepository,
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
    const addEvent = vi.fn(async (_sessionId: string, _type: string, payload: unknown) => {
      if (!available) throw new Error('store unavailable');
      persisted.push(payload as MetricObservation);
      return persisted.length;
    });
    const writer = new SessionTelemetryWriter(
      { addEvent } as unknown as DomainRepository,
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
});
