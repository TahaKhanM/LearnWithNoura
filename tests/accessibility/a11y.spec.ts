import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSyntheticSession, installFakeRealtime, setLessonCapability, waitForFakeRealtimeStart } from '../helpers';

test('Home has no serious or critical automated accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Noura' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
});

test('required login has no serious or critical automated accessibility violations', async ({ page }) => {
  await page.route('**/api/auth/session', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ required: true, authenticated: false }) });
  });
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
});

test('canonical board fixture exposes a programmatic long description', async ({ page }) => {
  await page.goto('/dev/board');
  await page.getByRole('button', { name: 'fractions' }).click();
  const board = page.getByRole('group', { name: 'Shared Noura whiteboard' });
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
  await waitForFakeRealtimeStart(page);
  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('safe_question', { text: '' });
  });
  await expect(page.getByText(/Type below — Noura is ready|Listening/)).toBeVisible();
  await assertNoSeriousAxe(page);

  await page.getByLabel('Type to Noura').fill('Show me the fraction scale');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByText('Thinking…')).toBeVisible();
  await assertNoSeriousAxe(page);

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    // Cues arrive before playback starts (the tool-first flow), so they
    // render immediately; the playback boundary then marks Speaking.
    socket.emit('transcript_delta', { response_id: 'fake-response', item_id: 'fake-item', delta: 'Which fraction is farther right?' }, { providerResponseId: 'fake-response' });
    socket.emit('board_ops', {
      response_id: 'fake-response', groupLabel: 'Fraction number line', checkpoint: 'outline',
      ops: [{ op: 'add', id: 'fraction-scale-main', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1, step: 0.1, marks: [{ value: 0.5, label: '1/2', color: 'blue' }, { value: 0.75, label: '3/4', color: 'red' }] } }],
    }, { visualCueId: 'fraction-outline', semanticObjectId: 'fraction-scale', providerResponseId: 'fake-response' });
    socket.emit('lesson_state', { state: { activeConcept: 'fraction comparison', phase: 'VISUALIZE', activeSemanticObjectId: 'fraction-scale', characterAttentionTarget: 'semantic_object' } }, { semanticObjectId: 'fraction-scale' });
    socket.emit('transcript_done', { response_id: 'fake-response', text: 'Which fraction is farther right?' }, { providerResponseId: 'fake-response' });
    const voice = (window as typeof window & { __nouraFakeVoice: { emitBoundary(boundary: string, responseId: string | null, playedMs?: number): void } }).__nouraFakeVoice;
    voice.emitBoundary('started', 'fake-response');
  });
  await expect(page.getByText('Speaking')).toBeVisible();
  await expect(page.locator('[data-item="fraction-scale-main"]')).toBeVisible();
  await expect(page.getByLabel('Board section', { exact: true })).toHaveValue('fraction-scale');
  await expect(page.getByRole('status')).toContainText('Fraction number line');
  await assertActiveBoardTextContained(page, ['1/2', '3/4']);
  expect(await page.locator('.avatar').getAttribute('data-attention-target')).toBe('semantic_object');
  const firstSemanticView = await page.locator('.board__svg').getAttribute('viewBox');
  await page.getByRole('button', { name: 'Next part of this board section' }).click();
  await expect(page.locator('.board__svg')).not.toHaveAttribute('viewBox', firstSemanticView ?? '');
  await page.getByRole('button', { name: 'Fit the full board overview' }).click();
  await expect(page.locator('.board__svg')).toHaveAttribute('viewBox', '0 0 1000 600');
  await page.getByRole('button', { name: 'Focus the active board area' }).click();
  await assertNoSeriousAxe(page);

  await page.evaluate(() => {
    // The narration finished: later cues for this response render on arrival.
    const voice = (window as typeof window & { __nouraFakeVoice: { emitBoundary(boundary: string, responseId: string | null, playedMs?: number): void } }).__nouraFakeVoice;
    voice.emitBoundary('stopped', 'fake-response', 2_000);
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_ops', {
      response_id: 'fake-response', groupLabel: 'Fraction number line',
      ops: [{ op: 'add', id: 'fraction-context-note', spec: { kind: 'text', at: [380, 170], text: 'Compare on one scale' } }],
    }, { visualCueId: 'fraction-context', semanticObjectId: 'fraction-scale', providerResponseId: 'fake-response' });
  });
  await expect(page.locator('[data-item="fraction-context-note"]')).toBeVisible();

  const highlightOfferedAt = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    const start = performance.now();
    socket.emit('board_ops', { response_id: 'fake-response', ops: [{ op: 'highlight', id: 'fraction-scale-main' }] }, { visualCueId: 'fraction-highlight', semanticObjectId: 'fraction-scale', providerResponseId: 'fake-response' });
    return start;
  });
  await expect(page.locator('.avatar[data-attention-target="focused_object"]')).toBeVisible();
  await expect(page.locator('[data-item="fraction-context-note"]')).toHaveClass(/board__item--deemphasized/);
  expect(await page.evaluate((start) => performance.now() - start, highlightOfferedAt)).toBeLessThanOrEqual(200);

  await page.evaluate(() => {
    // A cue for a response that is still audibly playing waits for its
    // playback boundary — the learner's interruption below must drop it.
    const voice = (window as typeof window & { __nouraFakeVoice: { emitBoundary(boundary: string, responseId: string | null, playedMs?: number): void } }).__nouraFakeVoice;
    voice.emitBoundary('started', 'fake-response');
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_ops', {
      response_id: 'fake-response', await_narration: true,
      ops: [{ op: 'add', id: 'fraction-scale-future', spec: { kind: 'text', at: [500, 180], text: 'future label' } }],
    }, { visualCueId: 'future-cue', semanticObjectId: 'fraction-scale', providerResponseId: 'fake-response' });
  });
  await page.getByRole('button', { name: 'Draw on the board' }).click();
  const boardBox = await page.locator('.board__svg').boundingBox();
  expect(boardBox).not.toBeNull();
  await page.mouse.move(boardBox!.x + boardBox!.width / 2, boardBox!.y + boardBox!.height / 2);
  await page.mouse.down();
  await expect(page.locator('.avatar[data-attention-target="interruption"]')).toBeVisible();
  await page.mouse.move(boardBox!.x + boardBox!.width / 2 + 30, boardBox!.y + boardBox!.height / 2 + 20);
  await page.mouse.up();
  await expect(page.locator('[data-item="fraction-scale-future"]')).toHaveCount(0);
  await expect(page.locator('[data-item="fraction-scale-main"]')).toBeVisible();
  await expect(page.locator('[data-item^="sketch-"]')).toHaveCount(1);
  await expect(page.locator('[data-item="fraction-context-note"]')).not.toHaveClass(/board__item--deemphasized/, { timeout: 2_000 });
  // The stroke only opened a draft. Nothing is captured or submitted until
  // the learner explicitly presses Done.
  expect(await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string }> } }).__nouraFakeSocket;
    return socket.sent.filter((event) => ['board_event', 'board_submission'].includes(event.type)).length;
  })).toBe(0);
  await page.getByTestId('draft-done').click();
  await expect.poll(() => page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    const event = [...socket.sent].reverse().find((candidate) => candidate.type === 'board_submission');
    return event ? {
      hasImage: typeof event?.payload?.imageDataUrl === 'string' && String(event.payload.imageDataUrl).startsWith('data:image/jpeg;base64,'),
      opCount: Array.isArray(event?.payload?.ops) ? event.payload.ops.length : 0,
      analysisVersion: (event?.payload?.analysis as { version?: string } | undefined)?.version,
      analysisGroup: (event?.payload?.analysis as { semanticGroupId?: string } | undefined)?.semanticGroupId,
    } : null;
  })).toEqual({ hasImage: true, opCount: 1, analysisVersion: '1.0.0', analysisGroup: 'fraction-scale' });
  expect(await page.evaluate(async () => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    const src = String([...socket.sent].reverse().find((candidate) => candidate.type === 'board_submission')?.payload?.imageDataUrl ?? '');
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('context image failed')); image.src = src; });
    return { width: image.naturalWidth, height: image.naturalHeight };
  })).toEqual({ width: 960, height: 576 });
  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }>; emit(type: string, payload: Record<string, unknown>): void } }).__nouraFakeSocket;
    const submissionId = String([...socket.sent].reverse().find((candidate) => candidate.type === 'board_submission')?.payload?.submissionId ?? '');
    socket.emit('board_submission_ack', { submissionId });
  });
  // Tutor checkpoints deliberately no longer reset the learner's part
  // position; navigate back to the first part explicitly for the
  // responsive containment assertions below.
  await page.getByRole('button', { name: 'Previous part of this board section' }).click();

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
  await assertActiveBoardTextContained(page, ['1/2', '3/4']);
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
  await assertActiveBoardTextContained(page, ['1/2', '3/4']);

  // Playwright cannot drive browser UI zoom. A 640×400 CSS viewport is the
  // deterministic effective viewport of a 1280×800 page at 200% and exercises
  // the same compact width/height media-query path. Physical/browser zoom is
  // intentionally kept UNVERIFIED in the evidence ledger.
  await page.setViewportSize({ width: 640, height: 400 });
  const compactControls = [
    page.getByLabel('Board section', { exact: true }),
    page.getByRole('button', { name: 'Previous part of this board section' }),
    page.getByRole('button', { name: 'Next part of this board section' }),
    page.getByRole('button', { name: 'Fit the full board overview' }),
  ];
  for (const control of compactControls) {
    await expect(control).toBeVisible();
    const rect = await control.boundingBox();
    expect(rect, `missing compact control geometry: ${await control.getAttribute('aria-label')}`).not.toBeNull();
    expect(rect!.height).toBeGreaterThanOrEqual(44);
  }
  const effectiveViewportOverflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(effectiveViewportOverflow.x).toBeLessThanOrEqual(1);
  expect(effectiveViewportOverflow.y).toBeLessThanOrEqual(1);
  await assertActiveBoardTextContained(page, ['1/2', '3/4']);
  await compactControls[0].focus();
  await page.keyboard.press('Tab');
  const focusAppearance = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const style = active ? getComputedStyle(active) : null;
    const rect = active?.getBoundingClientRect();
    return {
      label: active?.getAttribute('aria-label'),
      focusVisible: active?.matches(':focus-visible') ?? false,
      outlineStyle: style?.outlineStyle,
      outlineWidth: Number.parseFloat(style?.outlineWidth ?? '0'),
      contained: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
    };
  });
  expect(focusAppearance).toMatchObject({
    label: 'Next part of this board section', focusVisible: true, outlineStyle: 'solid', contained: true,
  });
  expect(focusAppearance.outlineWidth).toBeGreaterThanOrEqual(2);
});

