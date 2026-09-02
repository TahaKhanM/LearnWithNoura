import { expect, test } from '@playwright/test';
import {
  createSyntheticSession,
  installFakeRealtime,
  setLessonCapability,
  startFakePlayback,
  stopFakePlayback,
  waitForFakeRealtimeStart,
} from '../helpers';

interface FakeSocket {
  emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void;
}

test('audio and subtitles stay ordered across consecutive, interrupted, and blocked responses', async ({ page, request }) => {
  const runtimeErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()); });
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  const { session, lessonCapability } = await createSyntheticSession(request, `media-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  const emit = (type: string, payload: Record<string, unknown>) => page.evaluate(([eventType, eventPayload]) => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit(eventType, eventPayload);
  }, [type, payload] as const);
  const caption = page.locator('.lesson__caption:not(.lesson__caption--placeholder)');

  // Generation can finish before media starts. No subtitle is allowed to
  // claim the child heard it until local playback begins.
  await emit('response_started', { response_id: 'response-1' });
  await emit('transcript_done', {
    response_id: 'response-1',
    text: 'First spoken phrase. Second spoken phrase.',
  });
  await expect(caption).toHaveCount(0);
  await startFakePlayback(page, 'response-1');
  await expect(caption).toHaveText('First spoken phrase.');
  await expect(page.getByText('Second spoken phrase.')).toHaveCount(0);
  await stopFakePlayback(page, 'response-1', 1_800);
  await expect(caption).toHaveText('First spoken phrase. Second spoken phrase.');

  // A late correction for response 1 updates its original ledger position;
  // it must never replace the visible response 2 subtitle.
  await emit('user_transcript', { text: 'And the next one?' });
  await emit('response_started', { response_id: 'response-2' });
  await emit('transcript_done', { response_id: 'response-2', text: 'Second response stays last.' });
  await startFakePlayback(page, 'response-2');
  await stopFakePlayback(page, 'response-2', 900);
  await expect(caption).toHaveText('Second response stays last.');
  await emit('transcript_done', { response_id: 'response-1', text: 'First corrected phrase.' });
  await expect(caption).toHaveText('Second response stays last.');

  // Interruption preserves the phrase already presented with playback and
  // rejects the generated-but-unheard tail, even if old events arrive late.
  await emit('response_started', { response_id: 'response-3' });
  await emit('transcript_done', {
    response_id: 'response-3',
    text: 'Heard interruption phrase. Unheard future phrase.',
  });
  await startFakePlayback(page, 'response-3');
  await expect(caption).toHaveText('Heard interruption phrase.');
  await page.getByLabel('Type to Noura').fill('Stop there.');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(caption).toHaveText('Heard interruption phrase.');
  await emit('transcript_done', {
    response_id: 'response-3',
    text: 'Heard interruption phrase. Unheard future phrase.',
  });
  await expect(page.getByText('Unheard future phrase.')).toHaveCount(0);

  // Autoplay failure becomes an explicit, recoverable state. Captions remain
  // useful while blocked and the learner can re-enable voice with one action.
  await emit('response_started', { response_id: 'response-4' });
  await emit('transcript_done', { response_id: 'response-4', text: 'Caption while sound is blocked.' });
  await page.evaluate(() => {
    const voice = (window as typeof window & {
      __nouraFakeVoice?: { block(responseId: string): void };
    }).__nouraFakeVoice;
    voice?.block('response-4');
  });
  await expect(caption).toHaveText('Caption while sound is blocked.');
  const enableVoice = page.getByRole('button', { name: 'Enable voice' });
  await expect(enableVoice).toBeVisible();
  await enableVoice.click();
  await expect(enableVoice).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});
