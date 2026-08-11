import type { LessonStep } from '../whiteboard/types';
import type { Message } from '../chat/types';
import { NdjsonParser } from './ndjson';

interface StreamHandlers {
  onStep: (step: LessonStep) => void;
}

/**
 * Opens the tutor stream and hands over each step as it lands. Resolves
 * when the lesson is finished; rejects if the model turn failed.
 */
export async function streamLesson(
  userMessage: string,
  history: Message[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/tutor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      message: userMessage,
      history: history.map((m) => ({ role: m.role, text: m.text })),
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Tutor request failed (${response.status})`);
  }

  if (!response.body) throw new Error('The tutor sent no response body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new NdjsonParser();
  let streamError: string | null = null;

  function handle(values: unknown[]) {
    for (const value of values) {
      const event = value as { type?: string; step?: LessonStep; message?: string };
      if (event.type === 'step' && event.step) handlers.onStep(event.step);
      else if (event.type === 'error') streamError = event.message || 'The tutor failed.';
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handle(parser.push(decoder.decode(value, { stream: true })));
    }
    handle(parser.flush());
  } finally {
    reader.releaseLock();
  }

  if (streamError) throw new Error(streamError);
}
