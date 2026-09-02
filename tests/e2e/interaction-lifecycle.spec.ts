import { expect, test } from '@playwright/test';
import { createSyntheticSession, installFakeRealtime, setLessonCapability, waitForFakeRealtimeStart } from '../helpers';

test('released AI drawing survives normal re-renders, animation, and learner drawing', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `board-life-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await page.evaluate(() => {
    type AnimationTrace = {
      first: { dashOffset: string; opacity: string } | null;
      removals: number;
      present: boolean;
      observer: MutationObserver;
    };
    const trace = { first: null, removals: 0, present: false } as Omit<AnimationTrace, 'observer'>;
    const sample = () => {
      const path = document.querySelector<SVGPathElement>('[data-item="durable-tutor-line"] path');
      const present = Boolean(path);
      if (path && !trace.first) {
        trace.first = {
          dashOffset: path.style.strokeDashoffset,
          opacity: getComputedStyle(path).opacity,
        };
      }
      if (trace.present && !present) trace.removals += 1;
      trace.present = present;
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    (window as typeof window & { __nouraAnimationTrace: AnimationTrace }).__nouraAnimationTrace = Object.assign(trace, { observer });
  });

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'drawing-response' });
    socket.emit('board_ops', {
      response_id: 'drawing-response', event_id: 701,
      ops: [{ op: 'add', id: 'durable-tutor-line', spec: { kind: 'line', from: [100, 280], to: [900, 280], width: 5 } }],
    }, { visualCueId: 'durable-line-cue', semanticObjectId: 'durable-line', providerResponseId: 'drawing-response' });
  });

  const tutorLine = page.locator('[data-item="durable-tutor-line"]');
  await expect(tutorLine).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __nouraAnimationTrace: { first: { dashOffset: string; opacity: string } | null } }
  ).__nouraAnimationTrace.first)).not.toBeNull();
  const firstFrame = await page.evaluate(() => (
    window as typeof window & { __nouraAnimationTrace: { first: { dashOffset: string; opacity: string } } }
  ).__nouraAnimationTrace.first);
  expect(Number.parseFloat(firstFrame.dashOffset)).toBeGreaterThan(0);
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
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __nouraAnimationTrace: { removals: number } }
  ).__nouraAnimationTrace.removals)).toBe(0);
  // A stroke opens a draft; nothing is submitted and no response is
  // requested until the learner explicitly presses Done.
  expect(await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string }> } }).__nouraFakeSocket;
    return socket.sent.filter((event) => ['board_event', 'board_submission'].includes(event.type)).length;
  })).toBe(0);
  await expect(page.getByTestId('draft-done')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return socket.sent.some((event) => event.type === 'ops_shown' && event.payload?.event_id === 701);
  })).toBe(true);
});

test('multi-stroke drawing with long pauses submits exactly once, on Done', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `draft-life-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await page.getByRole('button', { name: 'Draw on the board' }).click();
  const board = page.locator('.board__svg');
  const box = await board.boundingBox();
  expect(box).not.toBeNull();
  const strokeAt = async (fx: number, fy: number) => {
    await page.mouse.move(box!.x + box!.width * fx, box!.y + box!.height * fy);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * (fx + 0.08), box!.y + box!.height * (fy + 0.1), { steps: 4 });
    await page.mouse.up();
  };

  // Three strokes separated by natural thinking pauses.
  await strokeAt(0.2, 0.3);
  await page.waitForTimeout(1_200);
  await strokeAt(0.4, 0.35);
  await page.waitForTimeout(2_000);
  await strokeAt(0.6, 0.4);
  await expect(page.locator('[data-item^="sketch-"]')).toHaveCount(3);

  // Undo removes the last stroke; the draft stays open and quiet.
  await page.getByRole('button', { name: 'Undo your last mark' }).click();
  await expect(page.locator('[data-item^="sketch-"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Redo your last undone mark' }).click();
  await expect(page.locator('[data-item^="sketch-"]')).toHaveCount(3);

  // Nothing has been captured, submitted, or asked of the model.
  expect(await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string }> } }).__nouraFakeSocket;
    return socket.sent.filter((event) => ['board_event', 'board_submission'].includes(event.type)).length;
  })).toBe(0);
  await expect(page.getByText('Thinking…')).toHaveCount(0);

  // Done: exactly one idempotent submission with vector analysis and image.
  await page.getByTestId('draft-done').click();
  await expect.poll(() => page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return socket.sent.filter((event) => event.type === 'board_submission').length;
  })).toBe(1);
  const submission = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return socket.sent.find((event) => event.type === 'board_submission')?.payload;
  });
  expect(Array.isArray(submission?.ops) ? submission.ops.length : 0).toBe(3);
  expect(String(submission?.imageDataUrl ?? '')).toMatch(/^data:image\/jpeg;base64,/);
  expect((submission?.analysis as { version?: string } | undefined)?.version).toBe('1.0.0');
  await expect(page.getByText('Sending your drawing…')).toBeVisible();

  // The server acknowledges; further Done presses are impossible because the
  // draft is closed, and no duplicate submission exists.
  await page.evaluate((submissionId) => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_submission_ack', { submissionId });
  }, String(submission?.submissionId));
  await expect(page.getByText('Thinking…')).toBeVisible();
  await expect(page.getByTestId('draft-done')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string }> } }).__nouraFakeSocket;
    return socket.sent.filter((event) => event.type === 'board_submission').length;
  })).toBe(1);
});

