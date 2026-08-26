import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  CompiledLessonSchema,
  type CompiledLessonRecord,
  type CompiledLessonStatus,
  type CompiledLessonUpdate,
} from '../../shared/compiledLesson.js';
import type { ResponseTaxonomy } from '../../shared/pedagogy.js';
import type { DomainRepository, ManagedDomainRepository } from './domain.js';
import type {
  Child,
  Confidence,
  EventRow,
  EvidenceInput,
  EvidenceRow,
  FallbackTurnClaim,
  FallbackTurnIdentity,
  Session,
  SessionSummary,
  Verdict,
} from './repo.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Managed Postgres implementation of the complete Noura domain contract. */
export class PostgresRepo implements DomainRepository, ManagedDomainRepository {
  private initialized: Promise<void> | null = null;

  constructor(private readonly pool: Pool, private readonly autoMigrate = true) {}

  initialize(): Promise<void> {
    this.initialized ??= this.autoMigrate ? this.initializeSchema() : this.verifySchema();
    return this.initialized;
  }

  async health(): Promise<boolean> {
    try {
      await this.initialize();
      const result = await this.pool.query('SELECT 1 AS ok');
      return Number(result.rows[0]?.ok) === 1;
    } catch {
      return false;
    }
  }

  async createChild(name: string, age: number | null, parentId = 'local-synthetic-parent'): Promise<Child> {
    await this.initialize();
    const child: Child = { id: randomUUID(), parentId, name, age, createdAt: Date.now() };
    await this.pool.query(
      'INSERT INTO noura.children (id, parent_id, name, age, created_at) VALUES ($1, $2, $3, $4, $5)',
      [child.id, child.parentId, child.name, child.age, child.createdAt],
    );
    return child;
  }

  async listChildren(parentId?: string): Promise<Child[]> {
    await this.initialize();
    const result = await this.pool.query(
      'SELECT id, parent_id, name, age, created_at FROM noura.children WHERE ($1::text IS NULL OR parent_id = $1) ORDER BY created_at',
      [parentId ?? null],
    );
    return result.rows.map(mapChild);
  }

  async getChild(id: string): Promise<Child | null> {
    await this.initialize();
    return this.getChildWith(this.pool, id);
  }

  async getChildForParent(id: string, parentId: string): Promise<Child | null> {
    await this.initialize();
    const result = await this.pool.query(
      'SELECT id, parent_id, name, age, created_at FROM noura.children WHERE id = $1 AND parent_id = $2',
      [id, parentId],
    );
    return result.rows[0] ? mapChild(result.rows[0]) : null;
  }

