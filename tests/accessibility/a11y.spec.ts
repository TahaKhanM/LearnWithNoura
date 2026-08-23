import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSyntheticSession, installFakeRealtime, setLessonCapability } from '../helpers';

test('Home has no serious or critical automated accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Noura' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
});

test('canonical board fixture exposes a programmatic long description', async ({ page }) => {
  await page.goto('/dev/board');
  await page.getByRole('button', { name: 'fractions' }).click();
  const board = page.getByRole('img', { name: 'Shared Noura whiteboard' });
  await expect(board).toHaveAttribute('aria-describedby', 'noura-board-description');
  await expect(page.locator('#noura-board-description')).toContainText('number line');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
});

test('actual Lesson start, listening, thinking, speaking/visual, reduced-motion and mobile reflow states', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `a11y-${Date.now().toString(36)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await expect(page.getByRole('button', { name: 'Begin' })).toBeVisible();
  await assertNoSeriousAxe(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const focusOrder: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press('Tab');
    focusOrder.push(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? ''));
  }
  expect(focusOrder[0]).toContain('Skip to main content');
  expect(focusOrder).toContain('End lesson');
  expect(focusOrder).toContain('Begin');

  await page.getByRole('button', { name: 'Begin' }).click();
  await expect(page.getByText(/Type below — Noura is ready|Listening/)).toBeVisible();
  await assertNoSeriousAxe(page);

  await page.getByLabel('Type to Noura').fill('Show me the fraction scale');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByText('Thinking…')).toBeVisible();
  await assertNoSeriousAxe(page);

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    const bytes = String.fromCharCode(...new Uint8Array(48_000));
    socket.emit('audio', { response_id: 'fake-response', item_id: 'fake-item', delta: btoa(bytes) }, { audioSampleOffsets: { start: 0, end: 24_000 }, providerResponseId: 'fake-response', providerItemId: 'fake-item' });
    socket.emit('transcript_delta', { response_id: 'fake-response', item_id: 'fake-item', delta: 'Which fraction is farther right?' }, { audioSampleOffsets: { start: 0, end: 2_400 }, providerResponseId: 'fake-response' });
    socket.emit('board_ops', {
      response_id: 'fake-response', groupLabel: 'Fraction number line', checkpoint: 'outline',
      ops: [{ op: 'add', id: 'fraction-scale-main', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1, step: 0.1, marks: [{ value: 0.5, label: '1/2', color: 'blue' }, { value: 0.75, label: '3/4', color: 'red' }] } }],
    }, { audioSampleOffsets: { start: 0, end: 0 }, visualCueId: 'fraction-outline', semanticObjectId: 'fraction-scale', providerResponseId: 'fake-response' });
    socket.emit('lesson_state', { state: { activeConcept: 'fraction comparison', phase: 'VISUALIZE', activeSemanticObjectId: 'fraction-scale', characterAttentionTarget: 'semantic_object' } }, { audioSampleOffsets: { start: 0, end: 0 }, semanticObjectId: 'fraction-scale' });
    socket.emit('transcript_done', { response_id: 'fake-response', text: 'Which fraction is farther right?' }, { audioSampleOffsets: { start: 0, end: 24_000 }, providerResponseId: 'fake-response' });
  });
  await expect(page.getByText('Speaking')).toBeVisible();
  await expect(page.getByLabel('Board section', { exact: true })).toHaveValue('fraction-scale');
  expect(await page.locator('.avatar').getAttribute('data-attention-target')).toBe('semantic_object');
  const firstSemanticView = await page.locator('.board__svg').getAttribute('viewBox');
  await page.getByRole('button', { name: 'Next part of this board section' }).click();
  await expect(page.locator('.board__svg')).not.toHaveAttribute('viewBox', firstSemanticView ?? '');
  await page.getByRole('button', { name: 'Fit the full board overview' }).click();
  await expect(page.locator('.board__svg')).toHaveAttribute('viewBox', '0 0 1000 600');
  await page.getByRole('button', { name: 'Focus the active board area' }).click();
  await assertNoSeriousAxe(page);

  const highlightOfferedAt = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    const start = performance.now();
    socket.emit('board_ops', { response_id: 'fake-response', ops: [{ op: 'highlight', id: 'fraction-scale-main' }] }, { audioSampleOffsets: { start: 0, end: 0 }, visualCueId: 'fraction-highlight', semanticObjectId: 'fraction-scale', providerResponseId: 'fake-response' });
    return start;
  });
  await expect(page.locator('.avatar[data-attention-target="focused_object"]')).toBeVisible();
  expect(await page.evaluate((start) => performance.now() - start, highlightOfferedAt)).toBeLessThanOrEqual(200);

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_ops', { response_id: 'fake-response', ops: [{ op: 'add', id: 'fraction-scale-future', spec: { kind: 'text', at: [500, 180], text: 'future label' } }] }, { audioSampleOffsets: { start: 20_000, end: 24_000 }, visualCueId: 'future-cue', semanticObjectId: 'fraction-scale', providerResponseId: 'fake-response' });
  });
  await page.getByRole('button', { name: 'Draw on the board' }).click();
  const boardBox = await page.locator('.board__svg').boundingBox();
  expect(boardBox).not.toBeNull();
  await page.mouse.move(boardBox!.x + boardBox!.width / 2, boardBox!.y + boardBox!.height / 2);
  await page.mouse.down();
  await expect(page.locator('.avatar[data-attention-target="interruption"]')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('[data-item="fraction-scale-future"]')).toHaveCount(0);

  const browserArtifactDir = resolve('artifacts/browser');
  mkdirSync(browserArtifactDir, { recursive: true });
  await page.screenshot({ path: resolve(browserArtifactDir, 'lesson-semantic-mobile.png') });

  const mobile = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>('button:not([disabled]), select, input')].map((node) => ({ label: node.getAttribute('aria-label') ?? node.textContent?.trim(), rect: node.getBoundingClientRect().toJSON() }));
    const svg = document.querySelector('.board__svg');
    const viewBoxWidth = Number(svg?.getAttribute('viewBox')?.split(/\s+/)[2]);
    return { controls, viewBoxWidth, horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(mobile.viewBoxWidth).toBeLessThanOrEqual(350);
  expect(mobile.horizontalOverflow).toBeLessThanOrEqual(1);
  for (const control of mobile.controls.filter((entry) => !String(entry.label).includes('Pen colour'))) expect(control.rect.height).toBeGreaterThanOrEqual(44);

  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const rect = (document.activeElement as HTMLElement | null)?.getBoundingClientRect();
    return rect ? { top: rect.top, bottom: rect.bottom, height: innerHeight } : null;
  });
  expect(focus).not.toBeNull();
  expect(focus!.top).toBeGreaterThanOrEqual(0);
  expect(focus!.bottom).toBeLessThanOrEqual(focus!.height);

  await page.setViewportSize({ width: 844, height: 390 });
  const landscapeOverflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth, y: document.documentElement.scrollHeight - document.documentElement.clientHeight }));
  expect(landscapeOverflow.x).toBeLessThanOrEqual(1);
  expect(landscapeOverflow.y).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  const zoomOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(zoomOverflow).toBeLessThanOrEqual(1);
});

async function assertNoSeriousAxe(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
}
