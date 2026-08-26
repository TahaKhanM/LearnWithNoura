import { test, expect } from '@playwright/test';
import { createSyntheticSession, installFakeRealtime, setLessonCapability } from '../helpers';

test('drag-check feedback and Done-only submit for manipulate tasks', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `manipulate-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await expect(page.getByText(/Type below — Noura is ready|Listening/)).toBeVisible();

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('learner_task', {
      task: {
        taskId: 'place-three-quarters',
        prompt: 'Drag the marker onto three-quarters on the number line.',
        responseMode: 'manipulate',
        submitPolicy: 'explicit',
        targetObjectIds: ['lesson-anchor-marker', 'lesson-anchor-line'],
        manipulativeCheck: {
          targetId: 'lesson-anchor-marker',
          predicate: 'snapped',
          snapZoneId: 'lesson-anchor-zone-three-quarters',
          tolerance: 12,
        },
        boardRevision: 0,
        allowVoiceWhileDrawing: true,
      },
    });
    socket.emit('board_ops', {
      response_id: 'setup',
      ops: [
        { op: 'add', id: 'lesson-anchor-line', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1, step: 0.25, marks: [{ value: 0.5, label: '1/2' }, { value: 0.75, label: '3/4' }] } },
        { op: 'add', id: 'lesson-anchor-zone-three-quarters', spec: { kind: 'snapZone', shape: 'interval', at: [685, 300], numberlineId: 'lesson-anchor-line', from: 0.7, to: 0.8, tolerance: 12 } },
        { op: 'add', id: 'lesson-anchor-marker', color: 'amber', spec: { kind: 'draggable', handle: 'token', at: [200, 300], size: 44, label: 'marker' } },
      ],
    }, { semanticObjectId: 'lesson-anchor' });
  });

  await expect(page.getByTestId('task-banner')).toContainText('move or tap');
  const boardBox = await page.locator('.board__svg').boundingBox();
  expect(boardBox).not.toBeNull();

  const sentBeforeDrag = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string }> } }).__nouraFakeSocket;
    return socket.sent.filter((event) => event.type === 'board_submission').length;
  });
  expect(sentBeforeDrag).toBe(0);

  const marker = page.locator('[data-manipulative-id="lesson-anchor-marker"]');
  await expect(marker).toBeVisible();
  const markerBox = await marker.boundingBox();
  expect(markerBox).not.toBeNull();
  await page.mouse.move(markerBox!.x + markerBox!.width / 2, markerBox!.y + markerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(boardBox!.x + boardBox!.width * 0.72, boardBox!.y + boardBox!.height * 0.55, { steps: 8 });
  await page.mouse.up();

  const sentAfterDrag = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string }> } }).__nouraFakeSocket;
    return socket.sent.filter((event) => event.type === 'board_submission').length;
  });
  expect(sentAfterDrag).toBe(0);

  await expect(page.getByTestId('draft-done')).toBeEnabled();
  await page.getByTestId('draft-done').click();
  await expect.poll(async () => page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return [...socket.sent].reverse().find((event) => event.type === 'board_submission')?.payload ?? null;
  }), { timeout: 10_000 }).toMatchObject({
    taskId: 'place-three-quarters',
    manipulativeResult: { passed: expect.any(Boolean), predicate: 'snapped', targetId: 'lesson-anchor-marker' },
  });
  const submission = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return [...socket.sent].reverse().find((event) => event.type === 'board_submission')?.payload ?? null;
  });
  expect(Array.isArray(submission?.ops)).toBe(true);
});