test('manipulate controls stay out of img role and meet hit-target minimums', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { session, lessonCapability } = await createSyntheticSession(request, `a11y-manip-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await page.waitForFunction(() => Boolean((window as typeof window & { __nouraFakeSocket?: { identity?: unknown } }).__nouraFakeSocket?.identity));
  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('learner_task', {
      task: {
        taskId: 'place-three-quarters',
        prompt: 'Drag the marker onto three-quarters.',
        responseMode: 'manipulate',
        submitPolicy: 'explicit',
        manipulativeCheck: { targetId: 'lesson-anchor-marker', predicate: 'snapped', snapZoneId: 'lesson-anchor-zone-three-quarters', tolerance: 12 },
      },
    });
    socket.emit('board_ops', {
      response_id: 'setup',
      ops: [
        { op: 'add', id: 'lesson-anchor-line', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1 } },
        { op: 'add', id: 'lesson-anchor-zone-three-quarters', spec: { kind: 'snapZone', shape: 'interval', at: [685, 300], numberlineId: 'lesson-anchor-line', from: 0.7, to: 0.8, tolerance: 12 } },
        { op: 'add', id: 'lesson-anchor-marker', spec: { kind: 'draggable', handle: 'token', at: [200, 300], size: 44, label: 'marker' } },
      ],
    }, { semanticObjectId: 'lesson-anchor' });
  });
  const board = page.getByRole('group', { name: 'Shared Noura whiteboard' });
  await expect(board).toBeVisible();
  const fitOverview = page.getByRole('button', { name: 'Fit the full board overview' });
  if (await fitOverview.isVisible()) await fitOverview.click();
  const marker = page.locator('[data-manipulative-id="lesson-anchor-marker"]');
  await expect(marker).toBeVisible();
  const hitSize = await marker.evaluate((node) => {
    const svg = node.ownerSVGElement;
    const viewBox = svg?.viewBox.baseVal;
    const svgRect = svg?.getBoundingClientRect();
    const r = Number(node.getAttribute('r') ?? '0');
    const scale = svgRect && viewBox ? svgRect.width / viewBox.width : 1;
    const cssDiameter = r * 2 * scale;
    return {
      role: node.getAttribute('role'),
      logical: Number(node.getAttribute('data-manipulative-hit-size')),
      cssDiameter,
    };
  });
  expect(hitSize.logical).toBeGreaterThanOrEqual(44);
  expect(hitSize.cssDiameter).toBeGreaterThanOrEqual(44 * 0.95);
  expect(hitSize.role).toBe('slider');
  await marker.focus();
  const tabbables = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.board__manipulative-hit[tabindex="0"]')].map((node) => node.getAttribute('data-manipulative-id')),
  );
  expect(tabbables).toEqual(['lesson-anchor-marker']);
});

async function assertNoSeriousAxe(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
}

async function assertActiveBoardTextContained(page: import('@playwright/test').Page, required: string[]) {
  const geometry = await page.locator('.board__svg').evaluate((svg) => {
    const outer = svg.getBoundingClientRect();
    return [...svg.querySelectorAll<SVGGraphicsElement>('[data-required-text-key]')]
      .filter((node) => getComputedStyle(node).visibility !== 'hidden')
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          text: node.getAttribute('data-required-text') ?? '',
          height: rect.height,
          contained: rect.left >= outer.left - 0.5 && rect.right <= outer.right + 0.5 && rect.top >= outer.top - 0.5 && rect.bottom <= outer.bottom + 0.5,
        };
      });
  });
  expect(geometry.every((entry) => entry.contained)).toBe(true);
  for (const text of required) {
    const entry = geometry.find((candidate) => candidate.text === text);
    expect(entry, `active educational text missing: ${text}`).toBeTruthy();
    expect(entry!.height, `active educational text too small: ${text}`).toBeGreaterThanOrEqual(16);
  }
}
