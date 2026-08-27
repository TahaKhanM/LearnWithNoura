import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { conversationCompiledLesson } from './compiledLessonFixture';
import { PostgresStore, type StorageSnapshot } from './portable';

// Deliberate high-workload contract: tolerate machine load while still detecting hangs.
const HEAVY_CONTRACT_TIMEOUT_MS = 15_000;

describe('PostgresStore portable contract', () => {
  it('imports and exports a deterministic snapshot with verified counts', async () => {
    const memory = newDb();
    memory.public.registerFunction({
      name: 'pg_get_serial_sequence',
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: (table: string) => `${table.replace('.', '_')}_id_seq`,
    });
    memory.public.registerFunction({
      name: 'setval',
      args: [DataType.text, DataType.integer, DataType.bool],
      returns: DataType.integer,
      implementation: (_sequence: string, value: number) => value,
    });
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
      compiledLessons: [{
        session_id: 'session-1', status: 'ready', lesson_json: conversationCompiledLesson(),
        failure_reason: null, created_at: 2, updated_at: 2,
      }],
    };
    await expect(store.importSnapshot(snapshot)).resolves.toEqual({ children: 1, sessions: 1, events: 1, evidence: 1, compiledLessons: 1 });
    const exported = await store.exportSnapshot();
    expect(exported.children.map((row) => row.id)).toEqual(['child-1']);
    expect(exported.events.map((row) => row.id)).toEqual([1]);
    expect((exported.compiledLessons ?? []).map((row) => row.session_id)).toEqual(['session-1']);
    await expect(store.health()).resolves.toBe(true);
    await store.close();
  }, HEAVY_CONTRACT_TIMEOUT_MS);

  it('imports snapshots written before compiled lessons existed', async () => {
    const memory = newDb();
    memory.public.registerFunction({
      name: 'pg_get_serial_sequence',
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: (table: string) => `${table.replace('.', '_')}_id_seq`,
    });
    memory.public.registerFunction({
      name: 'setval',
      args: [DataType.text, DataType.integer, DataType.bool],
      returns: DataType.integer,
      implementation: (_sequence: string, value: number) => value,
    });
    const adapter = memory.adapters.createPg();
    const store = new PostgresStore(new adapter.Pool());
    await store.initialize();
    const legacySnapshot = {
      schemaVersion: 1,
      exportedAt: 1,
      children: [{ id: 'child-1', parent_id: 'parent-1', name: 'Synthetic Learner', age: 10, created_at: 1 }],
      sessions: [],
      events: [],
      evidence: [],
    } as StorageSnapshot;
    await expect(store.importSnapshot(legacySnapshot)).resolves.toEqual({ children: 1, sessions: 0, events: 0, evidence: 0, compiledLessons: 0 });
    await store.close();
  }, HEAVY_CONTRACT_TIMEOUT_MS);
});