  async getSessionForParent(id: string, parentId: string): Promise<Session | null> {
    await this.initialize();
    const result = await this.pool.query(
      `SELECT s.* FROM noura.sessions s
       JOIN noura.children c ON c.id = s.child_id
       WHERE s.id = $1 AND c.parent_id = $2`,
      [id, parentId],
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async createSession(childId: string, goal: string, parentSessionId: string | null = null): Promise<Session> {
    await this.initialize();
    return this.createSessionWith(this.pool, childId, goal, parentSessionId);
  }

  async getSession(id: string): Promise<Session | null> {
    await this.initialize();
    return this.getSessionWith(this.pool, id);
  }

  async listSessions(childId: string): Promise<Session[]> {
    await this.initialize();
    const result = await this.pool.query(
      'SELECT * FROM noura.sessions WHERE child_id = $1 ORDER BY started_at DESC, id DESC',
      [childId],
    );
    return result.rows.map(mapSession);
  }

  async endSession(id: string, summary: SessionSummary | null): Promise<Session | null> {
    await this.initialize();
    return this.transaction(async (client) => {
      const currentResult = await client.query('SELECT * FROM noura.sessions WHERE id = $1 FOR UPDATE', [id]);
      const current = currentResult.rows[0] ? mapSession(currentResult.rows[0]) : null;
      if (!current) return null;
      if (current.status === 'active') {
        const cutoff = await client.query(
          'SELECT MAX(id) AS id FROM noura.events WHERE session_id = $1 AND released = TRUE',
          [id],
        );
        await client.query(
          `UPDATE noura.sessions SET status = 'ended', ended_at = $1, ended_event_id = $2
           WHERE id = $3 AND status = 'active'`,
          [Date.now(), nullableNumber(cutoff.rows[0]?.id), id],
        );
      }
      if (summary) {
        await client.query(
          `UPDATE noura.sessions SET summary_json = $1, summary_version = $2,
             summary_through_event_id = ended_event_id WHERE id = $3 AND status = 'ended'`,
          [summary, current.summaryVersion ?? 1, id],
        );
      }
      return this.getSessionWith(client, id);
    });
  }

  async setSessionSummary(id: string, summary: SessionSummary, version = 1): Promise<void> {
    await this.initialize();
    const result = await this.pool.query(
      `UPDATE noura.sessions SET summary_json = $1, summary_version = $2,
         summary_through_event_id = ended_event_id WHERE id = $3 AND status = 'ended'`,
      [summary, version, id],
    );
    if (result.rowCount !== 1) throw new Error('Session must be ended before summary write.');
  }

  async createContinuation(id: string): Promise<Session> {
    await this.initialize();
    return this.transaction(async (client) => {
      const result = await client.query('SELECT * FROM noura.sessions WHERE id = $1 FOR UPDATE', [id]);
      const session = result.rows[0] ? mapSession(result.rows[0]) : null;
      if (!session || session.status !== 'ended') throw new Error('Only an ended session can continue.');
      return this.createSessionWith(client, session.childId, session.goal, session.id);
    });
  }

  async upsertCompiledLesson(sessionId: string, update: CompiledLessonUpdate): Promise<CompiledLessonRecord> {
    await this.initialize();
    if (update.status === 'ready' && !update.lesson) throw new Error('A ready compiled lesson requires the lesson payload.');
    const lesson = update.lesson ? CompiledLessonSchema.parse(update.lesson) : null;
    return this.transaction(async (client) => {
      const session = await this.getSessionWith(client, sessionId);
      if (!session) throw new Error('Unknown session.');
      const now = Date.now();
      await client.query(
        `INSERT INTO noura.compiled_lessons (session_id, status, lesson_json, failure_reason, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $5)
         ON CONFLICT (session_id) DO UPDATE SET
           status = EXCLUDED.status, lesson_json = EXCLUDED.lesson_json,
           failure_reason = EXCLUDED.failure_reason, updated_at = EXCLUDED.updated_at`,
        [sessionId, update.status, lesson ? JSON.stringify(lesson) : null, update.failureReason ?? null, now],
      );
      const stored = await this.getCompiledLessonWith(client, sessionId);
      if (!stored) throw new Error('Compiled lesson write failed.');
      return stored;
    });
  }

  async getCompiledLesson(sessionId: string): Promise<CompiledLessonRecord | null> {
    await this.initialize();
    return this.getCompiledLessonWith(this.pool, sessionId);
  }

  async claimFallbackTurn(identity: FallbackTurnIdentity): Promise<FallbackTurnClaim> {
    await this.initialize();
    return this.transaction(async (client) => {
      await this.assertActiveWith(client, identity.sessionId, true);
      const existing = await client.query(
        `SELECT status, steps_json FROM noura.fallback_turns
         WHERE session_id = $1 AND idempotency_key = $2`,
        [identity.sessionId, identity.idempotencyKey],
      );
      if (existing.rows[0]) {
        const status = String(existing.rows[0].status);
        if (status === 'completed') return { kind: 'completed', steps: jsonArray(existing.rows[0].steps_json) };
        return status === 'active' ? { kind: 'active' } : { kind: 'failed' };
      }
      const now = Date.now();
      await client.query(
        `UPDATE noura.fallback_turns SET status = 'cancelled', updated_at = $1
         WHERE session_id = $2 AND status = 'active'`,
        [now, identity.sessionId],
      );
      await client.query(
        `INSERT INTO noura.fallback_turns (
           session_id, idempotency_key, connection_epoch, turn_id, generation_id,
           status, steps_json, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', NULL, $6, $6)`,
        [identity.sessionId, identity.idempotencyKey, identity.connectionEpoch, identity.turnId, identity.generationId, now],
      );
      return { kind: 'started' };
    });
  }

  async isFallbackTurnActive(identity: FallbackTurnIdentity): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query(
      `SELECT 1 AS active
       FROM noura.fallback_turns f JOIN noura.sessions s ON s.id = f.session_id
       WHERE f.session_id = $1 AND f.idempotency_key = $2 AND f.connection_epoch = $3
         AND f.turn_id = $4 AND f.generation_id = $5 AND f.status = 'active'
         AND s.status = 'active'`,
      identityValues(identity),
    );
    return result.rowCount === 1;
  }

  async addFallbackEvent(identity: FallbackTurnIdentity, type: string, payload: unknown, released = false): Promise<number> {
    await this.initialize();
    const scopedPayload = {
      ...(isRecord(payload) ? payload : { value: payload }),
      turnId: identity.turnId,
      generationId: identity.generationId,
      idempotencyKey: identity.idempotencyKey,
    };
    const result = await this.pool.query(
      `INSERT INTO noura.events (session_id, ts, type, payload, released)
       SELECT $1::text, $6::bigint, $7::text, $8::jsonb, $9::boolean
       WHERE EXISTS (
         SELECT 1 FROM noura.fallback_turns f JOIN noura.sessions s ON s.id = f.session_id
         WHERE f.session_id = $1 AND f.idempotency_key = $2 AND f.connection_epoch = $3
           AND f.turn_id = $4 AND f.generation_id = $5 AND f.status = 'active' AND s.status = 'active'
       ) RETURNING id`,
      [...identityValues(identity), Date.now(), type, JSON.stringify(scopedPayload), released],
    );
    if (result.rowCount !== 1) throw new Error('Stale fallback generation write rejected.');
    return Number(result.rows[0].id);
  }

  async addFallbackEvidence(identity: FallbackTurnIdentity, entry: EvidenceInput): Promise<EvidenceRow> {
    await this.initialize();
    return this.transaction(async (client) => {
      if (!(await this.isFallbackTurnActiveWith(client, identity))) throw new Error('Stale fallback generation write rejected.');
      return this.addEvidenceWith(client, identity.sessionId, {
        ...entry,
        turnId: identity.turnId,
        generationId: identity.generationId,
        idempotencyKey: identity.idempotencyKey,
      }, false);
    });
  }

  async markFallbackEventReleased(identity: FallbackTurnIdentity, eventId: number): Promise<void> {
    await this.initialize();
    const result = await this.pool.query(
      `UPDATE noura.events e
       SET release_requested = TRUE,
           released = CASE WHEN EXISTS (
             SELECT 1 FROM noura.fallback_turns completed
             WHERE completed.session_id = $1 AND completed.idempotency_key = $2
               AND completed.connection_epoch = $3 AND completed.turn_id = $4
               AND completed.generation_id = $5 AND completed.status = 'completed'
           ) THEN TRUE ELSE e.released END
       WHERE e.id = $6 AND e.session_id = $1 AND e.payload ->> 'idempotencyKey' = $2
         AND e.payload ->> 'turnId' = $4 AND e.payload ->> 'generationId' = $5
         AND EXISTS (
           SELECT 1 FROM noura.fallback_turns f JOIN noura.sessions s ON s.id = f.session_id
           WHERE f.session_id = $1 AND f.idempotency_key = $2 AND f.connection_epoch = $3
             AND f.turn_id = $4 AND f.generation_id = $5 AND f.status IN ('active', 'completed')
             AND s.status = 'active'
         )`,
      [...identityValues(identity), eventId],
    );
    if (result.rowCount !== 1) throw new Error('Stale fallback checkpoint acknowledgement rejected.');
  }

  async finishFallbackTurn(identity: FallbackTurnIdentity, status: 'completed' | 'failed' | 'cancelled', steps: unknown[] = []): Promise<boolean> {
    await this.initialize();
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE noura.fallback_turns SET status = $6, steps_json = $7::jsonb, updated_at = $8
         WHERE session_id = $1 AND idempotency_key = $2 AND connection_epoch = $3
           AND turn_id = $4 AND generation_id = $5 AND status = 'active'`,
        [...identityValues(identity), status, status === 'completed' ? JSON.stringify(steps) : null, Date.now()],
      );
      if (result.rowCount !== 1) return false;
      if (status === 'completed') {
        await client.query(
          `UPDATE noura.events SET released = TRUE
           WHERE session_id = $1 AND payload ->> 'idempotencyKey' = $2
             AND payload ->> 'turnId' = $3 AND payload ->> 'generationId' = $4
             AND (type <> 'semantic_scene' OR release_requested = TRUE)`,
          [identity.sessionId, identity.idempotencyKey, identity.turnId, identity.generationId],
        );
        await client.query(
          `UPDATE noura.evidence SET released = TRUE
           WHERE session_id = $1 AND turn_id = $2 AND generation_id = $3 AND idempotency_key = $4`,
          [identity.sessionId, identity.turnId, identity.generationId, identity.idempotencyKey],
        );
      }
      return true;
    });
  }

  async getFallbackTurn(identity: Pick<FallbackTurnIdentity, 'sessionId' | 'idempotencyKey'>): Promise<{ status: string; steps: unknown[] } | null> {
    await this.initialize();
    const result = await this.pool.query(
      'SELECT status, steps_json FROM noura.fallback_turns WHERE session_id = $1 AND idempotency_key = $2',
      [identity.sessionId, identity.idempotencyKey],
    );
    return result.rows[0]
      ? { status: String(result.rows[0].status), steps: jsonArray(result.rows[0].steps_json) }
      : null;
  }

  async addEvent(sessionId: string, type: string, payload: unknown, released = true): Promise<number> {
    await this.initialize();
    return this.transaction(async (client) => {
      const session = await client.query(
        'SELECT status FROM noura.sessions WHERE id = $1 FOR UPDATE',
        [sessionId],
      );
      if (session.rowCount !== 1 || session.rows[0]?.status !== 'active') {
        throw new Error('Session has ended and is immutable.');
      }
      const result = await client.query(
        `INSERT INTO noura.events (session_id, ts, type, payload, released)
         VALUES ($1::text, $2::bigint, $3::text, $4::jsonb, $5::boolean)
         RETURNING id`,
        [sessionId, Date.now(), type, JSON.stringify(payload ?? {}), released],
      );
      return Number(result.rows[0].id);
    });
  }

  async markEventReleased(sessionId: string, eventId: number): Promise<void> {
    await this.initialize();
    const result = await this.pool.query(
      `UPDATE noura.events SET released = TRUE WHERE id = $1 AND session_id = $2
       AND EXISTS (SELECT 1 FROM noura.sessions WHERE id = $2 AND status = 'active')`,
      [eventId, sessionId],
    );
    if (result.rowCount !== 1) throw new Error('Session has ended and is immutable.');
  }

  async listEvents(sessionId: string, limit = 500, throughEventId?: number | null): Promise<EventRow[]> {
    await this.initialize();
    return this.readEvents(sessionId, limit, throughEventId, false);
  }

  async listEventsForInternalAudit(sessionId: string, limit = 500, throughEventId?: number | null): Promise<EventRow[]> {
    await this.initialize();
    return this.readEvents(sessionId, limit, throughEventId, true);
  }

  async addEvidence(sessionId: string, entry: EvidenceInput, released = true): Promise<EvidenceRow> {
    await this.initialize();
    return this.transaction((client) => this.addEvidenceWith(client, sessionId, entry, released));
  }

  async listEvidence(sessionId: string): Promise<EvidenceRow[]> {
    await this.initialize();
    const result = await this.pool.query(
      'SELECT * FROM noura.evidence WHERE session_id = $1 AND released = TRUE ORDER BY id',
      [sessionId],
    );
    return result.rows.map(mapEvidence);
  }

  async listEvidenceForInternalAudit(sessionId: string): Promise<EvidenceRow[]> {
    await this.initialize();
    const result = await this.pool.query('SELECT * FROM noura.evidence WHERE session_id = $1 ORDER BY id', [sessionId]);
    return result.rows.map(mapEvidence);
  }

  async listEvidenceForChild(childId: string, limit = 200): Promise<Array<EvidenceRow & { goal: string }>> {
    await this.initialize();
    const result = await this.pool.query(
      `SELECT e.*, s.goal FROM noura.evidence e JOIN noura.sessions s ON s.id = e.session_id
       WHERE s.child_id = $1 AND e.released = TRUE ORDER BY e.id DESC LIMIT $2`,
      [childId, boundedLimit(limit)],
    );
    return result.rows.map((row) => ({ ...mapEvidence(row), goal: String(row.goal) }));
  }

  async getEvidenceByEvidenceId(evidenceId: string): Promise<EvidenceRow | null> {
    await this.initialize();
    const result = await this.pool.query(
      'SELECT * FROM noura.evidence WHERE evidence_id = $1 AND released = TRUE',
      [evidenceId],
    );
    return result.rows[0] ? mapEvidence(result.rows[0]) : null;
  }

  private async initializeSchema(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS noura;
      CREATE TABLE IF NOT EXISTS noura.schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS noura.children (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        age INTEGER,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_noura_children_parent ON noura.children(parent_id, created_at);
      CREATE TABLE IF NOT EXISTS noura.sessions (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL REFERENCES noura.children(id),
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        started_at BIGINT NOT NULL,
        ended_at BIGINT,
        summary_json JSONB,
        parent_session_id TEXT REFERENCES noura.sessions(id),
        ended_event_id BIGINT,
        summary_version INTEGER,
        summary_through_event_id BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_noura_sessions_child ON noura.sessions(child_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_noura_sessions_parent ON noura.sessions(parent_session_id);
      CREATE TABLE IF NOT EXISTS noura.events (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES noura.sessions(id),
        ts BIGINT NOT NULL,
        type TEXT NOT NULL,
        payload JSONB NOT NULL,
        released BOOLEAN NOT NULL DEFAULT TRUE,
        release_requested BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_noura_events_session ON noura.events(session_id, id);
      CREATE TABLE IF NOT EXISTS noura.fallback_turns (
        session_id TEXT NOT NULL REFERENCES noura.sessions(id),
        idempotency_key TEXT NOT NULL,
        connection_epoch INTEGER NOT NULL,
        turn_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        steps_json JSONB,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (session_id, idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_noura_fallback_one_active_session
        ON noura.fallback_turns(session_id) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS noura.evidence (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES noura.sessions(id),
        ts BIGINT NOT NULL,
        concept TEXT NOT NULL,
        observation TEXT NOT NULL,
        verdict TEXT NOT NULL,
        confidence TEXT NOT NULL,
        excerpt TEXT,
        evidence_id TEXT UNIQUE NOT NULL,
        child_id TEXT NOT NULL REFERENCES noura.children(id),
        concept_id TEXT NOT NULL,
        response_taxonomy TEXT NOT NULL,
        confidence_basis TEXT NOT NULL,
        source_event_ids JSONB NOT NULL,
        normalized_excerpt TEXT NOT NULL,
        source_span_json JSONB,
        task_id TEXT NOT NULL,
        independence_level TEXT NOT NULL,
        domain_check_json JSONB,
        turn_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        contradicts_json JSONB NOT NULL,
        supersedes_json JSONB NOT NULL,
        opportunity_kind TEXT NOT NULL DEFAULT 'recall',
        retrieval_of TEXT,
        released BOOLEAN NOT NULL DEFAULT TRUE,
        idempotency_key TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_noura_evidence_session ON noura.evidence(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_noura_evidence_child ON noura.evidence(child_id, id DESC);
      CREATE TABLE IF NOT EXISTS noura.compiled_lessons (
        session_id TEXT PRIMARY KEY REFERENCES noura.sessions(id),
        status TEXT NOT NULL,
        lesson_json JSONB,
        failure_reason TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      INSERT INTO noura.schema_migrations (version, applied_at) VALUES (1, ${Date.now()})
      ON CONFLICT (version) DO NOTHING;
      INSERT INTO noura.schema_migrations (version, applied_at) VALUES (2, ${Date.now()})
      ON CONFLICT (version) DO NOTHING;
    `);
  }

