import { Worker } from 'node:worker_threads';
import type { MetricObservation } from '../../shared/sessionTelemetry.js';
import type { DomainRepository } from '../store/domain.js';

const DEFAULT_HISTORY_PAGE_SIZE = 5_000;
const DEFAULT_MAX_PENDING = 1_024;
export const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface TelemetryWriterLifecycle {
  flush(): Promise<void>;
}

export interface SessionTelemetryRepository {
  appendMetric(sessionId: string, observation: MetricObservation): Promise<number>;
  hasPriorReleasedSessionStart(
    sessionId: string,
    exclusiveUpperEventId: number,
  ): Promise<boolean>;
  registerWriter?(writer: TelemetryWriterLifecycle): () => void;
}

export interface ManagedSessionTelemetryRepository
  extends SessionTelemetryRepository {
  shutdown(timeoutMs?: number): Promise<void>;
}

export class AsyncDomainTelemetryRepository
implements SessionTelemetryRepository {
  private readonly writers = new Set<TelemetryWriterLifecycle>();
  constructor(
    private readonly repo: DomainRepository,
    private readonly historyPageSize = DEFAULT_HISTORY_PAGE_SIZE,
  ) {}

  async appendMetric(
    sessionId: string,
    observation: MetricObservation,
  ): Promise<number> {
    return await this.repo.addEvent(sessionId, 'metric', observation);
  }

  registerWriter(writer: TelemetryWriterLifecycle): () => void {
    this.writers.add(writer);
    return () => this.writers.delete(writer);
  }

  async shutdown(timeoutMs = TELEMETRY_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    await withShutdownBound(
      Promise.all([...this.writers].map((writer) => writer.flush())),
      timeoutMs,
    );
  }

  async hasPriorReleasedSessionStart(
    sessionId: string,
    exclusiveUpperEventId: number,
  ): Promise<boolean> {
    let throughEventId = exclusiveUpperEventId - 1;
    while (throughEventId >= 1) {
      const page = await this.repo.listEvents(
        sessionId,
        this.historyPageSize,
        throughEventId,
      );
      if (page.some((event) => event.type === 'session_started')) return true;
      if (page.length < this.historyPageSize) return false;
      const oldestEventId = page[0]?.id;
      if (oldestEventId === undefined || oldestEventId <= 1) return false;
      const nextThroughEventId = oldestEventId - 1;
      if (nextThroughEventId >= throughEventId) return false;
      throughEventId = nextThroughEventId;
    }
    return false;
  }
}

export class YieldingTelemetryRepository
extends AsyncDomainTelemetryRepository {
  override async appendMetric(
    sessionId: string,
    observation: MetricObservation,
  ): Promise<number> {
    await yieldToEventLoop();
    return super.appendMetric(sessionId, observation);
  }

  override async hasPriorReleasedSessionStart(
    sessionId: string,
    exclusiveUpperEventId: number,
  ): Promise<boolean> {
    await yieldToEventLoop();
    return super.hasPriorReleasedSessionStart(sessionId, exclusiveUpperEventId);
  }
}

type WorkerRequest =
  | {
      id: number;
      type: 'appendMetric';
      sessionId: string;
      observation: MetricObservation;
    }
  | {
      id: number;
      type: 'hasPriorReleasedSessionStart';
      sessionId: string;
      exclusiveUpperEventId: number;
      historyPageSize: number;
    }
  | { id: number; type: 'close' };

type WorkerResponse =
  | { id: number; ok: true; value: number | boolean | null }
  | { id: number; ok: false; error: string };

type PendingRequest = {
  resolve(value: number | boolean | null): void;
  reject(error: Error): void;
};

