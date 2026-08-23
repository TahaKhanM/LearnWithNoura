import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EvidenceOpportunityKind, ResponseTaxonomy } from '../../shared/pedagogy.js';

export interface Child {
  id: string;
  parentId: string;
  name: string;
  age: number | null;
  createdAt: number;
}

export interface Session {
  id: string;
  childId: string;
  goal: string;
  status: 'active' | 'ended';
  startedAt: number;
  endedAt: number | null;
  summary: SessionSummary | null;
  parentSessionId: string | null;
  endedEventId: number | null;
  summaryVersion: number | null;
  summaryThroughEventId: number | null;
}

/** Calibrated language only — no invented mastery percentages. */
export interface SessionSummary {
  version?: number;
  throughEventId?: number | null;
  headline: string;
  workedOn: string[];
  strengths: { concept: string; evidence: string; evidenceIds?: string[]; status: 'progressing' | 'demonstrated' }[];
  struggles: { concept: string; evidence: string; evidenceIds?: string[]; kind: 'misconception' | 'gap' | 'uncertain' }[];
  recommendation: string;
  recommendationEvidenceIds?: string[];
  confidenceNote: string;
}

export type Verdict = 'mastered' | 'progressing' | 'struggling' | 'misconception';
export type Confidence = 'low' | 'medium' | 'high';

export interface EvidenceRow {
  id: number;
  sessionId: string;
  ts: number;
  concept: string;
  observation: string;
  verdict: Verdict;
  confidence: Confidence;
  excerpt: string | null;
  evidenceId: string;
  childId: string;
  conceptId: string;
  taxonomy: ResponseTaxonomy;
  confidenceBasis: string;
  sourceEventIds: number[];
  normalizedExcerpt: string;
  sourceSpan: { eventId: number; start: number; end: number } | null;
  taskId: string;
  independenceLevel: 'none' | 'reduced' | 'independent';
  domainCheck: unknown;
  turnId: string;
  generationId: string;
  contradicts: string[];
  supersedes: string[];
  opportunityKind: EvidenceOpportunityKind;
  retrievalOf: string | null;
  idempotencyKey?: string | null;
}

export interface EvidenceInput {
  concept: string;
  observation: string;
  verdict: Verdict;
  confidence: Confidence;
  excerpt?: string;
  classification?: ResponseTaxonomy;
  confidenceBasis?: string;
  sourceEventIds?: number[];
  taskId?: string;
  independenceLevel?: 'none' | 'reduced' | 'independent';
  domainCheck?: unknown;
  turnId?: string;
  generationId?: string;
  contradicts?: string[];
  supersedes?: string[];
  opportunityKind?: EvidenceOpportunityKind;
  retrievalOf?: string;
  idempotencyKey?: string;
}

export interface EventRow {
  id: number;
  sessionId: string;
  ts: number;
  type: string;
  payload: unknown;
  released: boolean;
}

export interface FallbackTurnIdentity {
  sessionId: string;
  idempotencyKey: string;
  connectionEpoch: number;
  turnId: string;
  generationId: string;
}

export type FallbackTurnClaim =
  | { kind: 'started' }
  | { kind: 'active' }
  | { kind: 'completed'; steps: unknown[] }
  | { kind: 'failed' };

export class Repo {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createChild(name: string, age: number | null, parentId = 'local-synthetic-parent'): Child {
    const child: Child = { id: randomUUID(), parentId, name, age, createdAt: Date.now() };
    this.db
      .prepare('INSERT INTO children (id, parent_id, name, age, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(child.id, child.parentId, child.name, child.age, child.createdAt);
    return child;
  }

