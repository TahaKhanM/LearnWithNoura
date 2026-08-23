import { expect, test } from '@playwright/test';
import { createSyntheticSession, installFakeRealtime, setLessonCapability } from '../helpers';

test('released AI drawing survives normal re-renders, animation, and learner drawing', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `board-life-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await expect(page.getByText(/Type below — Noura is ready|Listening/)).toBeVisible();

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'drawing-response' });
    socket.emit('audio', {
      response_id: 'drawing-response', item_id: 'drawing-item',
      delta: btoa(String.fromCharCode(...new Uint8Array(48_000))),
    }, { audioSampleOffsets: { start: 0, end: 24_000 }, providerResponseId: 'drawing-response', providerItemId: 'drawing-item' });
    socket.emit('board_ops', {
      response_id: 'drawing-response', event_id: 701,
      ops: [{ op: 'add', id: 'durable-tutor-line', spec: { kind: 'line', from: [100, 280], to: [900, 280], width: 5 } }],
    }, { audioSampleOffsets: { start: 0, end: 0 }, visualCueId: 'durable-line-cue', semanticObjectId: 'durable-line', providerResponseId: 'drawing-response' });
  });

  const tutorLine = page.locator('[data-item="durable-tutor-line"]');
  await expect(tutorLine).toHaveCount(1);
  // Phase/energy and pen updates re-render the lesson repeatedly while the
  // line animates. None may be interpreted as canvas teardown.
  await page.waitForTimeout(120);

  await page.getByRole('button', { name: 'Draw on the board' }).click();
  const board = page.locator('.board__svg');
  const box = await board.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.35, box!.y + box!.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.55, { steps: 5 });
  await page.mouse.up();

  await expect(page.locator('[data-item^="sketch-"]')).toHaveCount(1);
  await expect(tutorLine).toHaveCount(1);
  await page.waitForTimeout(800);
  await expect(tutorLine).toHaveCount(1);
  await expect(tutorLine.locator('path')).toHaveCSS('stroke-dashoffset', '0px');
  await expect.poll(() => page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return [...socket.sent].reverse().find((event) => event.type === 'board_event')?.payload?.requestResponse;
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return socket.sent.some((event) => event.type === 'ops_shown' && event.payload?.event_id === 701);
  })).toBe(true);
});

test('speech stop immediately exposes a thinking state before reply audio', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `turn-life-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await expect(page.getByText(/Type below — Noura is ready|Listening/)).toBeVisible();

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('speech_started', {});
    socket.emit('speech_stopped', {});
  });
  await expect(page.getByText('Thinking…')).toBeVisible();

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'spoken-reply' });
    socket.emit('audio', {
      response_id: 'spoken-reply', item_id: 'spoken-item', delta: btoa('\0\0'),
    }, { audioSampleOffsets: { start: 0, end: 1 }, providerResponseId: 'spoken-reply', providerItemId: 'spoken-item' });
  });
  await expect(page.getByText('Speaking')).toBeVisible();
});

test('raw explanatory text is moved away from triangle strokes instead of accepting overlap', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `layout-life-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await expect(page.getByText(/Type below — Noura is ready|Listening/)).toBeVisible();

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'overlap-response' });
    socket.emit('board_ops', {
      response_id: 'overlap-response', event_id: 801,
      ops: [
        { op: 'add', id: 'overlap-triangle', spec: { kind: 'polygon', points: [[160, 450], [500, 100], [820, 450]], closed: true } },
        { op: 'add', id: 'overlap-top-line', spec: { kind: 'line', from: [120, 100], to: [880, 100], dash: true } },
        { op: 'add', id: 'overlap-apex-angle', spec: { kind: 'angle', vertex: [500, 100], from: [160, 450], to: [820, 450], label: 'C' } },
        { op: 'add', id: 'overlap-half-turn', spec: { kind: 'text', at: [510, 250], text: 'Half-turn = 180°' } },
        { op: 'add', id: 'overlap-straight-angle', spec: { kind: 'text', at: [410, 315], text: 'Straight angle' } },
      ],
    }, { audioSampleOffsets: { start: 0, end: 0 }, providerResponseId: 'overlap-response' });
  });

  const halfTurn = page.locator('[data-item="overlap-half-turn"] text');
  const straightAngle = page.locator('[data-item="overlap-straight-angle"] text');
  await expect(halfTurn).toBeVisible();
  await expect(straightAngle).toBeVisible();
  expect([Number(await halfTurn.getAttribute('x')), Number(await halfTurn.getAttribute('y'))]).not.toEqual([510, 250]);
  expect([Number(await straightAngle.getAttribute('x')), Number(await straightAngle.getAttribute('y'))]).toEqual([410, 315]);

  const strokeHitsAnnotation = await page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>('[data-item="overlap-triangle"] path');
    const annotation = document.querySelector<SVGTextElement>('[data-item="overlap-half-turn"] text');
    if (!path || !annotation) return true;
    const box = annotation.getBBox();
    const total = path.getTotalLength();
    for (let distance = 0; distance <= total; distance += 2) {
      const point = path.getPointAtLength(distance);
      if (point.x >= box.x - 8 && point.x <= box.x + box.width + 8 && point.y >= box.y - 8 && point.y <= box.y + box.height + 8) return true;
    }
    return false;
  });
  expect(strokeHitsAnnotation).toBe(false);
});
