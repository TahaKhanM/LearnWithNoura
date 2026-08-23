import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { PostgresRepo } from './postgresRepo';

function postgresRepo(): PostgresRepo {
  const memory = newDb();
  const adapter = memory.adapters.createPg();
  return new PostgresRepo(new adapter.Pool());
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
  });

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
});
