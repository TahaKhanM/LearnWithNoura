import { test, expect } from '@playwright/test';
import { createSyntheticSession, installFakeRealtime, setLessonCapability, waitForFakeRealtimeStart } from '../helpers';

async function emitManipulateTask(page: import('@playwright/test').Page) {
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
}

async function dragMarkerOntoThreeQuarters(page: import('@playwright/test').Page) {
  const marker = page.locator('[data-manipulative-id="lesson-anchor-marker"]');
  await expect(marker).toBeVisible();
  await marker.focus();
  for (let step = 0; step < 49; step += 1) {
    await page.keyboard.press('Shift+ArrowRight');
  }
}

async function waitForSubmission(page: import('@playwright/test').Page) {
  return page.waitForFunction(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return Boolean([...socket.sent].reverse().find((event) => event.type === 'board_submission')?.payload?.ops);
  }, null, { timeout: 10_000 });
}

test('drag-check feedback and Done-only submit for manipulate tasks', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `manipulate-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await emitManipulateTask(page);

  await expect(page.getByTestId('task-banner')).toContainText('move or tap');

  const sentBeforeDrag = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string }> } }).__nouraFakeSocket;
    return socket.sent.filter((event) => event.type === 'board_submission').length;
  });
  expect(sentBeforeDrag).toBe(0);

  await dragMarkerOntoThreeQuarters(page);

  const sentAfterDrag = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string }> } }).__nouraFakeSocket;
    return socket.sent.filter((event) => event.type === 'board_submission').length;
  });
  expect(sentAfterDrag).toBe(0);

  await expect(page.getByTestId('draft-done')).toBeEnabled();
  await page.getByTestId('draft-done').click();
  await waitForSubmission(page);

  const submission = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return [...socket.sent].reverse().find((event) => event.type === 'board_submission')?.payload ?? null;
  });
  expect(submission).toMatchObject({
    taskId: 'place-three-quarters',
    manipulativeResult: { passed: true, predicate: 'snapped', targetId: 'lesson-anchor-marker' },
  });
  const ops = submission?.ops as Array<{ op: string; id: string; props?: { at?: number[] } }>;
  expect(ops?.length).toBeGreaterThan(0);
  const finalOp = ops![ops!.length - 1];
  expect(finalOp).toMatchObject({ op: 'update', id: 'lesson-anchor-marker' });
  expect(finalOp.props?.at?.[0]).toBeGreaterThan(650);
});

test('reconnect replays persisted manipulative marker position', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `manipulate-reconnect-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);
  await emitManipulateTask(page);

  await dragMarkerOntoThreeQuarters(page);
  await page.getByTestId('draft-done').click();
  await waitForSubmission(page);

  const submittedOps = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    const payload = [...socket.sent].reverse().find((event) => event.type === 'board_submission')?.payload;
    return payload?.ops ?? null;
  });
  expect(Array.isArray(submittedOps)).toBe(true);
  const lastOp = (submittedOps as Array<{ props?: { at?: number[] } }>).at(-1);
  const submittedAt = lastOp?.props?.at?.[0];
  expect(submittedAt).toBeGreaterThan(650);

  await page.waitForFunction(() => Boolean((window as typeof window & { __nouraFakeSocket?: { identity?: unknown } }).__nouraFakeSocket?.identity));

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_ops', {
      response_id: 'reset-marker',
      ops: [{ op: 'add', id: 'lesson-anchor-marker', spec: { kind: 'draggable', handle: 'token', at: [200, 300], size: 44, label: 'marker' } }],
    }, { semanticObjectId: 'lesson-anchor' });
  });

  const marker = page.locator('[data-manipulative-id="lesson-anchor-marker"]');
  await expect.poll(async () => marker.evaluate((node) => Number(node.getAttribute('cx')))).toBeLessThan(300);

  await page.evaluate((ops) => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('learner_board_replay', { batches: [{ ops, semanticObjectId: 'lesson-anchor' }] });
  }, submittedOps);

  await expect.poll(async () => marker.evaluate((node) => Number(node.getAttribute('cx')))).toBeCloseTo(submittedAt!, 0);
});
