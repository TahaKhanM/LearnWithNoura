import { describe, expect, it } from 'vitest';
import { openTestDb } from '../store/db.js';
import { Repo } from '../store/repo.js';
import {
  metricContextFromIdentity,
  recordMetric,
} from './telemetryRecorder.js';

describe('telemetry recorder', () => {
  it('validates and records a released metric with server-owned context', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');

    const id = await recordMetric(repo, session.id, {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
    }, {
      connectionEpoch: 2,
      turnId: 'turn-0',
      generationId: 'generation-0',
    });

    expect(id).toEqual(expect.any(Number));
    expect(repo.listEvents(session.id)).toEqual([
      expect.objectContaining({
        type: 'metric',
        released: true,
        payload: expect.objectContaining({
          name: 'session_reconnect',
          connectionEpoch: 2,
          turnId: 'turn-0',
          generationId: 'generation-0',
        }),
      }),
    ]);
  });

  it('returns null and creates no event for invalid input', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Maya', 10);
    const session = repo.createSession(child.id, 'fractions');

    const id = await recordMetric(repo, session.id, {
      schemaVersion: '1.0.0',
      name: 'unknown_metric',
      unit: 'count',
      value: 1,
    }, {
      connectionEpoch: 2,
      turnId: 'turn-0',
      generationId: 'generation-0',
    });

    expect(id).toBeNull();
    expect(repo.listEvents(session.id)).toEqual([]);
  });

  it('derives metric context from authoritative identity', () => {
    expect(metricContextFromIdentity({
      sessionId: 'session-authoritative',
      connectionEpoch: 4,
      turnId: 'turn-authoritative',
      generationId: 'generation-authoritative',
    }, 'response-1')).toEqual({
      connectionEpoch: 4,
      turnId: 'turn-authoritative',
      generationId: 'generation-authoritative',
      providerResponseId: 'response-1',
    });
  });
});