test('a delivered drawing task shows a persistent banner and yields to the learner', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `task-life-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('learner_task', {
      task: {
        taskId: 'circle-acute', prompt: 'Circle the acute angle.', responseMode: 'draw', submitPolicy: 'explicit',
        targetObjectIds: [], boardRevision: 0, allowVoiceWhileDrawing: true,
      },
    });
  });
  const banner = page.getByTestId('task-banner');
  await expect(banner).toContainText('Circle the acute angle.');
  await expect(banner).toContainText('draw on the board');
  await expect(banner).toContainText('Press Done when you finish.');
  // The banner persists while the learner thinks and draws.
  await page.waitForTimeout(1_000);
  await expect(banner).toBeVisible();
});

test('durable board replay renders once as committed state without animation', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `board-replay-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_replay', {
      batches: [{
        semanticObjectId: 'replay-section',
        groupLabel: 'Earlier work',
        ops: [{ op: 'add', id: 'replayed-line', spec: { kind: 'line', from: [140, 220], to: [860, 220], width: 5 } }],
      }],
    });
  });

  const replayedPath = page.locator('[data-item="replayed-line"] path');
  await expect(replayedPath).toHaveCount(1);
  await expect(replayedPath).toHaveCSS('stroke-dashoffset', '0px');
  await expect(page.locator('[data-item="replayed-line"]')).not.toHaveAttribute('data-animation-pending', 'true');
  await expect(page.locator('.board__svg')).toHaveAttribute('data-animation-request', '');
  await page.waitForTimeout(250);
  await expect(replayedPath).toHaveCount(1);
  await expect(replayedPath).toHaveCSS('stroke-dashoffset', '0px');
});

