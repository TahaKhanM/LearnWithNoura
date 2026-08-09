import type { LessonStep } from '../whiteboard/types';
import type { Message } from '../chat/types';

export async function requestLesson(userMessage: string, history: Message[]): Promise<LessonStep[]> {
  const response = await fetch('/api/tutor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: userMessage,
      history: history.map((m) => ({ role: m.role, text: m.text })),
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Tutor request failed (${response.status})`);
  }

  const data = (await response.json()) as { steps: LessonStep[] };
  return data.steps;
}
