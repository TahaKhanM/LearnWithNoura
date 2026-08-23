import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { PostgresStore, type StorageSnapshot } from './portable';

describe('PostgresStore portable contract', () => {
  it('imports and exports a deterministic snapshot with verified counts', async () => {
    const memory = newDb();
    const adapter = memory.adapters.createPg();
    const store = new PostgresStore(new adapter.Pool());
    await store.initialize();
    const snapshot: StorageSnapshot = {
      schemaVersion: 1,
      exportedAt: 1,
      children: [{ id: 'child-1', parent_id: 'parent-1', name: 'Synthetic Learner', age: 10, created_at: 1 }],
      sessions: [{ id: 'session-1', child_id: 'child-1', goal: 'Fractions', status: 'ended', started_at: 2, ended_at: 3, summary_json: null }],
      events: [{ id: 1, session_id: 'session-1', ts: 2, type: 'learner_said', payload: { text: 'synthetic answer' }, released: true }],
      evidence: [{
        id: 1, evidence_id: 'evidence-1', child_id: 'child-1', session_id: 'session-1', ts: 2,
        concept: 'fractions', concept_id: 'fractions', observation: 'Synthetic observation', verdict: 'progressing', confidence: 'medium',
        response_taxonomy: 'correct', confidence_basis: 'fixture', source_event_ids: [1], excerpt: 'synthetic answer', normalized_excerpt: 'synthetic answer',
        source_span_json: { eventId: 1, start: 0, end: 16 }, task_id: 'task-1', independence_level: 'independent', domain_check_json: null,
        turn_id: 'turn-1', generation_id: 'generation-1', contradicts_json: [], supersedes_json: [],
      }],
    };
    await expect(store.importSnapshot(snapshot)).resolves.toEqual({ children: 1, sessions: 1, events: 1, evidence: 1 });
    const exported = await store.exportSnapshot();
    expect(exported.children.map((row) => row.id)).toEqual(['child-1']);
    expect(exported.events.map((row) => row.id)).toEqual([1]);
    await expect(store.health()).resolves.toBe(true);
    await store.close();
  });
});