test('back-to-back drawing checkpoints stay ordered and never remount', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `board-queue-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await page.evaluate(() => {
    type Trace = Record<string, { firstDashOffset: string | null; removals: number; present: boolean }>;
    const trace: Trace = {
      'queued-line-one': { firstDashOffset: null, removals: 0, present: false },
      'queued-line-two': { firstDashOffset: null, removals: 0, present: false },
    };
    const sample = () => {
      for (const [id, item] of Object.entries(trace)) {
        const path = document.querySelector<SVGPathElement>(`[data-item="${id}"] path`);
        const present = Boolean(path);
        if (path && item.firstDashOffset === null) item.firstDashOffset = path.style.strokeDashoffset;
        if (item.present && !present) item.removals += 1;
        item.present = present;
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    (window as typeof window & { __nouraQueueTrace: Trace & { observer?: MutationObserver } }).__nouraQueueTrace = trace;
    (window as typeof window & { __nouraQueueObserver: MutationObserver }).__nouraQueueObserver = observer;

    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'queued-response' });
    socket.emit('board_ops', {
      response_id: 'queued-response', event_id: 901,
      ops: [{ op: 'add', id: 'queued-line-one', spec: { kind: 'line', from: [140, 210], to: [860, 210], width: 5 } }],
    }, { semanticObjectId: 'queued-section', providerResponseId: 'queued-response' });
    socket.emit('board_ops', {
      response_id: 'queued-response', event_id: 902,
      ops: [{ op: 'add', id: 'queued-line-two', spec: { kind: 'line', from: [140, 360], to: [860, 360], width: 5 } }],
    }, { semanticObjectId: 'queued-section', providerResponseId: 'queued-response' });
  });

  for (const id of ['queued-line-one', 'queued-line-two']) {
    const path = page.locator(`[data-item="${id}"] path`);
    await expect(path).toHaveCount(1);
    await expect.poll(() => page.evaluate((itemId) => (
      window as typeof window & { __nouraQueueTrace: Record<string, { firstDashOffset: string | null }> }
    ).__nouraQueueTrace[itemId].firstDashOffset, id)).not.toBeNull();
    const firstOffset = await page.evaluate((itemId) => (
      window as typeof window & { __nouraQueueTrace: Record<string, { firstDashOffset: string }> }
    ).__nouraQueueTrace[itemId].firstDashOffset, id);
    expect(Number.parseFloat(firstOffset)).toBeGreaterThan(0);
    await expect(path).toHaveCSS('stroke-dashoffset', '0px');
  }

  await expect(page.locator('.board__svg')).toHaveAttribute('data-animation-request', '');
  const removals = await page.evaluate(() => Object.values((
    window as typeof window & { __nouraQueueTrace: Record<string, { removals: number }> }
  ).__nouraQueueTrace).map((item) => item.removals));
  expect(removals).toEqual([0, 0]);
});

test('speech stop immediately exposes a thinking state before reply audio', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `turn-life-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('speech_started', {});
    socket.emit('speech_stopped', {});
  });
  await expect(page.getByText('Thinking…')).toBeVisible();

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'spoken-reply' });
    // Speaking begins when the provider reports real playback on the call.
    const voice = (window as typeof window & { __nouraFakeVoice: { emitBoundary(boundary: string, responseId: string | null, playedMs?: number): void } }).__nouraFakeVoice;
    voice.emitBoundary('started', 'spoken-reply');
  });
  await expect(page.getByText('Speaking')).toBeVisible();
});

test('raw explanatory text is moved away from triangle strokes instead of accepting overlap', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `layout-life-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

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
    }, { providerResponseId: 'overlap-response' });
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

test('a new tutor section never hides the current board: it is announced and reachable, not auto-selected', async ({ page, request }) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `sections-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'section-response' });
    socket.emit('board_ops', {
      response_id: 'section-response', groupLabel: 'First idea',
      ops: [{ op: 'add', id: 'group-one-box', spec: { kind: 'box', at: [500, 300], text: 'First idea' } }],
    }, { semanticObjectId: 'group-one', providerResponseId: 'section-response' });
    socket.emit('board_ops', {
      response_id: 'section-response', groupLabel: 'Second idea',
      ops: [{ op: 'add', id: 'group-two-box', spec: { kind: 'box', at: [500, 300], text: 'Second idea' } }],
    }, { semanticObjectId: 'group-two', providerResponseId: 'section-response' });
  });

  // The first anchor region takes the camera; the second one must NOT steal
  // it. Both drawings remain in the scene — a section is a spatial region
  // now, not a visibility filter (v3.1-era announced-section E2E, adapted).
  const picker = page.getByLabel('Board section', { exact: true });
  await expect(page.locator('[data-item="group-one-box"]')).toBeVisible();
  await expect(picker).toHaveValue('group-one');
  await expect(page.locator('[data-item="group-two-box"]')).toHaveCount(1);
  await expect(page.locator('[data-camera-region]')).toHaveAttribute('data-camera-region', 'group-one');

  // The new region is announced and reachable, with an explicit control.
  const notice = page.getByTestId('section-notice');
  await expect(notice).toContainText('Second idea');
  await expect(page.locator('[data-item="group-one-box"]')).toBeVisible();
  await notice.getByRole('button', { name: 'Open it' }).click();
  await expect(picker).toHaveValue('group-two');
  await expect(page.locator('[data-item="group-two-box"]')).toBeVisible();
  await expect(page.locator('[data-item="group-one-box"]')).toHaveCount(1);

  // The first region remains reachable and intact — nothing disappeared.
  await picker.selectOption('group-one');
  await expect(page.locator('[data-item="group-one-box"]')).toBeVisible();
  await expect(page.locator('[data-item="group-two-box"]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Draw on the board' }).click();
  const board = page.locator('.board__svg');
  const box = await board.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.25, box!.y + box!.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.35, box!.y + box!.height * 0.4, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('[data-item^="sketch-"]')).toHaveCount(1);

  // While the learner draws, another tutor section still cannot move them.
  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_ops', {
      response_id: 'section-response', groupLabel: 'Third idea',
      ops: [{ op: 'add', id: 'group-three-box', spec: { kind: 'box', at: [500, 300], text: 'Third idea' } }],
    }, { semanticObjectId: 'group-three', providerResponseId: 'section-response' });
  });
  await expect(picker).toHaveValue('group-one');
  await expect(page.locator('[data-item^="sketch-"]')).toHaveCount(1);
  await expect(picker).toBeDisabled();

  // Camera stays locked until the learner finishes the draft. After Done,
  // marks inherit the region they were drawn in; panning away does not
  // erase them — they remain in the scene for the pan back.
  await page.getByTestId('draft-done').click();
  const submissionId = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return String(socket.sent.find((event) => event.type === 'board_submission')?.payload?.submissionId ?? '');
  });
  await page.evaluate((id) => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_submission_ack', { submissionId: id });
  }, submissionId);
  await expect(page.getByTestId('draft-done')).toHaveCount(0);
  await expect(picker).toBeEnabled();

  await picker.selectOption('group-two');
  await expect(page.locator('[data-item^="sketch-"]')).toHaveCount(1);
  await picker.selectOption('group-one');
  await expect(page.locator('[data-item^="sketch-"]')).toHaveCount(1);
});

