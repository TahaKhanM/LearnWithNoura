import { config as loadEnv } from 'dotenv';
import { createServer } from 'node:http';
import express from 'express';
import OpenAI from 'openai';
import { WebSocketServer } from 'ws';
import { createApi } from './api.js';
import { runFallbackTurn } from './fallbackTutor.js';
import { connectRealtimeProxy } from './realtime/proxy.js';
import { assertRealtimePromptReadable } from './realtime/instructions.js';
import { readRuntimeConfig, productionReadinessErrors, EVENT_SCHEMA_VERSION } from './runtimeConfig.js';
import { getDb } from './store/db.js';
import { Repo } from './store/repo.js';
import { capabilityFromProtocols, SecurityBoundary } from './security.js';

loadEnv({ override: false });

export const runtimeConfig = readRuntimeConfig();
const readinessErrors = productionReadinessErrors(runtimeConfig);
if (readinessErrors.length > 0) {
  throw new Error(`Noura Production startup blocked: ${readinessErrors.join('; ')}.`);
}

assertRealtimePromptReadable();

const repo = new Repo(getDb());
const security = new SecurityBoundary(runtimeConfig);
const openai = runtimeConfig.providerConfigured
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(security.originAndRateGuard);

app.get(['/healthz', '/api/healthz'], (_req, res) => {
  const durableStorageAvailable = runtimeConfig.deploymentMode === 'local-synthetic';
  const healthy = runtimeConfig.providerConfigured && durableStorageAvailable;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    provider: runtimeConfig.providerConfigured ? 'configured' : 'unavailable',
    durableStorage: durableStorageAvailable ? 'available' : 'unavailable',
    schema: 'ready',
  });
});

app.get(['/version', '/api/version'], (_req, res) => {
  res.json({
    brand: 'Noura',
    version: process.env.npm_package_version ?? '0.0.0',
    gitSha: runtimeConfig.buildSha,
    environment: runtimeConfig.environment,
    schemaVersion: EVENT_SCHEMA_VERSION,
    runtimeModels: {
      realtime: runtimeConfig.realtimeModel,
      transcription: 'gpt-4o-mini-transcribe',
      text: runtimeConfig.textModel,
    },
  });
});

app.use('/api', createApi(repo, openai, runtimeConfig.textModel, security.apiSecurity()));

app.post('/api/fallback-turn', async (req, res) => {
  if (!openai) {
    res.status(503).json({ error: 'Noura is not configured for tutor responses.' });
    return;
  }
  const { sessionId, text, idempotencyKey } = req.body as {
    sessionId?: unknown; text?: unknown; idempotencyKey?: unknown;
  };
  if (typeof sessionId !== 'string' || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'sessionId and text are required' });
    return;
  }
  const session = repo.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Unknown session.' });
    return;
  }
  if (session.status !== 'active') {
    res.status(409).json({ error: 'This lesson has ended and is read-only.' });
    return;
  }
  const authorization = req.headers.authorization ?? '';
  const capability = authorization.startsWith('Lesson ') ? authorization.slice(7) : null;
  const claim = security.verifyLessonCapability(capability, sessionId);
  if (!claim || claim.childId !== session.childId) {
    res.status(403).json({ error: 'Lesson capability is invalid or expired.' });
    return;
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 160) {
    res.status(400).json({ error: 'A valid idempotencyKey is required.' });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.flushHeaders();
  let aborted = false;
  req.on('aborted', () => { aborted = true; });
  const send = (payload: unknown) => {
    if (!aborted && !res.writableEnded) res.write(`${JSON.stringify(payload)}\n`);
  };
  try {
    await runFallbackTurn(openai, runtimeConfig.textModel, repo, sessionId, text.trim(), send);
    send({ type: 'done' });
  } catch {
    send({ type: 'error', message: 'The tutor request failed.' });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

export const server = createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 400_000,
  handleProtocols: (protocols) => protocols.has('noura.v1') ? 'noura.v1' : false,
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws/lesson' && url.pathname !== '/api/ws') {
    socket.destroy();
    return;
  }
  const sessionId = url.searchParams.get('session');
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
  const capability = capabilityFromProtocols(request.headers['sec-websocket-protocol']);
  const session = sessionId ? repo.getSession(sessionId) : null;
  const claim = sessionId ? security.verifyLessonCapability(capability, sessionId) : null;
  const ip = request.socket.remoteAddress ?? 'unknown';
  if (!security.isAllowedOrigin(origin) || !session || !claim || claim.childId !== session.childId || !security.allow(`ws:${claim.parentId}:${sessionId}:${ip}`, 20, 60_000)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => {
    if (!process.env.OPENAI_API_KEY || !sessionId) {
      client.send(JSON.stringify({ type: 'error', message: process.env.OPENAI_API_KEY ? 'Missing session id.' : 'Noura is not configured on this server.' }));
      client.close(4400);
      return;
    }
    connectRealtimeProxy(client, {
      apiKey: process.env.OPENAI_API_KEY,
      model: runtimeConfig.realtimeModel,
      repo,
      sessionId,
      log: (line) => console.log(`[realtime] ${line}`),
    });
  });
});
