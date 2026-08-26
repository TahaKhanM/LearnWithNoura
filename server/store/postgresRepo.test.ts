import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { conversationCompiledLesson } from './compiledLessonFixture';
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

  it('stores the compiled lesson lifecycle with the same contract as SQLite', async () => {
    const repo = postgresRepo();
    await repo.initialize();
    const child = await repo.createChild('Synthetic Learner', 10);
    const session = await repo.createSession(child.id, 'Water cycle');
    await expect(repo.getCompiledLesson(session.id)).resolves.toBeNull();

    const pending = await repo.upsertCompiledLesson(session.id, { status: 'pending' });
    expect(pending).toMatchObject({ sessionId: session.id, status: 'pending', lesson: null, failureReason: null });

    const lesson = conversationCompiledLesson();
    const ready = await repo.upsertCompiledLesson(session.id, { status: 'ready', lesson });
    expect(ready.status).toBe('ready');
    expect(ready.lesson?.blueprint.blueprintId).toBe(lesson.blueprint.blueprintId);
    expect(ready.createdAt).toBe(pending.createdAt);

    await expect(repo.upsertCompiledLesson(session.id, { status: 'ready' })).rejects.toThrow(/lesson payload/i);
    await expect(repo.upsertCompiledLesson('missing-session', { status: 'pending' })).rejects.toThrow(/unknown session/i);
    const failed = await repo.upsertCompiledLesson(session.id, { status: 'failed', failureReason: 'validation exhausted retries' });
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'validation exhausted retries', lesson: null });
  }, HEAVY_CONTRACT_TIMEOUT_MS);

  it('stores generated illustration bytes by id and cache key', async () => {
    const repo = postgresRepo();
    await repo.initialize();
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    await repo.putBoardAsset({
      id: 'img-a1b2c3d4e5f67890',
      cacheKey: 'abc'.repeat(16).slice(0, 64),
      mime: 'image/png',
      bytes,
      createdAt: 1,
      parentId: 'parent-a',
      sessionId: 'session-a',
    });
    const stored = await repo.getBoardAsset('img-a1b2c3d4e5f67890');
    expect(stored).toMatchObject({
      id: 'img-a1b2c3d4e5f67890',
      mime: 'image/png',
      parentId: 'parent-a',
      sessionId: 'session-a',
    });
    expect(Array.from(stored?.bytes ?? [])).toEqual([137, 80, 78, 71]);
    await expect(repo.getBoardAssetByCacheKey('abc'.repeat(16).slice(0, 64))).resolves.toMatchObject({
      id: 'img-a1b2c3d4e5f67890',
    });
  }, HEAVY_CONTRACT_TIMEOUT_MS);

  it('keeps health and compiled lessons working when the role cannot CREATE in schema noura', async () => {
    const memory = newDb();
    const adapter = memory.adapters.createPg();
    const setupPool = new adapter.Pool();
    const setup = new PostgresRepo(setupPool);
    await setup.initialize();
    const child = await setup.createChild('Synthetic Learner', 10);
    await setupPool.query('DROP TABLE noura.compiled_lessons');
    await setupPool.query('DROP TABLE noura.board_assets');

    const restrictedPool = new adapter.Pool();
    const query = restrictedPool.query.bind(restrictedPool);
    restrictedPool.query = ((text: unknown, values?: unknown[]) => {
      const sql = String(text);
      if (/^\s*(CREATE|ALTER)\b/i.test(sql)) {
        return Promise.reject(new Error('permission denied for schema noura'));
      }
      return query(text as string, values);
    }) as typeof restrictedPool.query;

    const repo = new PostgresRepo(restrictedPool);
    await expect(repo.health()).resolves.toBe(true);

    const session = await repo.createSession(child.id, 'Water cycle');
    const pending = await repo.upsertCompiledLesson(session.id, { status: 'pending' });
    expect(pending).toMatchObject({ sessionId: session.id, status: 'pending', lesson: null });

    const lesson = conversationCompiledLesson();
    const ready = await repo.upsertCompiledLesson(session.id, { status: 'ready', lesson });
    expect(ready.status).toBe('ready');
    expect(ready.lesson?.blueprint.blueprintId).toBe(lesson.blueprint.blueprintId);
    await expect(repo.getCompiledLesson(session.id)).resolves.toMatchObject({ status: 'ready' });

    const visible = await repo.listEvents(session.id);
    expect(visible).toEqual([]);
    const audit = await repo.listEventsForInternalAudit(session.id);
    expect(audit.every((event) => event.type !== 'noura.compiled_lesson')).toBe(true);

    await expect(repo.getBoardAsset('missing')).resolves.toBeNull();
  }, HEAVY_CONTRACT_TIMEOUT_MS);

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
