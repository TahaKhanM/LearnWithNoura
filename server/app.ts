import { config as loadEnv } from 'dotenv';
import { createServer } from 'node:http';
import express from 'express';
import OpenAI from 'openai';
import { WebSocketServer } from 'ws';
import { createApi } from './api.js';
import { fallbackTurns } from './fallbackTutor.js';
import { connectRealtimeProxy } from './realtime/proxy.js';
import { bootstrapVoiceCall, SidebandRegistry } from './realtime/callBootstrap.js';
import {
  ProxyLifecycleRegistry,
  ShutdownGate,
  runQuiescentShutdown,
  type ShutdownDisposition,
} from './realtime/lifecycle.js';
import { assertRealtimePromptReadable } from './realtime/instructions.js';
import { readRuntimeConfig, productionReadinessErrors, EVENT_SCHEMA_VERSION } from './runtimeConfig.js';
import { createRepositoryRuntime } from './store/createRepository.js';
import { capabilityFromProtocols, SecurityBoundary } from './security.js';

loadEnv({ override: false });

export const runtimeConfig = readRuntimeConfig();
const readinessErrors = productionReadinessErrors(runtimeConfig);
if (readinessErrors.length > 0) {
  throw new Error(`Noura Production startup blocked: ${readinessErrors.join('; ')}.`);
}

assertRealtimePromptReadable();

const repository = createRepositoryRuntime(runtimeConfig);
const repo = repository.repo;
const security = new SecurityBoundary(runtimeConfig);
const openai = runtimeConfig.providerConfigured
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(security.originAndRateGuard);
app.use(security.attachParentIdentity);

