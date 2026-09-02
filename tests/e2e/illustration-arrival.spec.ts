import { expect, test } from '@playwright/test';
import { createSyntheticSession, installFakeRealtime, setLessonCapability, startFakePlayback, stopFakePlayback, waitForFakeRealtimeStart } from '../helpers';

/**
 * M4 banner/arrival UX from the child's seat, fully offline. Overlay
 * labels appear while the illustration_status banner is up; arrival hides
 * the banner without removing overlays; failure keeps overlays and shows
 * one honest failed status.
 */

interface FakeSocket {
  emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void;
}

const FROG_OVERLAY = {
  op: 'add',
  id: 'frog-label',
  spec: { kind: 'box', at: [180, 180], w: 420, h: 140, text: 'frog' },
} as const;

test('illustration banner stays up while overlays appear, then hides on arrival', async ({ page, request }, testInfo) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `illust-arrive-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit('illustration_status', { status: 'preparing', alt: 'A pond habitat' });
  });
  const banner = page.getByTestId('illustration-status');
  await expect(banner).toContainText('Preparing illustration');
  await expect(banner).toContainText('A pond habitat');
  await page.screenshot({ path: testInfo.outputPath('m4-banner-preparing.png') });

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'overlay-response' });
  });
  await startFakePlayback(page, 'overlay-response');
  await page.evaluate((op) => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit('board_ops', {
      response_id: 'overlay-response',
      event_id: 801,
      ops: [op],
      groupLabel: 'Pond habitat',
      checkpoint: 'label',
    }, { visualCueId: 'pond-label', semanticObjectId: 'pond-habitat', providerResponseId: 'overlay-response' });
  }, FROG_OVERLAY);
  await stopFakePlayback(page, 'overlay-response', 800);
  await expect(page.locator('[data-item="frog-label"]')).toBeVisible();
  await expect(page.getByText('frog', { exact: true })).toBeVisible();
  await expect(banner).toContainText('Preparing illustration');
  await page.screenshot({ path: testInfo.outputPath('m4-overlay-with-banner.png') });

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit('illustration_status', { status: 'ready' });
  });
  await expect(page.locator('[data-item="frog-label"]')).toBeVisible();
  await expect(page.getByText('frog', { exact: true })).toBeVisible();
  await expect(banner).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('m4-arrival-banner-gone.png') });
});

test('illustration failure keeps overlay marks and shows one honest failed banner', async ({ page, request }, testInfo) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `illust-fail-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await page.evaluate((op) => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit('illustration_status', { status: 'preparing', alt: 'A pond habitat' });
    socket.emit('board_ops', {
      event_id: 811,
      ops: [op],
      groupLabel: 'Pond habitat',
      checkpoint: 'label',
    }, { visualCueId: 'pond-label', semanticObjectId: 'pond-habitat' });
  }, FROG_OVERLAY);
  await expect(page.getByText('frog', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: FakeSocket }).__nouraFakeSocket;
    socket.emit('illustration_status', { status: 'failed' });
  });
  await expect(page.getByTestId('illustration-status')).toContainText('could not be prepared');
  await expect(page.getByText('frog', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('m4-failure-overlays-remain.png') });
});