export class SqliteWorkerTelemetryRepository
implements ManagedSessionTelemetryRepository {
  private readonly worker: Worker;
  private readonly writers = new Set<TelemetryWriterLifecycle>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly historyPageSize: number;
  private readonly maxPending: number;
  private nextRequestId = 1;
  private state: 'open' | 'draining' | 'closing' | 'closed' = 'open';
  private closePromise: Promise<void> | null = null;

  constructor(
    databasePath: string,
    options: { historyPageSize?: number; maxPending?: number } = {},
  ) {
    this.historyPageSize = positiveInteger(
      options.historyPageSize,
      DEFAULT_HISTORY_PAGE_SIZE,
    );
    this.maxPending = positiveInteger(options.maxPending, DEFAULT_MAX_PENDING);
    this.worker = new Worker(SQLITE_WORKER_SOURCE, {
      eval: true,
      workerData: { databasePath },
    });
    this.worker.on('message', (message: unknown) => this.handleMessage(message));
    this.worker.on('error', (error) => this.failAll(error));
    this.worker.on('exit', (code) => {
      if (this.state !== 'closed' && code !== 0) {
        this.failAll(new Error(`Telemetry SQLite worker exited with code ${code}.`));
      }
    });
  }

  async appendMetric(
    sessionId: string,
    observation: MetricObservation,
  ): Promise<number> {
    const value = await this.request({
      id: this.nextRequestId++,
      type: 'appendMetric',
      sessionId,
      observation,
    });
    if (typeof value !== 'number') {
      throw new Error('Telemetry SQLite worker returned an invalid event ID.');
    }
    return value;
  }

  async hasPriorReleasedSessionStart(
    sessionId: string,
    exclusiveUpperEventId: number,
  ): Promise<boolean> {
    const value = await this.request({
      id: this.nextRequestId++,
      type: 'hasPriorReleasedSessionStart',
      sessionId,
      exclusiveUpperEventId,
      historyPageSize: this.historyPageSize,
    });
    if (typeof value !== 'boolean') {
      throw new Error('Telemetry SQLite worker returned an invalid lookup result.');
    }
    return value;
  }

  registerWriter(writer: TelemetryWriterLifecycle): () => void {
    this.writers.add(writer);
    return () => this.writers.delete(writer);
  }

  shutdown(timeoutMs = TELEMETRY_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === 'closed') return Promise.resolve();
    this.state = 'draining';
    this.closePromise = withShutdownBound(
      Promise.all([...this.writers].map((writer) => writer.flush())),
      timeoutMs,
    ).then(() => {
      this.state = 'closing';
      return this.request({
      id: this.nextRequestId++,
      type: 'close',
      }, true);
    }).then(async () => {
      await this.worker.terminate();
      this.state = 'closed';
    }).catch(async (error: unknown) => {
      await this.worker.terminate();
      this.state = 'closed';
      throw error;
    });
    return this.closePromise;
  }

  private request(
    message: WorkerRequest,
    allowClosing = false,
  ): Promise<number | boolean | null> {
    if (!['open', 'draining'].includes(this.state) &&
        !(allowClosing && this.state === 'closing')) {
      return Promise.reject(new Error('Telemetry SQLite worker is closed.'));
    }
    if (!allowClosing && this.pending.size >= this.maxPending) {
      return Promise.reject(new Error('Telemetry SQLite worker request queue is full.'));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject });
      this.worker.postMessage(message);
    });
  }

  private handleMessage(message: unknown): void {
    if (!isWorkerResponse(message)) {
      this.failAll(new Error('Telemetry SQLite worker returned a malformed response.'));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error));
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    if (this.state === 'open') this.state = 'closed';
  }
}

function withShutdownBound<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Telemetry shutdown timed out.')),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.id) || typeof candidate.ok !== 'boolean') {
    return false;
  }
  return candidate.ok
    ? candidate.value === null ||
      typeof candidate.value === 'number' ||
      typeof candidate.value === 'boolean'
    : typeof candidate.error === 'string';
}

const SQLITE_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(workerData.databasePath);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');

  function appendMetric(message) {
    const result = database.prepare(
      "INSERT INTO events (session_id, ts, type, payload, released) " +
      "SELECT ?, ?, 'metric', ?, 1 " +
      "WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND status = 'active')"
    ).run(
      message.sessionId,
      Date.now(),
      JSON.stringify(message.observation),
      message.sessionId
    );
    if (Number(result.changes) !== 1) {
      throw new Error('Session has ended and is immutable.');
    }
    return Number(result.lastInsertRowid);
  }

  function hasPriorReleasedSessionStart(message) {
    let throughEventId = message.exclusiveUpperEventId - 1;
    const statement = database.prepare(
      "SELECT id, type FROM events " +
      "WHERE session_id = ? AND released = 1 AND id <= ? " +
      "ORDER BY id DESC LIMIT ?"
    );
    while (throughEventId >= 1) {
      const page = statement.all(
        message.sessionId,
        throughEventId,
        message.historyPageSize
      );
      if (page.some((event) => event.type === 'session_started')) return true;
      if (page.length < message.historyPageSize) return false;
      const oldest = page[page.length - 1];
      if (!oldest || Number(oldest.id) <= 1) return false;
      const nextThroughEventId = Number(oldest.id) - 1;
      if (nextThroughEventId >= throughEventId) return false;
      throughEventId = nextThroughEventId;
    }
    return false;
  }

  parentPort.on('message', (message) => {
    try {
      let value = null;
      if (message.type === 'appendMetric') value = appendMetric(message);
      else if (message.type === 'hasPriorReleasedSessionStart') {
        value = hasPriorReleasedSessionStart(message);
      } else if (message.type === 'close') {
        database.close();
      } else {
        throw new Error('Unknown telemetry SQLite worker operation.');
      }
      parentPort.postMessage({ id: message.id, ok: true, value });
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        ok: false,
        error: String(error && error.message ? error.message : error).slice(0, 240),
      });
    }
  });
`;
