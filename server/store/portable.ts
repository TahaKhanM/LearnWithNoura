import type { Pool, PoolClient } from 'pg';
import { PostgresRepo } from './postgresRepo.js';

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
    await new PostgresRepo(this.pool).initialize();
  }

  async health(): Promise<boolean> {
    try { const result = await this.pool.query('SELECT 1 AS ok'); return result.rows[0]?.ok === 1; }
    catch { return false; }
  }

  async counts(): Promise<StorageCounts> {
    const result = await this.pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM noura.children) AS children,
        (SELECT COUNT(*)::int FROM noura.sessions) AS sessions,
        (SELECT COUNT(*)::int FROM noura.events) AS events,
        (SELECT COUNT(*)::int FROM noura.evidence) AS evidence
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
      this.pool.query('SELECT * FROM noura.children ORDER BY id'),
      this.pool.query('SELECT * FROM noura.sessions ORDER BY id'),
      this.pool.query('SELECT * FROM noura.events ORDER BY id'),
      this.pool.query('SELECT * FROM noura.evidence ORDER BY id'),
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
      await client.query("SELECT setval(pg_get_serial_sequence('noura.events', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM noura.events), 1), 1), EXISTS (SELECT 1 FROM noura.events))");
      await client.query("SELECT setval(pg_get_serial_sequence('noura.evidence', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM noura.evidence), 1), 1), EXISTS (SELECT 1 FROM noura.evidence))");
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
  await client.query('INSERT INTO noura.children (id,parent_id,name,age,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING', [row.id, row.parent_id ?? 'local-synthetic-parent', row.name, row.age ?? null, row.created_at]);
}
async function insertSession(client: PoolClient, row: Record<string, unknown>): Promise<void> {
  await client.query('INSERT INTO noura.sessions (id,child_id,goal,status,started_at,ended_at,summary_json,parent_session_id,ended_event_id,summary_version,summary_through_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING', [row.id,row.child_id,row.goal,row.status,row.started_at,row.ended_at ?? null,json(row.summary_json),row.parent_session_id ?? null,row.ended_event_id ?? null,row.summary_version ?? null,row.summary_through_event_id ?? null]);
}
async function insertEvent(client: PoolClient, row: Record<string, unknown>): Promise<void> {
  await client.query('INSERT INTO noura.events (id,session_id,ts,type,payload,released,release_requested) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING', [row.id,row.session_id,row.ts,row.type,json(row.payload),Boolean(row.released),Boolean(row.release_requested)]);
}
async function insertEvidence(client: PoolClient, row: Record<string, unknown>): Promise<void> {
  await client.query(`INSERT INTO noura.evidence (
    id,evidence_id,child_id,session_id,ts,concept,concept_id,observation,verdict,confidence,response_taxonomy,
    confidence_basis,source_event_ids,excerpt,normalized_excerpt,source_span_json,task_id,independence_level,
    domain_check_json,turn_id,generation_id,contradicts_json,supersedes_json,opportunity_kind,retrieval_of,released,idempotency_key
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
  ON CONFLICT (id) DO NOTHING`, [
    row.id,row.evidence_id,row.child_id,row.session_id,row.ts,row.concept,row.concept_id,row.observation,row.verdict,row.confidence,row.response_taxonomy,
    row.confidence_basis,json(row.source_event_ids),row.excerpt ?? null,row.normalized_excerpt,json(row.source_span_json),row.task_id,row.independence_level,
    json(row.domain_check_json),row.turn_id,row.generation_id,json(row.contradicts_json ?? []),json(row.supersedes_json ?? []),
    row.opportunity_kind ?? 'recall',row.retrieval_of ?? null,row.released !== false,row.idempotency_key ?? null,
  ]);
}
function json(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}
