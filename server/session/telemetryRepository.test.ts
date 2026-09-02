import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomainRepository } from '../store/domain.js';
import { Repo } from '../store/repo.js';
import { SessionTelemetryWriter } from './telemetryWriter.js';
import type { MetricObservation } from '../../shared/sessionTelemetry.js';
import {
  AsyncDomainTelemetryRepository,
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
  it('awaits registered writers and surfaces failing shutdown flushes', async () => {
    const adapter = new AsyncDomainTelemetryRepository({} as DomainRepository);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    adapter.registerWriter({ flush: () => pending });
    const shutdown = adapter.shutdown(1_000);
    let settled = false;
    void shutdown.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(shutdown).resolves.toBeUndefined();

    const failing = new AsyncDomainTelemetryRepository({} as DomainRepository);
    failing.registerWriter({
      flush: async () => { throw new Error('flush failed'); },
    });
    await expect(failing.shutdown(1_000)).rejects.toThrow('flush failed');
  });

  it('retries a writer retained after close failure during repository shutdown', async () => {
    let available = false;
    const stored: MetricObservation[] = [];
    const domain = {
      async addEvent(_sessionId: string, _type: string, payload: unknown) {
        if (!available) throw new Error('offline');
        stored.push(payload as MetricObservation);
        return stored.length;
      },
    } as DomainRepository;
    const adapter = new AsyncDomainTelemetryRepository(domain);
    const writer = new SessionTelemetryWriter(adapter, 'session-1');
    writer.submit(observation(7), {
      connectionEpoch: 1,
      turnId: 'turn-1',
      generationId: 'generation-1',
    });
    await expect(writer.close()).rejects.toThrow(/incomplete/i);
    available = true;
    await expect(adapter.shutdown()).resolves.toBeUndefined();
    expect(stored).toEqual([
      expect.objectContaining({
        name: 'telemetry_gap',
        dimensions: { reason: 'server_persistence_failure' },
      }),
    ]);
  });

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
    await expect(adapter.shutdown()).resolves.toBeUndefined();
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

  it('waits for a short competing SQLite writer instead of dropping the metric', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'noura-telemetry-lock-'));
    directories.push(directory);
    const databasePath = join(directory, 'noura.db');
    const blocker = new DatabaseSync(databasePath);
    blocker.exec(`
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
      BEGIN IMMEDIATE;
    `);
    const adapter = new SqliteWorkerTelemetryRepository(databasePath);
    const append = adapter.appendMetric('session-1', observation(14));

    await new Promise((resolve) => setTimeout(resolve, 40));
    blocker.exec('COMMIT');
    await expect(append).resolves.toBeGreaterThan(0);

    await adapter.shutdown();
    blocker.close();
  });

  it('serializes worker append against the immutable SQLite end cutoff', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'noura-end-race-'));
    directories.push(directory);
    const databasePath = join(directory, 'noura.db');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE children (
        id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL,
        age INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, child_id TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
        summary_json TEXT, parent_session_id TEXT, ended_event_id INTEGER,
        summary_version INTEGER, summary_through_event_id INTEGER
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        released INTEGER NOT NULL DEFAULT 1, release_requested INTEGER NOT NULL DEFAULT 0
      );
    `);
    const repo = new Repo(database);
    const child = repo.createChild('Synthetic', 10);
    const session = repo.createSession(child.id, 'cutoff race');
    const adapter = new SqliteWorkerTelemetryRepository(databasePath);
    const append = adapter.appendMetric(session.id, observation(12));
    const ended = repo.endSession(session.id, null);
    await Promise.allSettled([append]);
    const events = repo.listEventsForInternalAudit(session.id);
    expect(ended?.endedEventId).toBe(repo.getSession(session.id)?.endedEventId);
    expect(events.every((event) =>
      event.id <= (ended?.endedEventId ?? 0))).toBe(true);
    await adapter.shutdown();
    database.close();
  });
});
