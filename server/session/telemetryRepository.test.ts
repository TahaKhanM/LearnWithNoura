import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomainRepository } from '../store/domain.js';
import type { MetricObservation } from '../../shared/sessionTelemetry.js';
import {
  SqliteWorkerTelemetryRepository,
  YieldingTelemetryRepository,
} from './telemetryRepository.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function observation(value: number): MetricObservation {
  return {
    schemaVersion: '1.0.0',
    name: 'speech_end_to_first_audio',
    unit: 'ms',
    value,
    connectionEpoch: 1,
    turnId: 'encoded-turn',
    generationId: 'encoded-generation',
  };
}

describe('telemetry repository adapters', () => {
  it('yields before invoking a synchronous in-memory repository', async () => {
    const calls: string[] = [];
    const repo = {
      addEvent() {
        const started = Date.now();
        while (Date.now() - started < 20) {
          // A deliberately synchronous test repository.
        }
        calls.push('append');
        return 1;
      },
      listEvents() {
        calls.push('lookup');
        return [];
      },
    } as unknown as DomainRepository;
    const adapter = new YieldingTelemetryRepository(repo);

    const append = adapter.appendMetric('session-1', observation(10));
    const lookup = adapter.hasPriorReleasedSessionStart('session-1', 2);
    calls.push('lesson-continued');

    expect(calls).toEqual(['lesson-continued']);
    await Promise.all([append, lookup]);
    expect(calls).toEqual(['lesson-continued', 'append', 'lookup']);
  });

  it('runs SQLite append and exact prior-start paging in its worker and closes cleanly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'noura-telemetry-worker-'));
    directories.push(directory);
    const databasePath = join(directory, 'noura.db');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        released INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO sessions (id, status) VALUES ('session-1', 'active');
      INSERT INTO events (session_id, ts, type, payload, released)
      VALUES ('session-1', 1, 'session_started', '{}', 1);
    `);
    database.close();

    const adapter = new SqliteWorkerTelemetryRepository(databasePath, {
      historyPageSize: 1,
      maxPending: 4,
    });
    const heartbeat = vi.fn();
    const append = adapter.appendMetric('session-1', observation(12));
    const lookup = adapter.hasPriorReleasedSessionStart('session-1', 3);
    queueMicrotask(heartbeat);

    await Promise.resolve();
    expect(heartbeat).toHaveBeenCalledOnce();
    await expect(append).resolves.toBeGreaterThan(1);
    await expect(lookup).resolves.toBe(true);
    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(adapter.appendMetric('session-1', observation(13)))
      .rejects.toThrow(/closed/i);

    const verify = new DatabaseSync(databasePath);
    const row = verify.prepare(
      "SELECT type, payload FROM events WHERE type = 'metric'",
    ).get() as { type: string; payload: string } | undefined;
    verify.close();
    expect(row?.type).toBe('metric');
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({ value: 12 });
  });
});
