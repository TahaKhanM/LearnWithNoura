import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * ElevenLabs sits behind the backend rather than the browser so the key
 * never ships to the client, and so the model and voice can be changed in
 * one place without a rebuild.
 */

const API = 'https://api.elevenlabs.io/v1';

// Long inputs cost latency and the tutor speaks a sentence at a time, so a
// generous cap is really just a guard against a runaway prompt.
const MAX_TTS_CHARS = 1200;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function key(): string | undefined {
  return process.env.ELEVENLABS_API_KEY;
}

export function isVoiceConfigured(): boolean {
  return Boolean(key());
}

/**
 * Streams speech straight through from ElevenLabs to the browser. The
 * upstream body is piped rather than buffered so audio can start playing
 * before the whole clip has been generated.
 */
export async function handleTts(req: Request, res: Response): Promise<void> {
  const apiKey = key();
  if (!apiKey) {
    res.status(503).json({ error: 'Voice is not configured on the server.' });
    return;
  }

  const { text } = req.body as { text?: unknown };
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
  const modelId = process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5';

  const upstream = await fetch(
    `${API}/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.slice(0, MAX_TTS_CHARS),
        model_id: modelId,
        // Slightly above default stability and a touch of style keeps the
        // delivery warm and even, which suits reading a lesson to a child.
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
      }),
    },
  );

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    console.error('ElevenLabs TTS failed:', upstream.status, detail.slice(0, 400));
    res.status(502).json({ error: 'Speech generation failed.' });
    return;
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');

  try {
    // Node can consume a web ReadableStream directly, so no manual pump.
    // pipeline (not pipe) so a client disconnect tears the upstream down
    // instead of leaking a half-read response.
    const source = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(source, res);
  } catch (err) {
    // An aborted playback is normal here: the child interrupted, and the
    // browser dropped the request mid-clip.
    if ((err as NodeJS.ErrnoException)?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('TTS stream broke:', err);
    }
    if (!res.writableEnded) res.end();
  }
}

/**
 * Takes the raw recording from the browser and returns what was said.
 * The body arrives as an opaque audio buffer, which is forwarded to
 * Scribe as multipart form data.
 */
export async function handleStt(req: Request, res: Response): Promise<void> {
  const apiKey = key();
  if (!apiKey) {
    res.status(503).json({ error: 'Voice is not configured on the server.' });
    return;
  }

  const audio = req.body as Buffer;
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    res.status(400).json({ error: 'audio body is required' });
    return;
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    res.status(413).json({ error: 'Recording is too long.' });
    return;
  }

  const contentType = req.headers['content-type'] || 'audio/webm';
  // The extension has to match the container or Scribe rejects the upload.
  const extension = contentType.includes('mp4') || contentType.includes('mpeg')
    ? 'mp4'
    : contentType.includes('ogg')
      ? 'ogg'
      : 'webm';

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), `speech.${extension}`);
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v1');

  const upstream = await fetch(`${API}/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error('ElevenLabs STT failed:', upstream.status, detail.slice(0, 400));
    res.status(502).json({ error: 'Could not understand the recording.' });
    return;
  }

  const result = (await upstream.json()) as { text?: string };
  res.json({ text: (result.text || '').trim() });
}
