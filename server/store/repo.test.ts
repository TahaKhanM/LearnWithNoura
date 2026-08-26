import { describe, expect, it } from 'vitest';
import { conversationCompiledLesson } from './compiledLessonFixture';
import { openTestDb } from './db';
import { Repo } from './repo';

function repo(): Repo {
  return new Repo(openTestDb());
}

describe('Repo', () => {
  it('creates children and sessions', () => {
    const r = repo();
    const child = r.createChild('Maya', 9);
    const session = r.createSession(child.id, 'Fractions on a number line');
    expect(r.getChild(child.id)?.name).toBe('Maya');
    expect(r.getSession(session.id)?.goal).toBe('Fractions on a number line');
    expect(r.listSessions(child.id)).toHaveLength(1);
  });

  it('records and lists events in order', () => {
    const r = repo();
    const child = r.createChild('Sam', null);
    const session = r.createSession(child.id, 'goal');
    r.addEvent(session.id, 'tutor_said', { text: 'hello' });
    r.addEvent(session.id, 'learner_said', { text: 'hi' });
    const events = r.listEvents(session.id);
    expect(events.map((e) => e.type)).toEqual(['tutor_said', 'learner_said']);
    expect((events[0].payload as { text: string }).text).toBe('hello');
  });

  it('excludes unreleased rows from generic reads unless the internal audit path is explicit', () => {
    const r = repo();
    const child = r.createChild('Sam', null);
    const session = r.createSession(child.id, 'goal');
    r.addEvent(session.id, 'semantic_scene', { ops: [] }, false);
    expect(r.listEvents(session.id)).toEqual([]);
    expect(r.listEventsForInternalAudit(session.id)).toEqual([expect.objectContaining({ type: 'semantic_scene', released: false })]);
  });

  it('stores evidence and aggregates it per child', () => {
    const r = repo();
    const child = r.createChild('Ava', 10);
    const s1 = r.createSession(child.id, 'triangles');
    const source1 = r.addEvent(s1.id, 'learner_said', { text: 'they all squish into a straight line' });
    r.addEvidence(s1.id, {
      concept: 'angle sum',
      observation: 'Explained the straight-line argument unprompted.',
      verdict: 'mastered',
      confidence: 'high',
      excerpt: 'they all squish into a straight line',
      sourceEventIds: [source1],
    });
    const s2 = r.createSession(child.id, 'fractions');
    const source2 = r.addEvent(s2.id, 'learner_said', { text: 'I think one half and two quarters are different sizes.' });
    r.addEvidence(s2.id, {
      concept: 'equivalent fractions',
      observation: 'Thought 1/2 and 2/4 were different sizes.',
      verdict: 'misconception',
      confidence: 'medium',
      sourceEventIds: [source2],
    });
    const all = r.listEvidenceForChild(child.id);
    expect(all).toHaveLength(2);
    // Most recent first, joined with the session goal.
    expect(all[0].concept).toBe('equivalent fractions');
    expect(all[0].goal).toBe('fractions');
  });

  it('ends sessions with a summary', () => {
    const r = repo();
    const child = r.createChild('Leo', 8);
    const session = r.createSession(child.id, 'water cycle');
    r.endSession(session.id, {
      headline: 'Leo followed the water cycle end to end.',
      workedOn: ['evaporation'],
      strengths: [],
      struggles: [],
      recommendation: 'Try condensation next.',
      confidenceNote: 'Short session, light evidence.',
    });
    const stored = r.getSession(session.id);
    expect(stored?.status).toBe('ended');
    expect(stored?.summary?.headline).toContain('Leo');
  });

  it('enforces evidence source lineage and exact normalized excerpts', () => {
    const r = repo();
    const child = r.createChild('Noor', 11);
    const session = r.createSession(child.id, 'lineage');
    const sourceEventId = r.addEvent(session.id, 'learner_said', {
      text: 'I first thought 25, but the side length is 5.',
    });
    const stored = r.addEvidence(session.id, {
      concept: 'square roots',
      observation: 'Self-corrected area to side length.',
      verdict: 'progressing',
      confidence: 'medium',
      classification: 'self_corrected',
      excerpt: 'the side length is 5',
      sourceEventIds: [sourceEventId],
      taskId: 'square-root-check',
      independenceLevel: 'reduced',
      turnId: 'turn-2',
      generationId: 'generation-2',
    });
    expect(stored.sourceSpan).toMatchObject({ eventId: sourceEventId });
    expect(stored.evidenceId).toBeTruthy();

    expect(() => r.addEvidence(session.id, {
      concept: 'square roots',
      observation: 'Unsupported claim.',
      verdict: 'progressing',
      confidence: 'low',
      excerpt: 'I explained it perfectly',
      sourceEventIds: [sourceEventId],
    })).toThrow(/does not match/i);
  });

  it('keeps the newest events when a long session is paginated', () => {
    const r = repo();
    const child = r.createChild('Noor', 11);
    const session = r.createSession(child.id, 'event ordering');
    for (let index = 1; index <= 8; index += 1) {
      r.addEvent(session.id, 'learner_said', { text: `turn-${index}` });
    }

    const events = r.listEvents(session.id, 3);
    expect(events.map((event) => (event.payload as { text: string }).text)).toEqual([
      'turn-6',
      'turn-7',
      'turn-8',
    ]);
  });

  it('tracks the compiled lesson lifecycle from pending to ready', () => {
    const r = repo();
    const child = r.createChild('Iman', 9);
    const session = r.createSession(child.id, 'water cycle');
    expect(r.getCompiledLesson(session.id)).toBeNull();

    const pending = r.upsertCompiledLesson(session.id, { status: 'pending' });
    expect(pending).toMatchObject({ sessionId: session.id, status: 'pending', lesson: null, failureReason: null });

    const lesson = conversationCompiledLesson();
    const ready = r.upsertCompiledLesson(session.id, { status: 'ready', lesson });
    expect(ready.status).toBe('ready');
    expect(ready.lesson?.blueprint.blueprintId).toBe(lesson.blueprint.blueprintId);
    expect(ready.createdAt).toBe(pending.createdAt);

    const reloaded = r.getCompiledLesson(session.id);
    expect(reloaded?.lesson?.objective).toBe(lesson.objective);
  });

  it('stores generated illustration bytes by id and cache key', () => {
    const r = repo();
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    r.putBoardAsset({
      id: 'img-a1b2c3d4e5f67890',
      cacheKey: 'abc'.repeat(16).slice(0, 64),
      mime: 'image/png',
      bytes,
      createdAt: 1,
    });
    expect(r.getBoardAsset('img-a1b2c3d4e5f67890')).toMatchObject({
      id: 'img-a1b2c3d4e5f67890',
      mime: 'image/png',
    });
    expect(Array.from(r.getBoardAsset('img-a1b2c3d4e5f67890')?.bytes ?? [])).toEqual([137, 80, 78, 71]);
    expect(r.getBoardAssetByCacheKey('abc'.repeat(16).slice(0, 64))?.id).toBe('img-a1b2c3d4e5f67890');
  });

  it('records compilation failures and refuses a ready record without a lesson', () => {
    const r = repo();
    const child = r.createChild('Iman', 9);
    const session = r.createSession(child.id, 'water cycle');
    const failed = r.upsertCompiledLesson(session.id, { status: 'failed', failureReason: 'validation exhausted retries' });
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'validation exhausted retries', lesson: null });
    expect(() => r.upsertCompiledLesson(session.id, { status: 'ready' })).toThrow(/lesson payload/i);
    expect(() => r.upsertCompiledLesson('missing-session', { status: 'pending' })).toThrow(/unknown session/i);
  });

  it('rejects event and evidence writes after a session ends', () => {
    const r = repo();
    const child = r.createChild('Noor', 11);
    const session = r.createSession(child.id, 'immutable ending');
    r.endSession(session.id, null);

    expect(() => r.addEvent(session.id, 'learner_said', { text: 'late' })).toThrow(
      /ended/i,
    );
    expect(() =>
      r.addEvidence(session.id, {
        concept: 'late evidence',
        observation: 'should not be stored',
        verdict: 'progressing',
        confidence: 'low',
        sourceEventIds: [1],
      }),
    ).toThrow(/ended/i);
  });
});