test('image grounding tap fallback persists a normalized selector and renders its annotation', async ({ page, request }, testInfo) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `image-ground-${Date.now().toString(36)}`);
  await page.route('**/api/board-assets/img-a1b2c3d4', async (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="400"><rect width="700" height="400" fill="#eef4ff"/><rect x="70" y="80" width="560" height="240" rx="24" fill="#fff" stroke="#2c5be0" stroke-width="6"/><circle cx="385" cy="180" r="46" fill="#f0a227"/><path d="M300 180h170" stroke="#26231f" stroke-width="18"/><text x="350" y="290" text-anchor="middle" font-size="34">Synthetic axle diagram</text></svg>',
  }));
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);
  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_replay', { batches: [{
      semanticObjectId: 'image-board', groupLabel: 'Synthetic machine',
      ops: [{ op: 'add', id: 'worksheet-image', spec: { kind: 'image', assetId: 'img-a1b2c3d4', at: [150, 100], w: 700, h: 400, alt: 'Synthetic axle worksheet' } }],
    }] });
    socket.emit('image_region_tap_request', {
      request_id: 'tap-image-1', image_id: 'worksheet-image', hint: 'Tap the axle in the middle',
    });
  });
  await expect(page.getByTestId('image-grounding-tap')).toContainText('Tap the axle in the middle');
  const clientPoint = await page.locator('.board__svg').evaluate((svg: SVGSVGElement) => {
    const point = svg.createSVGPoint();
    point.x = 535;
    point.y = 280;
    const mapped = point.matrixTransform(svg.getScreenCTM()!);
    return { x: mapped.x, y: mapped.y };
  });
  await page.mouse.click(clientPoint.x, clientPoint.y);
  await expect.poll(() => page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return socket.sent.find((event) => event.type === 'image_region_tap')?.payload?.selector ?? null;
  })).not.toBeNull();
  const submitted = await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return socket.sent.find((event) => event.type === 'image_region_tap')?.payload?.selector as { type: string; x: number; y: number };
  });
  expect(submitted).toMatchObject({ type: 'PointSelector' });
  expect(submitted.x).toBeCloseTo(0.55, 2);
  expect(submitted.y).toBeCloseTo(0.45, 2);
  await page.evaluate((pointSelector) => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_ops', {
      response_id: 'grounded-response', event_id: 1801, groupLabel: 'Synthetic machine',
      ops: [{ op: 'add', id: 'grounded-axle', color: '#E14B3C', spec: { kind: 'annotate', style: 'circle', target: { type: 'image_region', imageId: 'worksheet-image', selector: pointSelector } } }],
    }, { visualCueId: 'grounded-image-cue', semanticObjectId: 'image-board', providerResponseId: 'grounded-response' });
  }, submitted);
  await expect(page.locator('[data-item="grounded-axle"] path')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return socket.sent.some((event) => event.type === 'ops_shown' && event.payload?.event_id === 1801);
  })).toBe(true);
  await expect(page.getByTestId('image-grounding-tap')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('m7-image-tap-fallback.png') });
});

