import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import { SESSION_TELEMETRY_LOG_EVENT_LIMIT } from './session/sessionLog';
import { openTestDb } from './store/db';
import { Repo } from './store/repo';

describe('REST object authorization', () => {
  it('isolates children and sessions across parent identities', async () => {
    const repo = new Repo(openTestDb());
    const childA = repo.createChild('Synthetic A', 10, 'parent-a');
    const childB = repo.createChild('Synthetic B', 11, 'parent-b');
    const sessionA = repo.createSession(childA.id, 'Fractions');
    repo.createSession(childB.id, 'Geometry');
    const app = express();
    app.use(express.json());
    app.use('/api', createApi(repo, null, 'gpt-5.6-terra', {
      parentId: (req) => typeof req.headers['x-test-parent'] === 'string' ? req.headers['x-test-parent'] : null,
    }));

    const listA = await request(app).get('/api/children').set('x-test-parent', 'parent-a');
    expect(listA.status).toBe(200);
    expect(listA.body.children.map((child: { id: string }) => child.id)).toEqual([childA.id]);

    expect((await request(app).get(`/api/sessions/${sessionA.id}`).set('x-test-parent', 'parent-b')).status).toBe(404);
    expect((await request(app).get(`/api/children/${childA.id}/overview`).set('x-test-parent', 'parent-b')).status).toBe(404);
    expect((await request(app).post('/api/sessions').set('x-test-parent', 'parent-b').send({ childId: childA.id, goal: 'Cross-parent attempt' })).status).toBe(404);
    expect((await request(app).get('/api/children')).status).toBe(401);
  });

  it('returns the parent-owned structured session telemetry log', async () => {
    const repo = new Repo(openTestDb());
    const childA = repo.createChild('Synthetic A', 10, 'parent-a');
    const sessionA = repo.createSession(childA.id, 'Fractions');
    repo.addEvent(sessionA.id, 'metric', {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
      connectionEpoch: 1,
      turnId: 'turn-a',
      generationId: 'generation-a',
    });
    repo.addEvent(sessionA.id, 'metric', {
      schemaVersion: '1.0.0',
      name: 'tutor_object_disappearance',
      unit: 'count',
      value: 1,
      connectionEpoch: 1,
      turnId: 'turn-a',
      generationId: 'generation-a',
      dimensions: { objectId: 'object-a', cause: 'scene_mutation' },
    }, false);
    repo.addEvent(sessionA.id, 'learner_said', { text: 'Synthetic A private transcript' });
    const listEvents = vi.spyOn(repo, 'listEvents');
    const app = express();
    app.use(express.json());
    app.use('/api', createApi(repo, null, 'gpt-5.6-terra', {
      parentId: (req) => typeof req.headers['x-test-parent'] === 'string' ? req.headers['x-test-parent'] : null,
    }));

    const response = await request(app)
      .get(`/api/sessions/${sessionA.id}/log`)
      .set('x-test-parent', 'parent-a');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      schemaVersion: '1.0.0',
      sessionId: sessionA.id,
      summary: {
        reconnectCount: 1,
        tutorObjectDisappearanceCount: 0,
      },
    });
    expect(response.body.timeline).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain('Synthetic A');
    expect(JSON.stringify(response.body)).not.toContain('turn-a');
    expect(JSON.stringify(response.body)).not.toContain('generation-a');
    expect(JSON.stringify(response.body)).not.toContain('object-a');
    expect(listEvents).toHaveBeenCalledWith(sessionA.id, SESSION_TELEMETRY_LOG_EVENT_LIMIT);
  });

  it('rejects missing and non-owner parents before reading session events', async () => {
    const repo = new Repo(openTestDb());
    const childA = repo.createChild('Synthetic A', 10, 'parent-a');
    const sessionA = repo.createSession(childA.id, 'Fractions');
    repo.addEvent(sessionA.id, 'metric', {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
      connectionEpoch: 1,
      turnId: 'turn-a',
      generationId: 'generation-a',
    });
    const listEvents = vi.spyOn(repo, 'listEvents');
    const app = express();
    app.use(express.json());
    app.use('/api', createApi(repo, null, 'gpt-5.6-terra', {
      parentId: (req) => typeof req.headers['x-test-parent'] === 'string' ? req.headers['x-test-parent'] : null,
    }));

    const unauthenticated = await request(app).get(`/api/sessions/${sessionA.id}/log`);
    const nonOwner = await request(app)
      .get(`/api/sessions/${sessionA.id}/log`)
      .set('x-test-parent', 'parent-b');

    expect(unauthenticated.status).toBe(401);
    expect(nonOwner.status).toBe(404);
    expect(unauthenticated.headers['cache-control']).toBe('no-store');
    expect(nonOwner.headers['cache-control']).toBe('no-store');
    expect(nonOwner.body).toEqual({ error: 'not found' });
    expect(JSON.stringify(nonOwner.body)).not.toContain(sessionA.id);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('serves illustration bytes only to an authenticated parent', async () => {
    const repo = new Repo(openTestDb());
    repo.putBoardAsset({
      id: 'img-a1b2c3d4e5f67890',
      cacheKey: 'a'.repeat(64),
      mime: 'image/png',
      bytes: Uint8Array.from([137, 80, 78, 71]),
      createdAt: 1,
      parentId: 'parent-a',
      sessionId: 'session-a',
    });
    const app = express();
    app.use(express.json());
    app.use('/api', createApi(repo, null, 'gpt-5.6-terra', {
      parentId: (req) => typeof req.headers['x-test-parent'] === 'string' ? req.headers['x-test-parent'] : null,
    }));

    const unauthenticated = await request(app).get('/api/board-assets/img-a1b2c3d4e5f67890');
    const unknownId = await request(app).get('/api/board-assets/not-an-id').set('x-test-parent', 'parent-a');
    const ok = await request(app).get('/api/board-assets/img-a1b2c3d4e5f67890').set('x-test-parent', 'parent-a');

    expect(unauthenticated.status).toBe(401);
    expect(unknownId.status).toBe(404);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/image\/png/);
    expect(ok.body).toBeInstanceOf(Buffer);
    expect(Array.from(ok.body as Buffer).slice(0, 4)).toEqual([137, 80, 78, 71]);
  });

  it('refuses parent B a GET of parent A’s illustration asset', async () => {
    const repo = new Repo(openTestDb());
    repo.putBoardAsset({
      id: 'img-a1b2c3d4e5f67890',
      cacheKey: 'b'.repeat(64),
      mime: 'image/png',
      bytes: Uint8Array.from([137, 80, 78, 71]),
      createdAt: 1,
      parentId: 'parent-a',
      sessionId: 'session-a',
    });
    const app = express();
    app.use(express.json());
    app.use('/api', createApi(repo, null, 'gpt-5.6-terra', {
      parentId: (req) => typeof req.headers['x-test-parent'] === 'string' ? req.headers['x-test-parent'] : null,
    }));

    const crossParent = await request(app).get('/api/board-assets/img-a1b2c3d4e5f67890').set('x-test-parent', 'parent-b');
    expect(crossParent.status).toBe(404);
  });

  it('serves a session-owned asset to a lesson capability without a parent cookie', async () => {
    const repo = new Repo(openTestDb());
    repo.putBoardAsset({
      id: 'img-a1b2c3d4e5f67890',
      cacheKey: 'c'.repeat(64),
      mime: 'image/png',
      bytes: Uint8Array.from([137, 80, 78, 71]),
      createdAt: 1,
      parentId: 'parent-a',
      sessionId: 'session-a',
    });
    const app = express();
    app.use(express.json());
    app.use('/api', createApi(repo, null, 'gpt-5.6-terra', {
      parentId: () => null,
      verifyLessonCapability: (token, sessionId) => (
        token === 'lesson-cap-a' && sessionId === 'session-a'
          ? { aud: 'lesson', sub: sessionId, parentId: 'parent-a' }
          : null
      ),
    }));

    const withCap = await request(app)
      .get('/api/board-assets/img-a1b2c3d4e5f67890')
      .set('Authorization', 'Lesson lesson-cap-a');
    const queryCap = await request(app).get('/api/board-assets/img-a1b2c3d4e5f67890?cap=lesson-cap-a');
    const randomId = await request(app)
      .get('/api/board-assets/img-ffffffffffffffff')
      .set('Authorization', 'Lesson lesson-cap-a');

    expect(withCap.status).toBe(200);
    expect(queryCap.status).toBe(200);
    expect(randomId.status).toBe(404);
  });

  it('sets no-store before handled repository failures', async () => {
    const repo = new Repo(openTestDb());
    vi.spyOn(repo, 'getSessionForParent').mockRejectedValue(
      new Error('repository unavailable'),
    );
    const app = express();
    app.use(express.json());
    app.use('/api', createApi(repo, null, 'gpt-5.6-terra', {
      parentId: () => 'parent-a',
    }));

    const response = await request(app).get('/api/sessions/session-failure/log');

    expect(response.status).toBe(500);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
