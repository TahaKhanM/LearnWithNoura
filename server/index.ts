import { config } from 'dotenv';
import { createServer } from 'node:http';
import express from 'express';
import OpenAI from 'openai';
import { WebSocketServer } from 'ws';
import { getDb } from './store/db';
import { Repo } from './store/repo';
import { createApi } from './api';
import { connectRealtimeProxy } from './realtime/proxy';
import { assertRealtimePromptReadable } from './realtime/instructions';
import { runFallbackTurn } from './fallbackTutor';

// override: true so .env is authoritative even if a stale OPENAI_API_KEY
// is already exported in the parent shell (e.g. via ~/.zshrc).
config({ override: true });

const PORT = Number(process.env.PORT) || 8787;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
const TEXT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  // The app still starts so the interface can explain what is missing,
  // rather than presenting a dead page.
  console.warn('No OPENAI_API_KEY set — the tutor cannot run until it is configured in .env.');
}

assertRealtimePromptReadable();

const repo = new Repo(getDb());
const openai = API_KEY ? new OpenAI({ apiKey: API_KEY }) : null;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', createApi(repo, openai, TEXT_MODEL));

// Captions-only fallback for when the realtime connection is unavailable.
app.post('/api/fallback-turn', async (req, res) => {
  if (!openai) {
    res.status(503).json({ error: 'The tutor is not configured (missing OPENAI_API_KEY).' });
    return;
  }
  const { sessionId, text } = req.body as { sessionId?: unknown; text?: unknown };
  if (typeof sessionId !== 'string' || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'sessionId and text are required' });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.flushHeaders();

  let aborted = false;
  req.on('aborted', () => {
    aborted = true;
  });
  const send = (payload: unknown) => {
    if (!aborted && !res.writableEnded) res.write(JSON.stringify(payload) + '\n');
  };

  try {
    await runFallbackTurn(openai, TEXT_MODEL, repo, sessionId, text.trim(), send);
    send({ type: 'done' });
  } catch (err) {
    console.error('Fallback turn failed:', err);
    send({ type: 'error', message: 'The tutor request failed.' });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws/lesson') {
    socket.destroy();
    return;
  }
  const sessionId = url.searchParams.get('session');
  wss.handleUpgrade(request, socket, head, (client) => {
    if (!API_KEY || !sessionId) {
      client.send(
        JSON.stringify({
          type: 'error',
          message: API_KEY ? 'Missing session id.' : 'The tutor is not configured on this server.',
        }),
      );
      client.close(4400);
      return;
    }
    connectRealtimeProxy(client, {
      apiKey: API_KEY,
      model: REALTIME_MODEL,
      repo,
      sessionId,
      log: (line) => console.log(`[realtime] ${line}`),
    });
  });
});

server.listen(PORT, () => {
  console.log(`Seneca backend listening on http://localhost:${PORT}`);
});
