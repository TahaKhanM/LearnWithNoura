import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApi } from './api';
import { readRuntimeConfig } from './runtimeConfig';
import { createFixtureCompilationService, type LessonCompilationService } from './lesson/compilationService';
import { openTestDb } from './store/db';
import { Repo } from './store/repo';

/**
 * Session creation now runs the lesson compiler: a concrete goal compiles
 * directly, a vague goal returns candidate objectives for the parent to
 * confirm, and compiler failure is an honest failed record — never an
 * uncompiled lesson.
 */

const PARENT = 'parent-a';

function makeApp(repo: Repo, compilation?: LessonCompilationService) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApi(
    repo,
    null,
    'gpt-5.6-terra',
    { parentId: (req) => typeof req.headers['x-test-parent'] === 'string' ? req.headers['x-test-parent'] : null },
    readRuntimeConfig({}),
    compilation ?? createFixtureCompilationService(repo),
  ));
  return app;
}

describe('POST /api/sessions with the lesson compiler', () => {
  it('compiles a concrete goal directly and stores a ready lesson', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Synthetic A', 9, PARENT);
    const app = makeApp(repo);

    const response = await request(app)
      .post('/api/sessions')
      .set('x-test-parent', PARENT)
      .send({ childId: child.id, goal: 'Understand why triangle angles add to 180' });

    expect(response.status).toBe(201);
    expect(response.body.session.goal).toBe('Understand why triangle angles add to 180');
    expect(response.body.compilation.status).toBe('ready');
    expect(response.body.compilation.objective).toBeTruthy();

    const record = repo.getCompiledLesson(response.body.session.id);
    expect(record?.status).toBe('ready');
    expect(record?.lesson?.blueprint.stages.length).toBeGreaterThanOrEqual(3);
  });

  it('returns candidate objectives for a vague goal and creates no session', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Synthetic A', 9, PARENT);
    const app = makeApp(repo);

    const response = await request(app)
      .post('/api/sessions')
      .set('x-test-parent', PARENT)
      .send({ childId: child.id, goal: 'Help her get better at school things' });

    expect(response.status).toBe(200);
    expect(response.body.session).toBeUndefined();
    expect(response.body.candidates.length).toBeGreaterThanOrEqual(2);
    expect(response.body.candidates[0].objective).toBeTruthy();
    expect(repo.listSessions(child.id)).toHaveLength(0);
  });

  it('creates the session when the parent confirms a candidate objective', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Synthetic A', 9, PARENT);
    const app = makeApp(repo);

    const first = await request(app)
      .post('/api/sessions')
      .set('x-test-parent', PARENT)
      .send({ childId: child.id, goal: 'Help her get better at school things' });
    const chosen = first.body.candidates[0];

    const confirmed = await request(app)
      .post('/api/sessions')
      .set('x-test-parent', PARENT)
      .send({ childId: child.id, goal: 'Help her get better at school things', objective: chosen.objective });

    expect(confirmed.status).toBe(201);
    expect(confirmed.body.compilation.status).toBe('ready');
    const record = repo.getCompiledLesson(confirmed.body.session.id);
    expect(record?.lesson?.objective).toBe(chosen.objective);
  });

  it('answers 502 and creates no session when goal normalization fails', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Synthetic A', 9, PARENT);
    const broken: LessonCompilationService = {
      normalize: async () => { throw new Error('provider unavailable'); },
      start: async () => { throw new Error('unreachable'); },
      planDetour: async () => [],
      close: async () => {},
    };
    const app = makeApp(repo, broken);

    const response = await request(app)
      .post('/api/sessions')
      .set('x-test-parent', PARENT)
      .send({ childId: child.id, goal: 'Fractions on a number line' });

    expect(response.status).toBe(502);
    expect(repo.listSessions(child.id)).toHaveLength(0);
  });

  it('records an honest failed compilation when compilation cannot start', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Synthetic A', 9, PARENT);
    const failing: LessonCompilationService = {
      normalize: async () => ({ kind: 'objective', objective: 'Compare two fractions' }),
      start: async () => { throw new Error('compiler crashed'); },
      planDetour: async () => [],
      close: async () => {},
    };
    const app = makeApp(repo, failing);

    const response = await request(app)
      .post('/api/sessions')
      .set('x-test-parent', PARENT)
      .send({ childId: child.id, goal: 'Compare two fractions' });

    expect(response.status).toBe(201);
    expect(response.body.compilation.status).toBe('failed');
    expect(response.body.compilation.failureReason).toContain('Lesson preparation could not start');
    expect(repo.getCompiledLesson(response.body.session.id)?.status).toBe('failed');
  });
});

describe('compiled lesson state on session reads and continuations', () => {
  it('reports the compilation state on GET /api/sessions/:id', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Synthetic A', 9, PARENT);
    const app = makeApp(repo);
    const created = await request(app)
      .post('/api/sessions')
      .set('x-test-parent', PARENT)
      .send({ childId: child.id, goal: 'Understand why triangle angles add to 180' });

    const fetched = await request(app)
      .get(`/api/sessions/${created.body.session.id}`)
      .set('x-test-parent', PARENT);

    expect(fetched.status).toBe(200);
    expect(fetched.body.compilation.status).toBe('ready');
    expect(fetched.body.compilation.objective).toBe(created.body.compilation.objective);
  });

  it('reports null compilation for a legacy session without a record', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Synthetic A', 9, PARENT);
    const legacy = repo.createSession(child.id, 'Legacy goal');
    const app = makeApp(repo);

    const fetched = await request(app)
      .get(`/api/sessions/${legacy.id}`)
      .set('x-test-parent', PARENT);

    expect(fetched.status).toBe(200);
    expect(fetched.body.compilation).toBeNull();
  });

  it('reuses the validated lesson for a continuation, re-keyed and restarted', async () => {
    const repo = new Repo(openTestDb());
    const child = repo.createChild('Synthetic A', 9, PARENT);
    const app = makeApp(repo);
    const created = await request(app)
      .post('/api/sessions')
      .set('x-test-parent', PARENT)
      .send({ childId: child.id, goal: 'Understand why triangle angles add to 180' });
    repo.endSession(created.body.session.id, null);

    const continued = await request(app)
      .post(`/api/sessions/${created.body.session.id}/continue`)
      .set('x-test-parent', PARENT);

    expect(continued.status).toBe(201);
    expect(continued.body.compilation.status).toBe('ready');
    const record = repo.getCompiledLesson(continued.body.session.id);
    expect(record?.lesson?.compiledLessonId).toBe(`compiled-${continued.body.session.id}`);
    expect(record?.lesson?.blueprint.blueprintId).toBe(`blueprint-${continued.body.session.id}`);
    expect(record?.lesson?.blueprint.currentStageIndex).toBe(0);
    expect(record?.lesson?.objective).toBe(created.body.compilation.objective);
  });
});
