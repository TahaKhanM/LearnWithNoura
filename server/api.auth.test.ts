import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
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
    expect(listEvents).toHaveBeenCalledWith(sessionA.id, 5_000);
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
    expect(nonOwner.body).toEqual({ error: 'not found' });
    expect(JSON.stringify(nonOwner.body)).not.toContain(sessionA.id);
    expect(listEvents).not.toHaveBeenCalled();
  });
});
