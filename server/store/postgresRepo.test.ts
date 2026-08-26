import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { PostgresRepo } from './postgresRepo';

// Deliberate high-workload contract: tolerate machine load while still detecting hangs.
const HEAVY_CONTRACT_TIMEOUT_MS = 15_000;

function postgresRepo(transactionQueries?: string[]): PostgresRepo {
  const memory = newDb();
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  if (transactionQueries) {
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = ((text: unknown, values?: unknown[]) => {
        transactionQueries.push(String(text).replace(/\s+/g, ' ').trim());
        return query(text as string, values);
      }) as typeof client.query;
      return client;
    };
  }
  return new PostgresRepo(pool);
}

describe('PostgresRepo domain contract', () => {
  it('persists the complete parent, lesson, event, evidence, and immutable-end flow', async () => {
    const repo = postgresRepo();
    await repo.initialize();
    const child = await repo.createChild('Synthetic Learner', 10, 'parent-a');
    const session = await repo.createSession(child.id, 'Compare fractions');
    const sourceEventId = await repo.addEvent(session.id, 'learner_said', { text: 'Two thirds is farther right.' });
    const evidence = await repo.addEvidence(session.id, {
      concept: 'fraction comparison',
      observation: 'Compared both fractions on one scale.',
      verdict: 'progressing',
      confidence: 'medium',
      classification: 'correct',
      excerpt: 'Two thirds is farther right.',
      sourceEventIds: [sourceEventId],
      taskId: 'fraction-task',
      independenceLevel: 'independent',
      turnId: 'turn-1',
      generationId: 'generation-1',
    });

    await expect(repo.getChildForParent(child.id, 'parent-a')).resolves.toMatchObject({ id: child.id });
    await expect(repo.getChildForParent(child.id, 'parent-b')).resolves.toBeNull();
    await expect(repo.listEvents(session.id)).resolves.toEqual([
      expect.objectContaining({ id: sourceEventId, type: 'learner_said', released: true }),
    ]);
    await expect(repo.listEvidenceForChild(child.id)).resolves.toEqual([
      expect.objectContaining({ evidenceId: evidence.evidenceId, goal: 'Compare fractions' }),
    ]);

    const ended = await repo.endSession(session.id, null);
    expect(ended?.endedEventId).toBe(sourceEventId);
    await expect(repo.addEvent(session.id, 'learner_said', { text: 'late' })).rejects.toThrow(/ended/i);
  }, HEAVY_CONTRACT_TIMEOUT_MS);

  it('keeps fallback writes staged until the matching generation completes', async () => {
    const repo = postgresRepo();
    await repo.initialize();
    const child = await repo.createChild('Synthetic Learner', 10);
    const session = await repo.createSession(child.id, 'Fractions');
    const identity = {
      sessionId: session.id,
      idempotencyKey: 'fallback-key-1',
      connectionEpoch: 1,
      turnId: 'turn-1',
      generationId: 'generation-1',
    };

    await expect(repo.claimFallbackTurn(identity)).resolves.toEqual({ kind: 'started' });
    const eventId = await repo.addFallbackEvent(identity, 'tutor_said', { text: 'Provisional' });
    await expect(repo.listEvents(session.id)).resolves.toEqual([]);
    await expect(repo.listEventsForInternalAudit(session.id)).resolves.toEqual([
      expect.objectContaining({ id: eventId, released: false }),
    ]);
    await expect(repo.finishFallbackTurn(identity, 'completed', [])).resolves.toBe(true);
    await expect(repo.listEvents(session.id)).resolves.toEqual([
      expect.objectContaining({ id: eventId, released: true }),
    ]);
  });

  it('locks the session row before inserting an event transactionally', async () => {
    const queries: string[] = [];
    const repo = postgresRepo(queries);
    await repo.initialize();
    const child = await repo.createChild('Synthetic Learner', 10);
    const session = await repo.createSession(child.id, 'Lock ordering');
    await repo.addEvent(session.id, 'learner_said', { text: 'serialized' });

    expect(queries).toEqual([
      'BEGIN',
      'SELECT status FROM noura.sessions WHERE id = $1 FOR UPDATE',
      expect.stringContaining('INSERT INTO noura.events'),
      'COMMIT',
    ]);
  });
});
