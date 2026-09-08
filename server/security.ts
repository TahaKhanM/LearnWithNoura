import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import type { ApiSecurity } from './api.js';
import type { RuntimeConfig } from './runtimeConfig.js';

interface SignedPayload { aud: 'parent' | 'lesson'; sub: string; childId?: string; parentId?: string; exp: number; nonce: string }
const localSecret = randomBytes(32).toString('base64url');
const scrypt = promisify(scryptCallback);
const PARENT_COOKIE = 'noura_parent';
const MAX_RATE_BUCKETS = 10_000;
const RATE_SWEEP_MS = 60_000;

export class SecurityBoundary {
  private readonly secret: string;
  private readonly allowedOrigins: Set<string>;
  private readonly demoEmail: string | null;
  private readonly demoPasswordHash: string | null;
  private readonly demoParentId: string | null;
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private nextBucketSweepAt = 0;
  private requestParents = new WeakMap<Request, string>();

  constructor(private readonly runtime: RuntimeConfig, env: NodeJS.ProcessEnv = process.env) {
    this.secret = env.NOURA_LESSON_CAPABILITY_SECRET || env.NOURA_AUTH_SECRET || localSecret;
    this.demoEmail = env.NOURA_DEMO_AUTH_EMAIL?.trim().toLowerCase() || null;
    this.demoPasswordHash = env.NOURA_DEMO_AUTH_PASSWORD_SCRYPT?.trim() || null;
    this.demoParentId = this.demoEmail
      ? `demo-${createHmac('sha256', this.secret).update(`parent:${this.demoEmail}`).digest('base64url').slice(0, 32)}`
      : null;
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
    const token = parseCookies(request.headers.cookie ?? '')[PARENT_COOKIE];
    const payload = token ? this.verify(token, 'parent') : null;
    if (this.runtime.loginRequired) {
      return payload?.sub && payload.sub === this.demoParentId ? payload.sub : null;
    }
    return payload?.sub ?? null;
  }

  issueParentSession(parentId: string): { value: string; attributes: string } {
    const maxAge = this.runtime.loginRequired
      ? 12 * 60 * 60
      : this.runtime.guestAccess
        ? 30 * 24 * 60 * 60
        : 30 * 60;
    const value = this.sign({ aud: 'parent', sub: parentId, exp: Date.now() + maxAge * 1000, nonce: randomBytes(12).toString('base64url') });
    return { value, attributes: `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}` };
  }

  /** Gives the v0 a durable pseudonymous parent scope without adding signup. */
  attachParentIdentity = (request: Request, response: Response, next: NextFunction): void => {
    if (!this.runtime.guestAccess) {
      next();
      return;
    }
    const token = parseCookies(request.headers.cookie ?? '')[PARENT_COOKIE];
    const existing = token ? this.verify(token, 'parent') : null;
    const parentId = existing?.sub ?? `guest-${randomUUID()}`;
    this.requestParents.set(request, parentId);
    if (!existing) {
      const session = this.issueParentSession(parentId);
      response.appendHeader('Set-Cookie', `${PARENT_COOKIE}=${encodeURIComponent(session.value)}; ${session.attributes}`);
    }
    next();
  };

  requiresLogin(): boolean {
    return this.runtime.loginRequired;
  }

  configuredLoginEmail(): string | null {
    return this.demoEmail;
  }

  async verifyDemoLogin(email: string, password: string): Promise<boolean> {
    const parsed = parseScryptHash(this.demoPasswordHash);
    if (!this.demoEmail || !parsed || password.length > 512) return false;
    const derived = await scrypt(password, parsed.salt, parsed.expected.length) as Buffer;
    const passwordMatches = derived.length === parsed.expected.length && timingSafeEqual(derived, parsed.expected);
    return email.trim().toLowerCase() === this.demoEmail && passwordMatches;
  }

  issueDemoParentSession(): { value: string; attributes: string } | null {
    return this.demoParentId ? this.issueParentSession(this.demoParentId) : null;
  }

  clearParentCookie(): string {
    return `${PARENT_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  }

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
    // Sweep on a clock, not on each new key: an attacker controls request paths.
    if (now >= this.nextBucketSweepAt) {
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
      }
      this.nextBucketSweepAt = now + RATE_SWEEP_MS;
    }
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      // Keep active counters intact; evicting them would reset the limit.
      if (!existing && this.buckets.size >= MAX_RATE_BUCKETS) return false;
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (existing.count >= limit) return false;
    existing.count += 1;
    return true;
  }

  private sign(payload: SignedPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private verify(token: string, audience: SignedPayload['aud']): SignedPayload | null {
    const parts = token.split('.');
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const [encoded, signature] = parts;
    const expected = createHmac('sha256', this.secret).update(encoded).digest();
    let supplied: Buffer;
    try { supplied = Buffer.from(signature, 'base64url'); }
    catch { return null; }
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedPayload;
      if (!payload || typeof payload !== 'object' || payload.aud !== audience
        || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= Date.now()
        || typeof payload.sub !== 'string' || !payload.sub
        || typeof payload.nonce !== 'string' || !payload.nonce) return null;
      if (audience === 'lesson' && (typeof payload.childId !== 'string' || !payload.childId
        || typeof payload.parentId !== 'string' || !payload.parentId)) return null;
      return payload;
    } catch { return null; }
  }
}

function parseScryptHash(value: string | null): { salt: Buffer; expected: Buffer } | null {
  if (!value) return null;
  const [version, saltText, hashText] = value.split('$');
  if (version !== 'scrypt-v1' || !saltText || !hashText) return null;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    if (salt.length < 16 || expected.length !== 32) return null;
    return { salt, expected };
  } catch {
    return null;
  }
}

export function capabilityFromProtocols(header: string | undefined): string | null {
  const protocol = (header ?? '').split(',').map((value) => value.trim()).find((value) => value.startsWith('cap.'));
  return protocol ? protocol.slice(4) : null;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try {
      const key = decodeURIComponent(part.slice(0, separator).trim());
      if (!(key in cookies)) cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // An unrelated malformed cookie must not turn authentication into a 500.
    }
  }
  return cookies;
}
