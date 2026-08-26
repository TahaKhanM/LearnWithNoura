import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { capabilityFromProtocols, SecurityBoundary } from './security';
import { readRuntimeConfig } from './runtimeConfig';

describe('security boundary', () => {
  it('accepts only exact configured origins', () => {
    const boundary = new SecurityBoundary(readRuntimeConfig({}), { NOURA_ALLOWED_ORIGINS: 'https://preview.example.test' });
    expect(boundary.isAllowedOrigin('https://learnwithnoura.com')).toBe(true);
    expect(boundary.isAllowedOrigin('https://preview.example.test')).toBe(true);
    expect(boundary.isAllowedOrigin('https://learnwithnoura.com.attacker.test')).toBe(false);
    expect(boundary.isAllowedOrigin(undefined)).toBe(false);
  });

  it('issues short-lived lesson capabilities scoped to child and session', () => {
    const boundary = new SecurityBoundary(readRuntimeConfig({}), { NOURA_LESSON_CAPABILITY_SECRET: 'test-secret-at-least-32-characters' });
    const issue = boundary.apiSecurity().issueLessonCapability;
    expect(issue).toBeTypeOf('function');
    const token = issue?.('session-a', 'child-a', 'parent-a') ?? '';
    expect(boundary.verifyLessonCapability(token, 'session-a')).toMatchObject({ childId: 'child-a', parentId: 'parent-a' });
    expect(boundary.verifyLessonCapability(token, 'session-b')).toBeNull();
    expect(boundary.verifyLessonCapability(`${token}x`, 'session-a')).toBeNull();
    expect(capabilityFromProtocols(`noura.v1, cap.${token}`)).toBe(token);
  });

  it('does not treat lesson-status GETs as costly session writes', async () => {
    const boundary = new SecurityBoundary(readRuntimeConfig({}));
    const app = express();
    app.use(boundary.originAndRateGuard);
    app.get('/api/sessions/:id', (_req, res) => res.json({ ok: true }));
    app.post('/api/sessions', (_req, res) => res.status(201).json({ ok: true }));

    for (let index = 0; index < 31; index += 1) {
      const response = await request(app).get('/api/sessions/session-1');
      expect(response.status).toBe(200);
    }

    let lastWrite = 201;
    for (let index = 0; index < 31; index += 1) {
      lastWrite = (await request(app)
        .post('/api/sessions')
        .set('Origin', 'https://learnwithnoura.com')
        .send({})).status;
    }
    expect(lastWrite).toBe(429);
  });

  it('applies bounded per-key rate limits', () => {
    const boundary = new SecurityBoundary(readRuntimeConfig({}));
    expect(boundary.allow('parent:child:session:ip', 2, 1000)).toBe(true);
    expect(boundary.allow('parent:child:session:ip', 2, 1000)).toBe(true);
    expect(boundary.allow('parent:child:session:ip', 2, 1000)).toBe(false);
  });

  it('gives the explicit v0 a stable signed guest parent scope without signup', async () => {
    const env = {
      NOURA_DEPLOYMENT_MODE: 'production-v0',
      DATABASE_URL: 'postgres://fixture',
      OPENAI_API_KEY: 'fixture',
      NOURA_STORAGE_ADAPTER: 'postgres',
      NOURA_LESSON_CAPABILITY_SECRET: 'test-secret-at-least-32-characters',
    };
    const boundary = new SecurityBoundary(readRuntimeConfig(env), env);
    const app = express();
    app.use(boundary.attachParentIdentity);
    app.get('/identity', (req, res) => res.json({ parentId: boundary.parentId(req) }));
    const first = await request(app).get('/identity');
    const cookie = String(first.headers['set-cookie']?.[0]).split(';')[0];
    const second = await request(app).get('/identity').set('Cookie', cookie);
    expect(first.headers['set-cookie']?.[0]).toMatch(/noura_parent=.*HttpOnly.*Secure.*SameSite=Lax/i);
    expect(first.body.parentId).toMatch(/^guest-/);
    expect(second.body.parentId).toBe(first.body.parentId);
  });
});