  private async verifySchema(): Promise<void> {
    const result = await this.pool.query(
      'SELECT version FROM noura.schema_migrations WHERE version IN (1, 2)',
    );
    if (result.rowCount !== 2) throw new Error('Noura Postgres schema migrations 1 and 2 are not both applied.');
  }

  private async getChildWith(queryable: Queryable, id: string): Promise<Child | null> {
    const result = await queryable.query(
      'SELECT id, parent_id, name, age, created_at FROM noura.children WHERE id = $1',
      [id],
    );
    return result.rows[0] ? mapChild(result.rows[0]) : null;
  }

  private async getSessionWith(queryable: Queryable, id: string): Promise<Session | null> {
    const result = await queryable.query('SELECT * FROM noura.sessions WHERE id = $1', [id]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  private async getCompiledLessonWith(queryable: Queryable, sessionId: string): Promise<CompiledLessonRecord | null> {
    const result = await queryable.query(
      'SELECT session_id, status, lesson_json, failure_reason, created_at, updated_at FROM noura.compiled_lessons WHERE session_id = $1',
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionId: String(row.session_id),
      status: String(row.status) as CompiledLessonStatus,
      lesson: row.lesson_json ? CompiledLessonSchema.parse(jsonValue(row.lesson_json)) : null,
      failureReason: nullableString(row.failure_reason),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private async createSessionWith(queryable: Queryable, childId: string, goal: string, parentSessionId: string | null): Promise<Session> {
    const session: Session = {
      id: randomUUID(), childId, goal, status: 'active', startedAt: Date.now(), endedAt: null,
      summary: null, parentSessionId, endedEventId: null, summaryVersion: null, summaryThroughEventId: null,
    };
    await queryable.query(
      `INSERT INTO noura.sessions (id, child_id, goal, status, started_at, parent_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [session.id, session.childId, session.goal, session.status, session.startedAt, session.parentSessionId],
    );
    return session;
  }

  private async readEvents(sessionId: string, limit: number, throughEventId: number | null | undefined, includeUnreleased: boolean): Promise<EventRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM (
         SELECT id, session_id, ts, type, payload, released FROM noura.events
         WHERE session_id = $1 AND ($2::boolean = TRUE OR released = TRUE)
           AND ($3::bigint IS NULL OR id <= $3)
         ORDER BY id DESC LIMIT $4
       ) latest ORDER BY id`,
      [sessionId, includeUnreleased, throughEventId ?? null, boundedLimit(limit)],
    );
    return result.rows.map(mapEvent);
  }

  private async addEvidenceWith(queryable: Queryable, sessionId: string, entry: EvidenceInput, released: boolean): Promise<EvidenceRow> {
    await this.assertActiveWith(queryable, sessionId);
    const session = await this.getSessionWith(queryable, sessionId);
    if (!session) throw new Error('Unknown session.');
    const sourceEventIds = [...new Set(entry.sourceEventIds ?? [])];
    if (sourceEventIds.length === 0) throw new Error('Evidence requires at least one source event ID.');
    const excerpt = normalizeExcerpt(entry.excerpt ?? '');
    const sourceSpan = excerpt ? await this.validateExcerptWith(queryable, sessionId, sourceEventIds, excerpt) : null;
    const evidenceId = randomUUID();
    const result = await queryable.query(
      `INSERT INTO noura.evidence (
         session_id, ts, concept, observation, verdict, confidence, excerpt,
         evidence_id, child_id, concept_id, response_taxonomy, confidence_basis,
         source_event_ids, normalized_excerpt, source_span_json, task_id,
         independence_level, domain_check_json, turn_id, generation_id,
         contradicts_json, supersedes_json, opportunity_kind, retrieval_of, released, idempotency_key
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16,
         $17,$18::jsonb,$19,$20,$21::jsonb,$22::jsonb,$23,$24,$25,$26
       ) RETURNING *`,
      [
        sessionId, Date.now(), entry.concept, entry.observation, entry.verdict, entry.confidence,
        entry.excerpt ?? null, evidenceId, session.childId, normalizeConcept(entry.concept),
        entry.classification ?? taxonomyFromVerdict(entry.verdict),
        entry.confidenceBasis ?? `${entry.confidence} confidence model observation`,
        JSON.stringify(sourceEventIds), excerpt, JSON.stringify(sourceSpan),
        entry.taskId ?? 'unspecified-opportunity', entry.independenceLevel ?? 'reduced',
        JSON.stringify(entry.domainCheck ?? null), entry.turnId ?? 'legacy-turn',
        entry.generationId ?? 'legacy-generation', JSON.stringify(entry.contradicts ?? []),
        JSON.stringify(entry.supersedes ?? []), entry.opportunityKind ?? 'recall',
        entry.retrievalOf ?? null, released, entry.idempotencyKey ?? null,
      ],
    );
    return mapEvidence(result.rows[0]);
  }

  private async validateExcerptWith(queryable: Queryable, sessionId: string, sourceEventIds: number[], excerpt: string): Promise<{ eventId: number; start: number; end: number }> {
    const placeholders = sourceEventIds.map((_, index) => `$${index + 2}`).join(', ');
    const result = await queryable.query(
      `SELECT id, payload FROM noura.events WHERE session_id = $1 AND id IN (${placeholders}) ORDER BY id`,
      [sessionId, ...sourceEventIds],
    );
    for (const row of result.rows) {
      const payload = jsonObject(row.payload);
      const source = normalizeExcerpt(typeof payload.text === 'string' ? payload.text : '');
      const start = source.indexOf(excerpt);
      if (start >= 0) return { eventId: Number(row.id), start, end: start + excerpt.length };
    }
    throw new Error('Evidence excerpt does not match its source events.');
  }

  private async assertActiveWith(queryable: Queryable, sessionId: string, lock = false): Promise<void> {
    const result = await queryable.query(
      `SELECT status FROM noura.sessions WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [sessionId],
    );
    if (!result.rows[0]) throw new Error('Unknown session.');
    if (result.rows[0].status !== 'active') throw new Error('Session has ended and is immutable.');
  }

  private async isFallbackTurnActiveWith(queryable: Queryable, identity: FallbackTurnIdentity): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 AS active FROM noura.fallback_turns f JOIN noura.sessions s ON s.id = f.session_id
       WHERE f.session_id = $1 AND f.idempotency_key = $2 AND f.connection_epoch = $3
         AND f.turn_id = $4 AND f.generation_id = $5 AND f.status = 'active' AND s.status = 'active'`,
      identityValues(identity),
    );
    return result.rowCount === 1;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function identityValues(identity: FallbackTurnIdentity): [string, string, number, string, string] {
  return [identity.sessionId, identity.idempotencyKey, identity.connectionEpoch, identity.turnId, identity.generationId];
}

function mapChild(row: QueryResultRow): Child {
  return { id: String(row.id), parentId: String(row.parent_id), name: String(row.name), age: nullableNumber(row.age), createdAt: Number(row.created_at) };
}

function mapSession(row: QueryResultRow): Session {
  return {
    id: String(row.id), childId: String(row.child_id), goal: String(row.goal), status: String(row.status) as Session['status'],
    startedAt: Number(row.started_at), endedAt: nullableNumber(row.ended_at),
    summary: row.summary_json ? jsonObject(row.summary_json) as unknown as SessionSummary : null,
    parentSessionId: nullableString(row.parent_session_id), endedEventId: nullableNumber(row.ended_event_id),
    summaryVersion: nullableNumber(row.summary_version), summaryThroughEventId: nullableNumber(row.summary_through_event_id),
  };
}

function mapEvent(row: QueryResultRow): EventRow {
  return { id: Number(row.id), sessionId: String(row.session_id), ts: Number(row.ts), type: String(row.type), payload: jsonValue(row.payload), released: Boolean(row.released) };
}

function mapEvidence(row: QueryResultRow): EvidenceRow {
  return {
    id: Number(row.id), sessionId: String(row.session_id), ts: Number(row.ts), concept: String(row.concept),
    observation: String(row.observation), verdict: String(row.verdict) as Verdict, confidence: String(row.confidence) as Confidence,
    excerpt: nullableString(row.excerpt), evidenceId: String(row.evidence_id), childId: String(row.child_id),
    conceptId: String(row.concept_id), taxonomy: String(row.response_taxonomy) as ResponseTaxonomy,
    confidenceBasis: String(row.confidence_basis), sourceEventIds: jsonArray(row.source_event_ids).map(Number),
    normalizedExcerpt: String(row.normalized_excerpt ?? ''),
    sourceSpan: row.source_span_json ? jsonObject(row.source_span_json) as EvidenceRow['sourceSpan'] : null,
    taskId: String(row.task_id), independenceLevel: String(row.independence_level) as EvidenceRow['independenceLevel'],
    domainCheck: jsonValue(row.domain_check_json), turnId: String(row.turn_id), generationId: String(row.generation_id),
    contradicts: jsonArray(row.contradicts_json).map(String), supersedes: jsonArray(row.supersedes_json).map(String),
    opportunityKind: String(row.opportunity_kind) as EvidenceRow['opportunityKind'], retrievalOf: nullableString(row.retrieval_of),
    idempotencyKey: nullableString(row.idempotency_key),
  };
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return isRecord(parsed) ? parsed : {};
}

function jsonArray(value: unknown): unknown[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(5000, Math.round(limit)));
}

function normalizeExcerpt(value: string): string {
  return value.normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
}

function normalizeConcept(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 160) || 'unspecified';
}

function taxonomyFromVerdict(verdict: Verdict): ResponseTaxonomy {
  if (verdict === 'misconception') return 'confident_misconception';
  if (verdict === 'struggling') return 'incorrect';
  return 'correct';
}
