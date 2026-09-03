import { Router } from 'express';
import type { SecurityBoundary } from './security.js';

export function createAuthRouter(security: SecurityBoundary): Router {
  const router = Router();

  router.get('/session', (request, response) => {
    response.set('Cache-Control', 'no-store');
    const parentId = security.parentId(request);
    response.json({
      required: security.requiresLogin(),
      authenticated: !security.requiresLogin() || Boolean(parentId),
      ...(parentId && security.configuredLoginEmail()
        ? { email: security.configuredLoginEmail() }
        : {}),
    });
  });

  router.post('/login', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!security.requiresLogin()) {
      response.status(409).json({ error: 'Login is not enabled for this deployment.' });
      return;
    }
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    if (!security.allow(`demo-login:${ip}`, 5, 5 * 60_000)) {
      response.status(429).json({ error: 'Too many login attempts. Wait a few minutes and try again.' });
      return;
    }
    const email = typeof request.body?.email === 'string' ? request.body.email.slice(0, 320) : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!email || !password || !(await security.verifyDemoLogin(email, password))) {
      response.status(401).json({ error: 'The email or password is incorrect.' });
      return;
    }
    const session = security.issueDemoParentSession();
    if (!session) {
      response.status(503).json({ error: 'Login is not configured.' });
      return;
    }
    response.appendHeader('Set-Cookie', `noura_parent=${encodeURIComponent(session.value)}; ${session.attributes}`);
    response.json({ authenticated: true, email: security.configuredLoginEmail() });
  });

  router.post('/logout', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.appendHeader('Set-Cookie', security.clearParentCookie());
    response.status(204).end();
  });

  return router;
}