test('fast annotations resolve semantic sub-anchors and learner strokes without vision', async ({ page, request }, testInfo) => {
  const { session, lessonCapability } = await createSyntheticSession(request, `anchor-ref-${Date.now().toString(36)}`);
  await installFakeRealtime(page);
  await setLessonCapability(page, session.id, lessonCapability);
  await page.goto(`/lesson/${session.id}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  await waitForFakeRealtimeStart(page);

  await page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('board_replay', { batches: [{
      semanticObjectId: 'annotation-board', groupLabel: 'Anchor references',
      ops: [{ op: 'add', id: 'anchor-triangle', spec: { kind: 'polygon', points: [[220, 420], [500, 120], [780, 420]] } }],
    }] });
    socket.emit('learner_board_replay', { batches: [{
      semanticObjectId: 'annotation-board',
      ops: [{ op: 'add', id: 'sketch-anchor-stroke', spec: { kind: 'path', points: [[280, 330], [340, 370], [400, 335]], width: 5 } }],
    }] });
  });
  await expect(page.locator('[data-item="anchor-triangle"]')).toHaveCount(1);
  await expect(page.locator('[data-item="sketch-anchor-stroke"]')).toHaveCount(1);

  await page.evaluate(() => {
    (window as typeof window & { __m7AnnotationStartedAt?: number }).__m7AnnotationStartedAt = performance.now();
    const socket = (window as typeof window & { __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void } }).__nouraFakeSocket;
    socket.emit('response_started', { response_id: 'annotation-response' });
    socket.emit('board_ops', {
      response_id: 'annotation-response', event_id: 1701, groupLabel: 'Anchor references',
      ops: [
        { op: 'add', id: 'apex-annotation', color: 'red', spec: { kind: 'annotate', style: 'circle', target: { type: 'semantic', objectId: 'anchor-triangle', anchor: 'vertex:1' } } },
        { op: 'add', id: 'stroke-annotation', color: 'green', spec: { kind: 'annotate', style: 'tick', target: { type: 'learner_stroke', strokeId: 'sketch-anchor-stroke', anchor: 'end' } } },
      ],
    }, { visualCueId: 'annotation-cue', semanticObjectId: 'annotation-board', providerResponseId: 'annotation-response' });
  });

  await expect(page.locator('[data-item="apex-annotation"] path')).toHaveCount(1);
  await expect(page.locator('[data-item="stroke-annotation"] path')).toHaveCount(1);
  await expect(page.locator('[data-item="anchor-triangle"]')).toHaveCount(1);
  await expect(page.locator('[data-item="sketch-anchor-stroke"]')).toHaveCount(1);
  const annotationFirstPaint = () => page.evaluate(() => {
    const host = window as typeof window & {
      __m7AnnotationStartedAt?: number;
      __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown>; sentAtMs: number }> };
    };
    const presented = host.__nouraFakeSocket.sent.find((event) => event.type === 'ops_presented' && event.payload?.event_id === 1701);
    return presented ? presented.sentAtMs - Number(host.__m7AnnotationStartedAt) : null;
  });
  await expect.poll(annotationFirstPaint).not.toBeNull();
  expect(Number(await annotationFirstPaint())).toBeLessThan(1_000);
  await expect.poll(() => page.evaluate(() => {
    const socket = (window as typeof window & { __nouraFakeSocket: { sent: Array<{ type: string; payload?: Record<string, unknown> }> } }).__nouraFakeSocket;
    return socket.sent.some((event) => event.type === 'ops_shown' && event.payload?.event_id === 1701);
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('m7-fast-annotations.png') });
});
