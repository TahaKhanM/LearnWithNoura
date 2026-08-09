import { config } from 'dotenv';
import express from 'express';
import OpenAI from 'openai';
import { runTutorTurn, type HistoryTurn } from './tutorAgent';

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

app.post('/api/tutor', async (req, res) => {
  const { message, history } = req.body as { message?: string; history?: HistoryTurn[] };

  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    const steps = await runTutorTurn(client, MODEL, Array.isArray(history) ? history : [], message);
    res.json({ steps });
  } catch (err) {
    console.error('Tutor turn failed:', err);
    res.status(502).json({ error: 'The tutor model request failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`Seneca tutor backend listening on http://localhost:${PORT}`);
});
