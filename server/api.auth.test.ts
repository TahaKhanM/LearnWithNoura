import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
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
});