  listChildren(parentId?: string): Child[] {
    const rows = this.db
      .prepare('SELECT id, parent_id, name, age, created_at FROM children WHERE (? IS NULL OR parent_id = ?) ORDER BY created_at')
      .all(parentId ?? null, parentId ?? null) as unknown as { id: string; parent_id: string; name: string; age: number | null; created_at: number }[];
    return rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, age: r.age, createdAt: r.created_at }));
  }

  getChild(id: string): Child | null {
    const r = this.db
      .prepare('SELECT id, parent_id, name, age, created_at FROM children WHERE id = ?')
      .get(id) as { id: string; parent_id: string; name: string; age: number | null; created_at: number } | undefined;
    return r ? { id: r.id, parentId: r.parent_id, name: r.name, age: r.age, createdAt: r.created_at } : null;
  }

  getChildForParent(id: string, parentId: string): Child | null {
    const child = this.getChild(id);
    return child?.parentId === parentId ? child : null;
  }

  getSessionForParent(id: string, parentId: string): Session | null {
    const session = this.getSession(id);
    return session && this.getChildForParent(session.childId, parentId) ? session : null;
  }

  createSession(childId: string, goal: string, parentSessionId: string | null = null): Session {
    const session: Session = {
      id: randomUUID(),
      childId,
      goal,
      status: 'active',
      startedAt: Date.now(),
      endedAt: null,
      summary: null,
      parentSessionId,
      endedEventId: null,
      summaryVersion: null,
      summaryThroughEventId: null,
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, child_id, goal, status, started_at, parent_session_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(session.id, childId, goal, session.status, session.startedAt, parentSessionId);
    return session;
  }

  getSession(id: string): Session | null {
    const r = this.db
      .prepare(
        'SELECT id, child_id, goal, status, started_at, ended_at, summary_json, parent_session_id, ended_event_id, summary_version, summary_through_event_id FROM sessions WHERE id = ?',
      )
      .get(id) as
      | {
          id: string;
          child_id: string;
          goal: string;
          status: string;
          started_at: number;
          ended_at: number | null;
          summary_json: string | null;
          parent_session_id: string | null;
          ended_event_id: number | null;
          summary_version: number | null;
          summary_through_event_id: number | null;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      childId: r.child_id,
      goal: r.goal,
      status: r.status as Session['status'],
      startedAt: r.started_at,
      endedAt: r.ended_at,
      summary: r.summary_json ? (JSON.parse(r.summary_json) as SessionSummary) : null,
      parentSessionId: r.parent_session_id,
      endedEventId: r.ended_event_id,
      summaryVersion: r.summary_version,
      summaryThroughEventId: r.summary_through_event_id,
    };
  }

  listSessions(childId: string): Session[] {
    const rows = this.db
      .prepare(
        'SELECT id FROM sessions WHERE child_id = ? ORDER BY started_at DESC, id DESC',
      )
      .all(childId) as unknown as { id: string }[];
    return rows
      .map((r) => this.getSession(r.id))
      .filter((s): s is Session => s !== null);
  }

  endSession(id: string, summary: SessionSummary | null): Session | null {
    const current = this.getSession(id);
    if (!current) return null;
    if (current.status === 'active') {
      const cutoff = this.latestEventId(id);
      this.db
        .prepare("UPDATE sessions SET status = 'ended', ended_at = ?, ended_event_id = ? WHERE id = ? AND status = 'active'")
        .run(Date.now(), cutoff, id);
    }
    if (summary) this.setSessionSummary(id, summary, current.summaryVersion ?? 1);
    return this.getSession(id);
  }

  setSessionSummary(id: string, summary: SessionSummary, version = 1): void {
    const session = this.getSession(id);
    if (!session || session.status !== 'ended') throw new Error('Session must be ended before summary write.');
    this.db
      .prepare('UPDATE sessions SET summary_json = ?, summary_version = ?, summary_through_event_id = ended_event_id WHERE id = ?')
      .run(JSON.stringify(summary), version, id);
  }

  createContinuation(id: string): Session {
    const session = this.getSession(id);
    if (!session || session.status !== 'ended') throw new Error('Only an ended session can continue.');
    return this.createSession(session.childId, session.goal, session.id);
  }

  /**
   * Atomically supersedes the previous fallback generation for this session.
   * The idempotency row is durable, while the provider AbortController stays
   * process-local. Every later mutation rechecks this row before writing.
   */
  claimFallbackTurn(identity: FallbackTurnIdentity): FallbackTurnClaim {
    this.assertActive(identity.sessionId);
    const existing = this.db.prepare(
      'SELECT status, steps_json FROM fallback_turns WHERE session_id = ? AND idempotency_key = ?',
    ).get(identity.sessionId, identity.idempotencyKey) as { status: string; steps_json: string | null } | undefined;
    if (existing) {
      if (existing.status === 'completed') {
        const parsed = existing.steps_json ? safeParse(existing.steps_json) : [];
        return { kind: 'completed', steps: Array.isArray(parsed) ? parsed : [] };
      }
      return existing.status === 'active' ? { kind: 'active' } : { kind: 'failed' };
    }

    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        "UPDATE fallback_turns SET status = 'cancelled', updated_at = ? WHERE session_id = ? AND status = 'active'",
      ).run(now, identity.sessionId);
      this.db.prepare(
        `INSERT INTO fallback_turns (
          session_id, idempotency_key, connection_epoch, turn_id, generation_id,
          status, steps_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      ).run(
        identity.sessionId,
        identity.idempotencyKey,
        identity.connectionEpoch,
        identity.turnId,
        identity.generationId,
        now,
        now,
      );
      this.db.exec('COMMIT');
      return { kind: 'started' };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  isFallbackTurnActive(identity: FallbackTurnIdentity): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS active
       FROM fallback_turns f JOIN sessions s ON s.id = f.session_id
       WHERE f.session_id = ? AND f.idempotency_key = ? AND f.connection_epoch = ?
         AND f.turn_id = ? AND f.generation_id = ? AND f.status = 'active'
         AND s.status = 'active'`,
    ).get(
      identity.sessionId,
      identity.idempotencyKey,
      identity.connectionEpoch,
      identity.turnId,
      identity.generationId,
    ) as { active: number } | undefined;
    return Boolean(row);
  }

  addFallbackEvent(identity: FallbackTurnIdentity, type: string, payload: unknown, released = false): number {
    const scopedPayload = {
      ...(isRecord(payload) ? payload : { value: payload }),
      turnId: identity.turnId,
      generationId: identity.generationId,
      idempotencyKey: identity.idempotencyKey,
    };
    const result = this.db.prepare(
      `INSERT INTO events (session_id, ts, type, payload, released)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM fallback_turns f JOIN sessions s ON s.id = f.session_id
         WHERE f.session_id = ? AND f.idempotency_key = ? AND f.connection_epoch = ?
           AND f.turn_id = ? AND f.generation_id = ? AND f.status = 'active' AND s.status = 'active'
       )`,
    ).run(
      identity.sessionId, Date.now(), type, JSON.stringify(scopedPayload), released ? 1 : 0,
      identity.sessionId, identity.idempotencyKey, identity.connectionEpoch, identity.turnId, identity.generationId,
    );
    if (Number(result.changes) !== 1) throw new Error('Stale fallback generation write rejected.');
    return Number(result.lastInsertRowid);
  }

  addFallbackEvidence(
    identity: FallbackTurnIdentity,
    entry: EvidenceInput,
  ): EvidenceRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.isFallbackTurnActive(identity)) throw new Error('Stale fallback generation write rejected.');
      const stored = this.addEvidence(identity.sessionId, {
        ...entry,
        turnId: identity.turnId,
        generationId: identity.generationId,
        idempotencyKey: identity.idempotencyKey,
      }, false);
      this.db.exec('COMMIT');
      return stored;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markFallbackEventReleased(identity: FallbackTurnIdentity, eventId: number): void {
    const result = this.db.prepare(
      `UPDATE events
       SET release_requested = 1,
           released = CASE WHEN EXISTS (
             SELECT 1 FROM fallback_turns completed
             WHERE completed.session_id = ? AND completed.idempotency_key = ?
               AND completed.connection_epoch = ? AND completed.turn_id = ?
               AND completed.generation_id = ? AND completed.status = 'completed'
           ) THEN 1 ELSE released END
       WHERE id = ? AND session_id = ? AND json_extract(payload, '$.idempotencyKey') = ?
         AND json_extract(payload, '$.turnId') = ? AND json_extract(payload, '$.generationId') = ?
         AND EXISTS (
           SELECT 1 FROM fallback_turns f JOIN sessions s ON s.id = f.session_id
           WHERE f.session_id = ? AND f.idempotency_key = ? AND f.connection_epoch = ?
             AND f.turn_id = ? AND f.generation_id = ? AND f.status IN ('active', 'completed') AND s.status = 'active'
         )`,
    ).run(
      identity.sessionId, identity.idempotencyKey, identity.connectionEpoch, identity.turnId, identity.generationId,
      eventId, identity.sessionId, identity.idempotencyKey, identity.turnId, identity.generationId,
      identity.sessionId, identity.idempotencyKey, identity.connectionEpoch, identity.turnId, identity.generationId,
    );
    if (Number(result.changes) !== 1) throw new Error('Stale fallback checkpoint acknowledgement rejected.');
  }

  finishFallbackTurn(identity: FallbackTurnIdentity, status: 'completed' | 'failed' | 'cancelled', steps: unknown[] = []): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(
        `UPDATE fallback_turns SET status = ?, steps_json = ?, updated_at = ?
         WHERE session_id = ? AND idempotency_key = ? AND connection_epoch = ?
           AND turn_id = ? AND generation_id = ? AND status = 'active'`,
      ).run(
        status,
        status === 'completed' ? JSON.stringify(steps) : null,
        Date.now(),
        identity.sessionId,
        identity.idempotencyKey,
        identity.connectionEpoch,
        identity.turnId,
        identity.generationId,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (status === 'completed') {
        this.db.prepare(
          `UPDATE events SET released = 1
           WHERE session_id = ? AND json_extract(payload, '$.idempotencyKey') = ?
             AND json_extract(payload, '$.turnId') = ? AND json_extract(payload, '$.generationId') = ?
             AND (type <> 'semantic_scene' OR release_requested = 1)`,
        ).run(identity.sessionId, identity.idempotencyKey, identity.turnId, identity.generationId);
        this.db.prepare(
          `UPDATE evidence SET released = 1
           WHERE session_id = ? AND turn_id = ? AND generation_id = ? AND idempotency_key = ?`,
        ).run(identity.sessionId, identity.turnId, identity.generationId, identity.idempotencyKey);
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getFallbackTurn(identity: Pick<FallbackTurnIdentity, 'sessionId' | 'idempotencyKey'>): { status: string; steps: unknown[] } | null {
    const row = this.db.prepare(
      'SELECT status, steps_json FROM fallback_turns WHERE session_id = ? AND idempotency_key = ?',
    ).get(identity.sessionId, identity.idempotencyKey) as { status: string; steps_json: string | null } | undefined;
    if (!row) return null;
    const parsed = row.steps_json ? safeParse(row.steps_json) : [];
    return { status: row.status, steps: Array.isArray(parsed) ? parsed : [] };
  }

  /**
   * Records a session event. Events that only become true once the child
   * actually sees them (board marks synchronised to speech) are inserted
   * unreleased and confirmed later, so a replay never shows work that an
   * interruption cancelled.
   */
  addEvent(sessionId: string, type: string, payload: unknown, released = true): number {
    this.assertActive(sessionId);
    const result = this.db
      .prepare('INSERT INTO events (session_id, ts, type, payload, released) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, Date.now(), type, JSON.stringify(payload ?? {}), released ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  markEventReleased(sessionId: string, eventId: number): void {
    this.assertActive(sessionId);
    this.db
      .prepare('UPDATE events SET released = 1 WHERE id = ? AND session_id = ?')
      .run(eventId, sessionId);
  }

  listEvents(sessionId: string, limit = 500, throughEventId?: number | null): EventRow[] {
    return this.readEvents(sessionId, limit, throughEventId, false);
  }

  /** Explicit diagnostic path. Application APIs, replay, context and summaries
   * must use listEvents(), which exposes released/committed truth only. */
  listEventsForInternalAudit(sessionId: string, limit = 500, throughEventId?: number | null): EventRow[] {
    return this.readEvents(sessionId, limit, throughEventId, true);
  }

  private readEvents(sessionId: string, limit: number, throughEventId: number | null | undefined, includeUnreleased: boolean): EventRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, ts, type, payload, released FROM (
           SELECT id, session_id, ts, type, payload, released
           FROM events WHERE session_id = ? AND (? = 1 OR released = 1) AND (? IS NULL OR id <= ?) ORDER BY id DESC LIMIT ?
         ) latest ORDER BY id`,
      )
      .all(sessionId, includeUnreleased ? 1 : 0, throughEventId ?? null, throughEventId ?? null, limit) as unknown as {
      id: number;
      session_id: string;
      ts: number;
      type: string;
      payload: string;
      released: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      ts: r.ts,
      type: r.type,
      payload: safeParse(r.payload),
      released: r.released === 1,
    }));
  }

  addEvidence(
    sessionId: string,
    entry: EvidenceInput,
    released = true,
  ): EvidenceRow {
    this.assertActive(sessionId);
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Unknown session.');
    const evidenceId = randomUUID();
    const sourceEventIds = [...new Set(entry.sourceEventIds ?? [])];
    if (sourceEventIds.length === 0) throw new Error('Evidence requires at least one source event ID.');
    const excerpt = normalizeExcerpt(entry.excerpt ?? '');
    const sourceSpan = excerpt ? this.validateExcerpt(sessionId, sourceEventIds, excerpt) : null;
    const taxonomy = entry.classification ?? taxonomyFromVerdict(entry.verdict);
    const confidenceBasis = entry.confidenceBasis ?? `${entry.confidence} confidence model observation`;
    const taskId = entry.taskId ?? 'unspecified-opportunity';
    const independenceLevel = entry.independenceLevel ?? 'reduced';
    const turnId = entry.turnId ?? 'legacy-turn';
    const generationId = entry.generationId ?? 'legacy-generation';
    const result = this.db
      .prepare(
        `INSERT INTO evidence (
          session_id, ts, concept, observation, verdict, confidence, excerpt,
          evidence_id, child_id, concept_id, response_taxonomy, confidence_basis,
          source_event_ids, normalized_excerpt, source_span_json, task_id,
          independence_level, domain_check_json, turn_id, generation_id,
          contradicts_json, supersedes_json, opportunity_kind, retrieval_of, released, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        Date.now(),
        entry.concept,
        entry.observation,
        entry.verdict,
        entry.confidence,
        entry.excerpt ?? null,
        evidenceId,
        session.childId,
        normalizeConcept(entry.concept),
        taxonomy,
        confidenceBasis,
        JSON.stringify(sourceEventIds),
        excerpt,
        sourceSpan ? JSON.stringify(sourceSpan) : null,
        taskId,
        independenceLevel,
        JSON.stringify(entry.domainCheck ?? null),
        turnId,
        generationId,
        JSON.stringify(entry.contradicts ?? []),
        JSON.stringify(entry.supersedes ?? []),
        entry.opportunityKind ?? 'recall',
        entry.retrievalOf ?? null,
        released ? 1 : 0,
        entry.idempotencyKey ?? null,
      );
    return this.getEvidenceByRowId(Number(result.lastInsertRowid)) as EvidenceRow;
  }

  listEvidence(sessionId: string): EvidenceRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM evidence WHERE session_id = ? AND released = 1 ORDER BY id',
      )
      .all(sessionId) as unknown as {
      [key: string]: unknown;
    }[];
    return rows.map((r) => mapEvidence(r));
  }

  listEvidenceForInternalAudit(sessionId: string): EvidenceRow[] {
    const rows = this.db.prepare('SELECT * FROM evidence WHERE session_id = ? ORDER BY id').all(sessionId) as unknown as Record<string, unknown>[];
    return rows.map((row) => mapEvidence(row));
  }

  listEvidenceForChild(childId: string, limit = 200): (EvidenceRow & { goal: string })[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, s.goal
         FROM evidence e JOIN sessions s ON s.id = e.session_id
         WHERE s.child_id = ? AND e.released = 1 ORDER BY e.id DESC LIMIT ?`,
      )
      .all(childId, limit) as unknown as {
      [key: string]: unknown;
    }[];
    return rows.map((r) => ({ ...mapEvidence(r), goal: String(r.goal) }));
  }

  getEvidenceByEvidenceId(evidenceId: string): EvidenceRow | null {
    const row = this.db.prepare('SELECT * FROM evidence WHERE evidence_id = ? AND released = 1').get(evidenceId) as Record<string, unknown> | undefined;
    return row ? mapEvidence(row) : null;
  }

  private getEvidenceByRowId(id: number): EvidenceRow | null {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? mapEvidence(row) : null;
  }

  private validateExcerpt(sessionId: string, sourceEventIds: number[], excerpt: string): { eventId: number; start: number; end: number } {
    if (sourceEventIds.length === 0) throw new Error('Evidence excerpts require source event IDs.');
    for (const eventId of sourceEventIds) {
      const row = this.db.prepare('SELECT payload FROM events WHERE id = ? AND session_id = ?').get(eventId, sessionId) as { payload: string } | undefined;
      if (!row) continue;
      const payload = safeParse(row.payload) as { text?: unknown };
      const source = normalizeExcerpt(typeof payload.text === 'string' ? payload.text : '');
      const start = source.indexOf(excerpt);
      if (start >= 0) return { eventId, start, end: start + excerpt.length };
    }
    throw new Error('Evidence excerpt does not match its source events.');
  }

  private latestEventId(sessionId: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(id) AS id FROM events WHERE session_id = ? AND released = 1')
      .get(sessionId) as { id: number | null };
    return row.id === null ? null : Number(row.id);
  }

  private assertActive(sessionId: string): void {
    const row = this.db
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get(sessionId) as { status: string } | undefined;
    if (!row) throw new Error('Unknown session.');
    if (row.status !== 'active') throw new Error('Session has ended and is immutable.');
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function parseArray<T>(value: unknown, fallback: T[] = []): T[] {
  if (typeof value !== 'string') return fallback;
  const parsed = safeParse(value);
  return Array.isArray(parsed) ? parsed as T[] : fallback;
}

function mapEvidence(row: Record<string, unknown>): EvidenceRow {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    ts: Number(row.ts),
    concept: String(row.concept),
    observation: String(row.observation),
    verdict: String(row.verdict) as Verdict,
    confidence: String(row.confidence) as Confidence,
    excerpt: row.excerpt === null || row.excerpt === undefined ? null : String(row.excerpt),
    evidenceId: row.evidence_id ? String(row.evidence_id) : `legacy-${row.id}`,
    childId: row.child_id ? String(row.child_id) : '',
    conceptId: row.concept_id ? String(row.concept_id) : normalizeConcept(String(row.concept)),
    taxonomy: row.response_taxonomy ? String(row.response_taxonomy) as ResponseTaxonomy : taxonomyFromVerdict(String(row.verdict) as Verdict),
    confidenceBasis: row.confidence_basis ? String(row.confidence_basis) : `${row.confidence} confidence legacy observation`,
    sourceEventIds: parseArray<number>(row.source_event_ids),
    normalizedExcerpt: row.normalized_excerpt ? String(row.normalized_excerpt) : normalizeExcerpt(row.excerpt ? String(row.excerpt) : ''),
    sourceSpan: row.source_span_json ? safeParse(String(row.source_span_json)) as EvidenceRow['sourceSpan'] : null,
    taskId: row.task_id ? String(row.task_id) : 'legacy-opportunity',
    independenceLevel: row.independence_level ? String(row.independence_level) as EvidenceRow['independenceLevel'] : 'reduced',
    domainCheck: row.domain_check_json ? safeParse(String(row.domain_check_json)) : null,
    turnId: row.turn_id ? String(row.turn_id) : 'legacy-turn',
    generationId: row.generation_id ? String(row.generation_id) : 'legacy-generation',
    contradicts: parseArray<string>(row.contradicts_json),
    supersedes: parseArray<string>(row.supersedes_json),
    opportunityKind: row.opportunity_kind ? String(row.opportunity_kind) as EvidenceOpportunityKind : 'recall',
    retrievalOf: row.retrieval_of === null || row.retrieval_of === undefined ? null : String(row.retrieval_of),
    idempotencyKey: row.idempotency_key === null || row.idempotency_key === undefined ? null : String(row.idempotency_key),
  };
}
