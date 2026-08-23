import type { Pool, PoolClient } from 'pg';

export interface StorageSnapshot {
  schemaVersion: 1;
  exportedAt: number;
  children: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  events: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
}

export interface StorageCounts { children: number; sessions: number; events: number; evidence: number }

export interface PortableDurableStore {
  initialize(): Promise<void>;
  health(): Promise<boolean>;
  counts(): Promise<StorageCounts>;
  exportSnapshot(): Promise<StorageSnapshot>;
  importSnapshot(snapshot: StorageSnapshot): Promise<StorageCounts>;
  close(): Promise<void>;
}

/** Managed-Postgres adapter used by migration tooling and Production wiring. */
export class PostgresStore implements PortableDurableStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS children (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        age INTEGER,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL REFERENCES children(id),
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at BIGINT NOT NULL,
        ended_at BIGINT,
        summary_json JSONB,
        parent_session_id TEXT REFERENCES sessions(id),
        ended_event_id BIGINT,
        summary_version INTEGER,
        summary_through_event_id BIGINT
      );
      CREATE TABLE IF NOT EXISTS events (
        id BIGINT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        ts BIGINT NOT NULL,
        type TEXT NOT NULL,
        payload JSONB NOT NULL,
        released BOOLEAN NOT NULL DEFAULT TRUE
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id BIGINT PRIMARY KEY,
        evidence_id TEXT UNIQUE NOT NULL,
        child_id TEXT NOT NULL REFERENCES children(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        ts BIGINT NOT NULL,
        concept TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        observation TEXT NOT NULL,
        verdict TEXT NOT NULL,
        confidence TEXT NOT NULL,
        response_taxonomy TEXT NOT NULL,
        confidence_basis TEXT NOT NULL,
        source_event_ids JSONB NOT NULL,
        excerpt TEXT,
        normalized_excerpt TEXT NOT NULL,
        source_span_json JSONB,
        task_id TEXT NOT NULL,
        independence_level TEXT NOT NULL,
        domain_check_json JSONB,
        turn_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        contradicts_json JSONB NOT NULL,
        supersedes_json JSONB NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, ${Date.now()})
      ON CONFLICT (version) DO NOTHING;
    `);
  }

  async health(): Promise<boolean> {
    try { const result = await this.pool.query('SELECT 1 AS ok'); return result.rows[0]?.ok === 1; }
    catch { return false; }
  }

  async counts(): Promise<StorageCounts> {
    const result = await this.pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM children) AS children,
        (SELECT COUNT(*)::int FROM sessions) AS sessions,
        (SELECT COUNT(*)::int FROM events) AS events,
        (SELECT COUNT(*)::int FROM evidence) AS evidence
    `);
    const row = result.rows[0] as Record<string, unknown>;
    return {
      children: Number(row.children),
      sessions: Number(row.sessions),
      events: Number(row.events),
      evidence: Number(row.evidence),
    };
  }

  async exportSnapshot(): Promise<StorageSnapshot> {
    const [children, sessions, events, evidence] = await Promise.all([
      this.pool.query('SELECT * FROM children ORDER BY id'),
      this.pool.query('SELECT * FROM sessions ORDER BY id'),
      this.pool.query('SELECT * FROM events ORDER BY id'),
      this.pool.query('SELECT * FROM evidence ORDER BY id'),
    ]);
    return {
      schemaVersion: 1,
      exportedAt: Date.now(),
      children: children.rows,
      sessions: sessions.rows,
      events: events.rows,
      evidence: evidence.rows,
    };
  }

  async importSnapshot(snapshot: StorageSnapshot): Promise<StorageCounts> {
    if (snapshot.schemaVersion !== 1) throw new Error('Unsupported storage snapshot version.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of snapshot.children) await insertChild(client, row);
      for (const row of snapshot.sessions) await insertSession(client, row);
      for (const row of snapshot.events) await insertEvent(client, row);
      for (const row of snapshot.evidence) await insertEvidence(client, row);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const actual = await this.counts();
    const expected = {
      children: snapshot.children.length,
      sessions: snapshot.sessions.length,
      events: snapshot.events.length,
      evidence: snapshot.evidence.length,
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Postgres import row-count verification failed.');
    return actual;
  }

  async close(): Promise<void> { await this.pool.end(); }
}

async function insertChild(client: PoolClient, row: Record<string, unknown>): Promise<void> {
  await client.query('INSERT INTO children (id,parent_id,name,age,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING', [row.id, row.parent_id ?? 'local-synthetic-parent', row.name, row.age ?? null, row.created_at]);
}
async function insertSession(client: PoolClient, row: Record<string, unknown>): Promise<void> {
  await client.query('INSERT INTO sessions (id,child_id,goal,status,started_at,ended_at,summary_json,parent_session_id,ended_event_id,summary_version,summary_through_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING', [row.id,row.child_id,row.goal,row.status,row.started_at,row.ended_at ?? null,json(row.summary_json),row.parent_session_id ?? null,row.ended_event_id ?? null,row.summary_version ?? null,row.summary_through_event_id ?? null]);
}
async function insertEvent(client: PoolClient, row: Record<string, unknown>): Promise<void> {
  await client.query('INSERT INTO events (id,session_id,ts,type,payload,released) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [row.id,row.session_id,row.ts,row.type,json(row.payload),Boolean(row.released)]);
}
async function insertEvidence(client: PoolClient, row: Record<string, unknown>): Promise<void> {
  await client.query(`INSERT INTO evidence (
    id,evidence_id,child_id,session_id,ts,concept,concept_id,observation,verdict,confidence,response_taxonomy,
    confidence_basis,source_event_ids,excerpt,normalized_excerpt,source_span_json,task_id,independence_level,
    domain_check_json,turn_id,generation_id,contradicts_json,supersedes_json
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
  ON CONFLICT (id) DO NOTHING`, [
    row.id,row.evidence_id,row.child_id,row.session_id,row.ts,row.concept,row.concept_id,row.observation,row.verdict,row.confidence,row.response_taxonomy,
    row.confidence_basis,json(row.source_event_ids),row.excerpt ?? null,row.normalized_excerpt,json(row.source_span_json),row.task_id,row.independence_level,
    json(row.domain_check_json),row.turn_id,row.generation_id,json(row.contradicts_json ?? []),json(row.supersedes_json ?? []),
  ]);
}
function json(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}
