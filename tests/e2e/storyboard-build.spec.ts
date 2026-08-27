import { expect, test } from '@playwright/test';
import { createSyntheticSession, installFakeRealtime, setLessonCapability, startFakePlayback, stopFakePlayback } from '../helpers';

/**
 * The interleaved reveal-narrate contract from the child's seat, fully
 * offline: the fake socket plays the server's storyboard-runner emissions
 * and the fake voice transport drives real playback boundaries. The anchor
 * builds piece by piece between narration beats, an interruption mid-build
 * resumes at the first unrevealed step, and nothing ever disappears.
 */

interface FakeSocket {
  emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void;
  sent: Array<{ type: string; payload?: Record<string, unknown> }>;
}

async function emitStepCue(
  page: import('@playwright/test').Page,
  input: { responseId: string; eventId: number; checkpoint: string; op: Record<string, unknown>; cueId: string },
) {
  await page.evaluate((argument) => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit('board_ops', {
      response_id: argument.responseId,
      event_id: argument.eventId,
      ops: [argument.op],
      groupLabel: 'Fraction number line',
      checkpoint: argument.checkpoint,
      await_narration: true,
    }, { visualCueId: argument.cueId, semanticObjectId: 'lesson-anchor', providerResponseId: argument.responseId });
  }, input);
}

async function opsShownFor(page: import('@playwright/test').Page, eventId: number): Promise<boolean> {
  return page.evaluate((id) => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    return socket.sent.some((event) => event.type === 'ops_shown' && event.payload?.event_id === id);
  }, eventId);
}

const STEP_OPS = {
  scale: { op: 'add', id: 'anchor-scale', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1 } },
  mark: { op: 'add', id: 'anchor-mark', spec: { kind: 'point', at: [620, 300], label: '2/3' } },
  label: { op: 'add', id: 'anchor-label', spec: { kind: 'text', at: [130, 250], text: 'One shared scale' } },
} as const;

test('the anchor builds step by step between narration beats and survives an interruption intact', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `storyboard-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await expect(page.getByText(/Type below — Noura is ready|Listening/)).toBeVisible();

  const scale = page.locator('[data-item="anchor-scale"]');
  const mark = page.locator('[data-item="anchor-mark"]');
  const label = page.locator('[data-item="anchor-label"]');

  // The establishing response is speaking; its step cue arrives but the
  // reveal waits for the playback boundary.
  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'anchor-response' });
  });
  await startFakePlayback(page, 'anchor-response');
  await emitStepCue(page, { responseId: 'anchor-response', eventId: 501, checkpoint: 'outline', op: STEP_OPS.scale, cueId: 'reveal-outline' });
  await page.waitForTimeout(200);
  await expect(scale).toHaveCount(0);

  // Boundary: step one appears and is acknowledged; the next step's cue
  // rides tagged to the (not yet playing) first beat and stays hidden.
  await stopFakePlayback(page, 'anchor-response', 1_500);
  await expect(scale).toBeVisible();
  await expect.poll(() => opsShownFor(page, 501)).toBe(true);
  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'beat-0' });
  });
  await emitStepCue(page, { responseId: 'beat-0', eventId: 502, checkpoint: 'relation', op: STEP_OPS.mark, cueId: 'reveal-relation' });
  await page.waitForTimeout(200);
  await expect(mark).toHaveCount(0);

  // The beat narrates step one; step two appears exactly at its end.
  await startFakePlayback(page, 'beat-0');
  await page.waitForTimeout(150);
  await expect(mark).toHaveCount(0);
  await stopFakePlayback(page, 'beat-0', 900);
  await expect(mark).toBeVisible();
  await expect(scale).toBeVisible();
  await expect.poll(() => opsShownFor(page, 502)).toBe(true);

  // The next beat starts and its follow-up cue is pending when the learner
  // interrupts by typing: the pending reveal is dropped, revealed objects
  // stay exactly where they are.
  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'beat-1' });
  });
  await emitStepCue(page, { responseId: 'beat-1', eventId: 503, checkpoint: 'label', op: STEP_OPS.label, cueId: 'reveal-label' });
  await startFakePlayback(page, 'beat-1');
  await expect(page.getByText('Speaking')).toBeVisible();
  await page.getByLabel('Type to Noura').fill('Wait, why does it stop at one?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await page.waitForTimeout(300);
  await expect(label).toHaveCount(0);
  await expect(scale).toBeVisible();
  await expect(mark).toBeVisible();

  // The answer plays out; the server re-sends the unrevealed step bound to
  // the answer's playback boundary (the fake socket answered the typed turn
  // with 'fake-response'), and the build completes.
  await emitStepCue(page, { responseId: 'fake-response', eventId: 503, checkpoint: 'label', op: STEP_OPS.label, cueId: 'reveal-label-resend' });
  await startFakePlayback(page, 'fake-response');
  await page.waitForTimeout(150);
  await expect(label).toHaveCount(0);
  await stopFakePlayback(page, 'fake-response', 1_100);
  await expect(label).toBeVisible();
  await expect.poll(() => opsShownFor(page, 503)).toBe(true);

  // Permanence: everything revealed across the whole build is still there.
  await page.waitForTimeout(500);
  await expect(scale).toBeVisible();
  await expect(mark).toBeVisible();
  await expect(label).toBeVisible();
});