app.get(['/healthz', '/api/healthz'], async (_req, res) => {
  let durableStorageAvailable = runtimeConfig.deploymentMode === 'local-synthetic';
  if (repository.managed) durableStorageAvailable = await repository.managed.health();
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

app.use('/api', createApi(repo, openai, runtimeConfig.textModel, security.apiSecurity(), runtimeConfig));

const sidebandRegistry = new SidebandRegistry();

app.post('/api/webrtc-call', express.text({ type: 'application/sdp', limit: '256kb' }), async (req, res) => {
  // The browser's WebRTC SDP offer for the lesson's audio plane. The API key
  // stays here: the server creates the provider call, configures its control
  // sideband, and returns only the SDP answer.
  if (!process.env.OPENAI_API_KEY) {
    res.status(503).json({ error: 'Noura is not configured for tutor responses.' });
    return;
  }
  const sessionId = typeof req.query.session === 'string' ? req.query.session : '';
  const offerSdp = typeof req.body === 'string' ? req.body : '';
  if (!sessionId || !offerSdp.startsWith('v=')) {
    res.status(400).json({ error: 'A session id and an SDP offer are required.' });
    return;
  }
  const session = await repo.getSession(sessionId);
  if (!session) { res.status(404).json({ error: 'Unknown session.' }); return; }
  if (session.status !== 'active') { res.status(409).json({ error: 'This lesson has ended and is read-only.' }); return; }
  const authorization = req.headers.authorization ?? '';
  const capability = authorization.startsWith('Lesson ') ? authorization.slice(7) : null;
  const claim = security.verifyLessonCapability(capability, sessionId);
  if (!claim || claim.childId !== session.childId) {
    res.status(403).json({ error: 'Lesson capability is invalid or expired.' });
    return;
  }
  const ip = req.socket.remoteAddress ?? 'unknown';
  if (!security.allow(`webrtc:${claim.parentId}:${sessionId}:${ip}`, 10, 60_000)) {
    res.status(429).json({ error: 'Too many voice call attempts. Try again shortly.' });
    return;
  }
  const result = await bootstrapVoiceCall({
    repo,
    apiKey: process.env.OPENAI_API_KEY,
    model: runtimeConfig.realtimeModel,
    registry: sidebandRegistry,
    log: (line) => console.log(`[realtime] ${line}`),
  }, { sessionId, offerSdp });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(200).type('application/sdp').send(result.answerSdp);
});

app.post('/api/fallback-turn', async (req, res) => {
  if (!openai) {
    res.status(503).json({ error: 'Noura is not configured for tutor responses.' });
    return;
  }
  const { sessionId, text, idempotencyKey, connectionEpoch, turnId, generationId } = req.body as {
    sessionId?: unknown; text?: unknown; idempotencyKey?: unknown;
    connectionEpoch?: unknown; turnId?: unknown; generationId?: unknown;
  };
  if (typeof sessionId !== 'string' || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'sessionId and text are required' });
    return;
  }
  const session = await repo.getSession(sessionId);
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
  if (!Number.isInteger(connectionEpoch) || Number(connectionEpoch) < 0 ||
      typeof turnId !== 'string' || !turnId || turnId.length > 160 ||
      typeof generationId !== 'string' || !generationId || generationId.length > 160) {
    res.status(400).json({ error: 'Fallback generation identity is required.' });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.flushHeaders();
  let aborted = false;
  const requestController = new AbortController();
  req.on('aborted', () => { aborted = true; requestController.abort('request aborted'); });
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      requestController.abort('response closed');
    }
  });
  const send = (payload: unknown) => {
    if (!aborted && !res.writableEnded) res.write(`${JSON.stringify(payload)}\n`);
  };
  try {
    const result = await fallbackTurns.run(openai, runtimeConfig.textModel, repo, {
      sessionId,
      userText: text.trim(),
      idempotencyKey,
      connectionEpoch: Number(connectionEpoch),
      turnId,
      generationId,
    }, send, requestController.signal);
    send({ type: 'stream_done', replayed: result === 'replayed' });
  } catch (error) {
    if (!requestController.signal.aborted && (error as Error).name !== 'AbortError') {
      send({ type: 'stream_error', message: 'The tutor request failed.' });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.post('/api/board-submission', async (req, res) => {
  // Fallback-mode drawing submission. Voice is unavailable, so the learner's
  // Done posts the committed vector analysis and scene description here; it
  // is persisted and answered through the same fallback turn coordinator.
  // The configured fallback text model has no image input contract, so the
  // submission is degraded (vector + description, no picture) and says so.
  if (!openai) {
    res.status(503).json({ error: 'Noura is not configured for tutor responses.' });
    return;
  }
  const { sessionId, submissionId, description, ops, analysis, connectionEpoch, turnId, generationId } = req.body as Record<string, unknown>;
  if (typeof sessionId !== 'string' || typeof submissionId !== 'string' || !/^[\w-]{8,160}$/.test(submissionId)) {
    res.status(400).json({ error: 'sessionId and a valid submissionId are required' });
    return;
  }
  const session = await repo.getSession(sessionId);
  if (!session) { res.status(404).json({ error: 'Unknown session.' }); return; }
  if (session.status !== 'active') { res.status(409).json({ error: 'This lesson has ended and is read-only.' }); return; }
  const authorization = req.headers.authorization ?? '';
  const capability = authorization.startsWith('Lesson ') ? authorization.slice(7) : null;
  const claim = security.verifyLessonCapability(capability, sessionId);
  if (!claim || claim.childId !== session.childId) {
    res.status(403).json({ error: 'Lesson capability is invalid or expired.' });
    return;
  }
  if (!Number.isInteger(connectionEpoch) || Number(connectionEpoch) < 0 ||
      typeof turnId !== 'string' || !turnId || turnId.length > 160 ||
      typeof generationId !== 'string' || !generationId || generationId.length > 160) {
    res.status(400).json({ error: 'Fallback generation identity is required.' });
    return;
  }
  const cleanDescription = typeof description === 'string' ? description.trim().slice(0, 4000) : '';
  const summary = typeof (analysis as { summary?: unknown } | undefined)?.summary === 'string'
    ? String((analysis as { summary: string }).summary).slice(0, 2000)
    : '';
  if (!cleanDescription && !summary) {
    res.status(400).json({ error: 'A drawing description is required.' });
    return;
  }
  const alreadyStored = (await repo.listEvents(sessionId, 2000)).some((event) =>
    event.type === 'learner_board' && (event.payload as { submissionId?: unknown }).submissionId === submissionId);
  if (!alreadyStored) {
    await repo.addEvent(sessionId, 'learner_board', {
      description: cleanDescription,
      ops: Array.isArray(ops) ? ops.slice(0, 80) : [],
      submissionId,
      hasVisualContext: false,
      via: 'fallback',
      ...(summary ? { analysis: { summary } } : {}),
    });
  }
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.flushHeaders();
  let aborted = false;
  const requestController = new AbortController();
  req.on('aborted', () => { aborted = true; requestController.abort('request aborted'); });
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      requestController.abort('response closed');
    }
  });
  const send = (payload: unknown) => {
    if (!aborted && !res.writableEnded) res.write(`${JSON.stringify(payload)}\n`);
  };
  try {
    const result = await fallbackTurns.run(openai, runtimeConfig.textModel, repo, {
      sessionId,
      userText: [
        '[The learner finished a drawing on the shared board and pressed Done. Voice and images are unavailable; interpret this deterministic description of their drawing.]',
        cleanDescription,
        summary ? `Deterministic vector analysis: ${summary}` : '',
        'If the meaning is ambiguous, ask the learner what they intended instead of guessing.',
      ].filter(Boolean).join(' '),
      idempotencyKey: submissionId,
      connectionEpoch: Number(connectionEpoch),
      turnId,
      generationId,
    }, send, requestController.signal);
    send({ type: 'stream_done', replayed: result === 'replayed' });
  } catch (error) {
    if (!requestController.signal.aborted && (error as Error).name !== 'AbortError') {
      send({ type: 'stream_error', message: 'The tutor request failed.' });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.post('/api/fallback-checkpoint', async (req, res) => {
  const { sessionId, idempotencyKey, connectionEpoch, turnId, generationId, eventId } = req.body as Record<string, unknown>;
  if (typeof sessionId !== 'string' || typeof idempotencyKey !== 'string' ||
      !Number.isInteger(connectionEpoch) || typeof turnId !== 'string' ||
      typeof generationId !== 'string' || !Number.isInteger(eventId)) {
    res.status(400).json({ error: 'Fallback checkpoint identity is required.' });
    return;
  }
  const session = await repo.getSession(sessionId);
  const authorization = req.headers.authorization ?? '';
  const capability = authorization.startsWith('Lesson ') ? authorization.slice(7) : null;
  const claim = security.verifyLessonCapability(capability, sessionId);
  if (!session || !claim || claim.childId !== session.childId) {
    res.status(403).json({ error: 'Lesson capability is invalid or expired.' });
    return;
  }
  try {
    await repo.markFallbackEventReleased({
      sessionId, idempotencyKey, connectionEpoch: Number(connectionEpoch), turnId, generationId,
    }, Number(eventId));
    res.status(204).end();
  } catch {
    res.status(409).json({ error: 'Fallback checkpoint is stale or unavailable.' });
  }
});

export const server = createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 400_000,
  handleProtocols: (protocols) => protocols.has('noura.v1') ? 'noura.v1' : false,
});
const proxyLifecycles = new ProxyLifecycleRegistry();
const shutdownGate = new ShutdownGate();

server.on('upgrade', async (request, socket, head) => {
  if (!shutdownGate.allowsUpgrade()) {
    socket.destroy();
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws/lesson' && url.pathname !== '/api/ws') {
    socket.destroy();
    return;
  }
  const sessionId = url.searchParams.get('session');
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
  const capability = capabilityFromProtocols(request.headers['sec-websocket-protocol']);
  try {
    await repository.ready();
  } catch {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const session = sessionId ? await repo.getSession(sessionId) : null;
  const claim = sessionId ? security.verifyLessonCapability(capability, sessionId) : null;
  const ip = request.socket.remoteAddress ?? 'unknown';
  if (!security.isAllowedOrigin(origin) || !session || !claim || claim.childId !== session.childId || !security.allow(`ws:${claim.parentId}:${sessionId}:${ip}`, 20, 60_000)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!shutdownGate.allowsUpgrade()) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => {
    if (!process.env.OPENAI_API_KEY || !sessionId) {
      client.send(JSON.stringify({ type: 'error', message: process.env.OPENAI_API_KEY ? 'Missing session id.' : 'Noura is not configured on this server.' }));
      client.close(4400);
      return;
    }
    const connection = connectRealtimeProxy(client, {
      apiKey: process.env.OPENAI_API_KEY,
      model: runtimeConfig.realtimeModel,
      repo,
      telemetryRepo: repository.telemetry,
      sessionId,
      sidebandRegistry,
      log: (line) => console.log(`[realtime] ${line}`),
      onLifecycle: (lifecycle) => proxyLifecycles.register(lifecycle),
    }).catch(() => {
      try { client.close(1011, 'lesson service unavailable'); } catch { /* already closed */ }
    });
    proxyLifecycles.trackConnection(connection);
  });
});

let repositoryClose: Promise<void> | null = null;
let serverShutdown: Promise<ShutdownDisposition> | null = null;

export function closeRepository(): Promise<void> {
  repositoryClose ??= repository.close();
  return repositoryClose;
}

export function shutdownServer(): Promise<ShutdownDisposition> {
  serverShutdown ??= runQuiescentShutdown({
    stopAccepting: () => {
      shutdownGate.begin();
      server.close();
    },
    closeClients: () => {
      for (const client of wss.clients) client.close(1001, 'server shutdown');
    },
    closeProxies: () => proxyLifecycles.shutdown(),
    closeRepository,
    log: (error: unknown) => {
      console.error(`[shutdown] ${String(error).slice(0, 240)}`);
      process.exitCode = 1;
    },
    fatal: (error: unknown) => {
      console.error(`[shutdown:fatal] ${String(error).slice(0, 240)}`);
      process.exit(1);
    },
  });
  return serverShutdown;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdownServer();
  });
}
