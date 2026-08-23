import type {
  Child,
  EventRow,
  EvidenceInput,
  EvidenceRow,
  FallbackTurnClaim,
  FallbackTurnIdentity,
  Session,
  SessionSummary,
} from './repo.js';

export type Awaitable<T> = T | Promise<T>;

/**
 * Repository contract shared by the synchronous local SQLite adapter and the
 * asynchronous managed-Postgres adapter. Runtime callers await every method,
 * while the local store and its focused unit tests stay synchronous.
 */
export interface DomainRepository {
  createChild(name: string, age: number | null, parentId?: string): Awaitable<Child>;
  listChildren(parentId?: string): Awaitable<Child[]>;
  getChild(id: string): Awaitable<Child | null>;
  getChildForParent(id: string, parentId: string): Awaitable<Child | null>;
  getSessionForParent(id: string, parentId: string): Awaitable<Session | null>;
  createSession(childId: string, goal: string, parentSessionId?: string | null): Awaitable<Session>;
  getSession(id: string): Awaitable<Session | null>;
  listSessions(childId: string): Awaitable<Session[]>;
  endSession(id: string, summary: SessionSummary | null): Awaitable<Session | null>;
  setSessionSummary(id: string, summary: SessionSummary, version?: number): Awaitable<void>;
  createContinuation(id: string): Awaitable<Session>;
  claimFallbackTurn(identity: FallbackTurnIdentity): Awaitable<FallbackTurnClaim>;
  isFallbackTurnActive(identity: FallbackTurnIdentity): Awaitable<boolean>;
  addFallbackEvent(identity: FallbackTurnIdentity, type: string, payload: unknown, released?: boolean): Awaitable<number>;
  addFallbackEvidence(identity: FallbackTurnIdentity, entry: EvidenceInput): Awaitable<EvidenceRow>;
  markFallbackEventReleased(identity: FallbackTurnIdentity, eventId: number): Awaitable<void>;
  finishFallbackTurn(identity: FallbackTurnIdentity, status: 'completed' | 'failed' | 'cancelled', steps?: unknown[]): Awaitable<boolean>;
  getFallbackTurn(identity: Pick<FallbackTurnIdentity, 'sessionId' | 'idempotencyKey'>): Awaitable<{ status: string; steps: unknown[] } | null>;
  addEvent(sessionId: string, type: string, payload: unknown, released?: boolean): Awaitable<number>;
  markEventReleased(sessionId: string, eventId: number): Awaitable<void>;
  listEvents(sessionId: string, limit?: number, throughEventId?: number | null): Awaitable<EventRow[]>;
  listEventsForInternalAudit(sessionId: string, limit?: number, throughEventId?: number | null): Awaitable<EventRow[]>;
  addEvidence(sessionId: string, entry: EvidenceInput, released?: boolean): Awaitable<EvidenceRow>;
  listEvidence(sessionId: string): Awaitable<EvidenceRow[]>;
  listEvidenceForInternalAudit(sessionId: string): Awaitable<EvidenceRow[]>;
  listEvidenceForChild(childId: string, limit?: number): Awaitable<Array<EvidenceRow & { goal: string }>>;
  getEvidenceByEvidenceId(evidenceId: string): Awaitable<EvidenceRow | null>;
}

export interface ManagedDomainRepository extends DomainRepository {
  initialize(): Promise<void>;
  health(): Promise<boolean>;
}
