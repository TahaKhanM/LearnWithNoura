import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ApiSecurity } from './api.js';
import type { RuntimeConfig } from './runtimeConfig.js';

interface SignedPayload { aud: 'parent' | 'lesson'; sub: string; childId?: string; parentId?: string; exp: number; nonce: string }
const localSecret = randomBytes(32).toString('base64url');

export class SecurityBoundary {
  private readonly secret: string;
  private readonly allowedOrigins: Set<string>;
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private requestParents = new WeakMap<Request, string>();

  constructor(private readonly runtime: RuntimeConfig, env: NodeJS.ProcessEnv = process.env) {
    this.secret = env.NOURA_LESSON_CAPABILITY_SECRET || env.NOURA_AUTH_SECRET || localSecret;
    const configured = (env.NOURA_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    this.allowedOrigins = new Set([
      'https://learnwithnoura.com',
      'https://www.learnwithnoura.com',
      'http://localhost:5173',
      'http://localhost:8787',
      ...configured,
    ]);
  }

  apiSecurity(): ApiSecurity {
    return {
      parentId: (request) => this.parentId(request),
      issueLessonCapability: (sessionId, childId, parentId) => this.sign({ aud: 'lesson', sub: sessionId, childId, parentId, exp: Date.now() + 2 * 60 * 60 * 1000, nonce: randomBytes(12).toString('base64url') }),
      verifyLessonCapability: (token, sessionId) => this.verifyLessonCapability(token, sessionId),
    };
  }

  parentId(request: Request): string | null {
    if (!this.runtime.production) return 'local-synthetic-parent';
    const attached = this.requestParents.get(request);
    if (attached) return attached;
    const token = parseCookies(request.headers.cookie ?? '').noura_parent;
    const payload = token ? this.verify(token, 'parent') : null;
    return payload?.sub ?? null;
  }

  issueParentSession(parentId: string): { value: string; attributes: string } {
    const maxAge = this.runtime.guestAccess ? 30 * 24 * 60 * 60 : 30 * 60;
    const value = this.sign({ aud: 'parent', sub: parentId, exp: Date.now() + maxAge * 1000, nonce: randomBytes(12).toString('base64url') });
    return { value, attributes: `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}` };
  }

  /** Gives the v0 a durable pseudonymous parent scope without adding signup. */
  attachParentIdentity = (request: Request, response: Response, next: NextFunction): void => {
    if (!this.runtime.guestAccess) {
      next();
      return;
    }
    const token = parseCookies(request.headers.cookie ?? '').noura_parent;
    const existing = token ? this.verify(token, 'parent') : null;
    const parentId = existing?.sub ?? `guest-${randomUUID()}`;
    this.requestParents.set(request, parentId);
    if (!existing) {
      const session = this.issueParentSession(parentId);
      response.appendHeader('Set-Cookie', `noura_parent=${encodeURIComponent(session.value)}; ${session.attributes}`);
    }
    next();
  };

  verifyLessonCapability(token: string | null, sessionId: string): SignedPayload | null {
    if (!token) return null;
    const payload = this.verify(token, 'lesson');
    return payload?.sub === sessionId ? payload : null;
  }

  isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    try { return this.allowedOrigins.has(new URL(origin).origin); }
    catch { return false; }
  }

  originAndRateGuard = (request: Request, response: Response, next: NextFunction): void => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !this.isAllowedOrigin(request.headers.origin)) {
      response.status(403).json({ error: 'Origin is not allowed.' });
      return;
    }
    const parentId = this.parentId(request) ?? 'anonymous';
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const costly = mutating && (request.path.includes('fallback-turn') || request.path.includes('/sessions'));
    if (!this.allow(`http:${parentId}:${ip}:${request.path}`, costly ? 30 : 180, 60_000)) {
      response.status(429).json({ error: 'Too many requests. Try again shortly.' });
      return;
    }
    next();
  };

  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (existing.count >= limit) return false;
    existing.count += 1;
    if (this.buckets.size > 10_000) {
      for (const [bucketKey, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
    }
    return true;
  }

  private sign(payload: SignedPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private verify(token: string, audience: SignedPayload['aud']): SignedPayload | null {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return null;
    const expected = createHmac('sha256', this.secret).update(encoded).digest();
    let supplied: Buffer;
    try { supplied = Buffer.from(signature, 'base64url'); }
    catch { return null; }
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedPayload;
      if (payload.aud !== audience || payload.exp <= Date.now() || !payload.sub || !payload.nonce) return null;
      return payload;
    } catch { return null; }
  }
}

export function capabilityFromProtocols(header: string | undefined): string | null {
  const protocol = (header ?? '').split(',').map((value) => value.trim()).find((value) => value.startsWith('cap.'));
  return protocol ? protocol.slice(4) : null;
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=')).filter((pair) => pair.length === 2).map(([key, value]) => [decodeURIComponent(key), decodeURIComponent(value)]));
}
