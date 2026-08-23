import { describe, expect, it } from 'vitest';
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

  it('stores evidence and aggregates it per child', () => {
    const r = repo();
    const child = r.createChild('Ava', 10);
    const s1 = r.createSession(child.id, 'triangles');
    r.addEvidence(s1.id, {
      concept: 'angle sum',
      observation: 'Explained the straight-line argument unprompted.',
      verdict: 'mastered',
      confidence: 'high',
      excerpt: 'they all squish into a straight line',
    });
    const s2 = r.createSession(child.id, 'fractions');
    r.addEvidence(s2.id, {
      concept: 'equivalent fractions',
      observation: 'Thought 1/2 and 2/4 were different sizes.',
      verdict: 'misconception',
      confidence: 'medium',
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
});
