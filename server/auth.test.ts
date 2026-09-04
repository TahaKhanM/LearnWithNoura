import { randomBytes, scryptSync } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApi } from './api';
import { createAuthRouter } from './auth';
import { readRuntimeConfig } from './runtimeConfig';
import { SecurityBoundary } from './security';
import { openTestDb } from './store/db';
import { Repo } from './store/repo';

function passwordHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt-v1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function authHarness() {
  const env = {
    NOURA_DEPLOYMENT_MODE: 'production-v0',
    DATABASE_URL: 'postgres://fixture',
    OPENAI_API_KEY: 'fixture',
    NOURA_STORAGE_ADAPTER: 'postgres',
    NOURA_LESSON_CAPABILITY_SECRET: 'test-secret-at-least-32-characters',
    NOURA_REQUIRE_LOGIN: 'true',
    NOURA_DEMO_AUTH_EMAIL: 'demo@example.test',
    NOURA_DEMO_AUTH_PASSWORD_SCRYPT: passwordHash('correct horse battery staple'),
  };
  const security = new SecurityBoundary(readRuntimeConfig(env), env);
  const repo = new Repo(openTestDb());
  const app = express();
  app.use(express.json());
  app.use(security.originAndRateGuard);
  app.use(security.attachParentIdentity);
  app.use('/api/auth', createAuthRouter(security));
  app.use('/api', createApi(repo, null, 'gpt-5.6-terra', security.apiSecurity()));
  return { app, env, security };
}

describe('demo login boundary', () => {
  it('requires login, rejects invalid credentials, and issues an HttpOnly parent session', async () => {
    const { app } = authHarness();
    const before = await request(app).get('/api/auth/session');
    expect(before.body).toEqual({ required: true, authenticated: false });
    expect((await request(app).get('/api/children')).status).toBe(401);

    const invalid = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://learnwithnoura.com')
      .send({ email: 'demo@example.test', password: 'wrong' });
    expect(invalid.status).toBe(401);
    expect(invalid.body).toEqual({ error: 'The email or password is incorrect.' });

    const login = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://learnwithnoura.com')
      .send({ email: 'DEMO@example.test', password: 'correct horse battery staple' });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']?.[0]).split(';')[0];
    expect(login.headers['set-cookie']?.[0]).toMatch(/noura_parent=.*HttpOnly.*Secure.*SameSite=Lax/i);

    const authenticated = await request(app).get('/api/auth/session').set('Cookie', cookie);
    expect(authenticated.body).toEqual({
      required: true,
      authenticated: true,
      email: 'demo@example.test',
    });
    expect((await request(app).get('/api/children').set('Cookie', cookie)).status).toBe(200);

    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Origin', 'https://learnwithnoura.com')
      .set('Cookie', cookie);
    expect(logout.status).toBe(204);
    expect(logout.headers['set-cookie']?.[0]).toMatch(/Max-Age=0/i);
  });

  it('rejects an old signed guest cookie after login becomes mandatory', async () => {
    const { app, env } = authHarness();
    const guestRuntime = readRuntimeConfig({ ...env, NOURA_REQUIRE_LOGIN: 'false' });
    const guestBoundary = new SecurityBoundary(guestRuntime, env);
    const guest = guestBoundary.issueParentSession('guest-old-session');
    const cookie = `noura_parent=${encodeURIComponent(guest.value)}`;

    const response = await request(app).get('/api/auth/session').set('Cookie', cookie);
    expect(response.body).toEqual({ required: true, authenticated: false });
  });
});
