import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface Child {
  id: string;
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
}

/** Calibrated language only — no invented mastery percentages. */
export interface SessionSummary {
  headline: string;
  workedOn: string[];
  strengths: { concept: string; evidence: string }[];
  struggles: { concept: string; evidence: string; kind: 'misconception' | 'gap' | 'uncertain' }[];
  recommendation: string;
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
}

export interface EventRow {
  id: number;
  sessionId: string;
  ts: number;
  type: string;
  payload: unknown;
  released: boolean;
}

export class Repo {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createChild(name: string, age: number | null): Child {
    const child: Child = { id: randomUUID(), name, age, createdAt: Date.now() };
    this.db
      .prepare('INSERT INTO children (id, name, age, created_at) VALUES (?, ?, ?, ?)')
      .run(child.id, child.name, child.age, child.createdAt);
    return child;
  }

  listChildren(): Child[] {
    const rows = this.db
      .prepare('SELECT id, name, age, created_at FROM children ORDER BY created_at')
      .all() as unknown as { id: string; name: string; age: number | null; created_at: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name, age: r.age, createdAt: r.created_at }));
  }

  getChild(id: string): Child | null {
    const r = this.db
      .prepare('SELECT id, name, age, created_at FROM children WHERE id = ?')
      .get(id) as { id: string; name: string; age: number | null; created_at: number } | undefined;
    return r ? { id: r.id, name: r.name, age: r.age, createdAt: r.created_at } : null;
  }

  createSession(childId: string, goal: string): Session {
    const session: Session = {
      id: randomUUID(),
      childId,
      goal,
      status: 'active',
      startedAt: Date.now(),
      endedAt: null,
      summary: null,
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, child_id, goal, status, started_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(session.id, childId, goal, session.status, session.startedAt);
    return session;
  }

  getSession(id: string): Session | null {
    const r = this.db
      .prepare(
        'SELECT id, child_id, goal, status, started_at, ended_at, summary_json FROM sessions WHERE id = ?',
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

  endSession(id: string, summary: SessionSummary | null): void {
    this.db
      .prepare("UPDATE sessions SET status = 'ended', ended_at = ?, summary_json = ? WHERE id = ?")
      .run(Date.now(), summary ? JSON.stringify(summary) : null, id);
  }

  /**
   * Records a session event. Events that only become true once the child
   * actually sees them (board marks synchronised to speech) are inserted
   * unreleased and confirmed later, so a replay never shows work that an
   * interruption cancelled.
   */
  addEvent(sessionId: string, type: string, payload: unknown, released = true): number {
    const result = this.db
      .prepare('INSERT INTO events (session_id, ts, type, payload, released) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, Date.now(), type, JSON.stringify(payload ?? {}), released ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  markEventReleased(sessionId: string, eventId: number): void {
    this.db
      .prepare('UPDATE events SET released = 1 WHERE id = ? AND session_id = ?')
      .run(eventId, sessionId);
  }

  listEvents(sessionId: string, limit = 500): EventRow[] {
    const rows = this.db
      .prepare(
        'SELECT id, session_id, ts, type, payload, released FROM events WHERE session_id = ? ORDER BY id LIMIT ?',
      )
      .all(sessionId, limit) as unknown as {
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
    entry: {
      concept: string;
      observation: string;
      verdict: Verdict;
      confidence: Confidence;
      excerpt?: string;
    },
  ): void {
    this.db
      .prepare(
        'INSERT INTO evidence (session_id, ts, concept, observation, verdict, confidence, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        sessionId,
        Date.now(),
        entry.concept,
        entry.observation,
        entry.verdict,
        entry.confidence,
        entry.excerpt ?? null,
      );
  }

  listEvidence(sessionId: string): EvidenceRow[] {
    const rows = this.db
      .prepare(
        'SELECT id, session_id, ts, concept, observation, verdict, confidence, excerpt FROM evidence WHERE session_id = ? ORDER BY id',
      )
      .all(sessionId) as unknown as {
      id: number;
      session_id: string;
      ts: number;
      concept: string;
      observation: string;
      verdict: Verdict;
      confidence: Confidence;
      excerpt: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      ts: r.ts,
      concept: r.concept,
      observation: r.observation,
      verdict: r.verdict,
      confidence: r.confidence,
      excerpt: r.excerpt,
    }));
  }

  listEvidenceForChild(childId: string, limit = 200): (EvidenceRow & { goal: string })[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.session_id, e.ts, e.concept, e.observation, e.verdict, e.confidence, e.excerpt, s.goal
         FROM evidence e JOIN sessions s ON s.id = e.session_id
         WHERE s.child_id = ? ORDER BY e.id DESC LIMIT ?`,
      )
      .all(childId, limit) as unknown as {
      id: number;
      session_id: string;
      ts: number;
      concept: string;
      observation: string;
      verdict: Verdict;
      confidence: Confidence;
      excerpt: string | null;
      goal: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      ts: r.ts,
      concept: r.concept,
      observation: r.observation,
      verdict: r.verdict,
      confidence: r.confidence,
      excerpt: r.excerpt,
      goal: r.goal,
    }));
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
