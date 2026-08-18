import { config } from 'dotenv';
import express from 'express';
import OpenAI from 'openai';
import { runTutorTurn, type HistoryTurn } from './tutorAgent';
import { handleStt, handleTts, isVoiceConfigured } from './voice';

// override: true so .env is authoritative even if a stale OPENAI_API_KEY
// is already exported in the parent shell (e.g. via ~/.zshrc).
config({ override: true });

const PORT = Number(process.env.PORT) || 8787;
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-terra';

if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment. Set it in .env.');
  process.exit(1);
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.use(express.json());
// Recordings arrive as an opaque audio body, so they bypass the JSON parser.
app.use('/api/stt', express.raw({ type: 'audio/*', limit: '25mb' }));

if (!isVoiceConfigured()) {
  console.warn('No ELEVENLABS_API_KEY set. The tutor will run silently.');
}

// Tells the client whether to offer voice at all, so the UI reflects the
// server's actual capability rather than guessing.
app.get('/api/voice/status', (_req, res) => {
  res.json({ enabled: isVoiceConfigured() });
});

app.post('/api/tts', handleTts);
app.post('/api/stt', handleStt);

app.post('/api/tutor', async (req, res) => {
  const { message, history } = req.body as { message?: string; history?: HistoryTurn[] };

  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  // Newline delimited JSON, one step per line, flushed as the model
  // produces it. The client can start drawing the first line while the
  // model is still deciding on the second.
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let aborted = false;
  req.on('aborted', () => {
    aborted = true;
  });

  function send(payload: unknown) {
    if (aborted || res.writableEnded) return;
    res.write(JSON.stringify(payload) + '\n');
  }

  try {
    await runTutorTurn(
      client,
      MODEL,
      Array.isArray(history) ? history : [],
      message,
      (step) => send({ type: 'step', step }),
    );
    send({ type: 'done' });
  } catch (err) {
    console.error('Tutor turn failed:', err);
    // Headers are already out, so the failure has to travel in the stream
    // rather than as a status code.
    send({ type: 'error', message: 'The tutor model request failed.' });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Seneca tutor backend listening on http://localhost:${PORT}`);
});
