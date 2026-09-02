import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { chromium, request as createRequestContext, type BrowserContext, type Page } from 'playwright';
import type { BoardOp } from '../shared/boardOps.js';
import {
  buildFirstPaintReplayRows,
  compileFirstPaintReplayEvidence,
  summarizeFirstPaintReplay,
  type FirstPaintObservation,
  type FirstPaintReplayRow,
} from '../server/board/eval/firstPaintReplay.js';
import {
  createSyntheticSession,
  setLessonCapability,
  waitForFakeRealtimeStart,
} from '../tests/helpers.js';

const M0_PATH = 'server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json';
const M1_PATH = 'server/board/eval/results/2026-09-01-drawing-m1-pipeline-study.json';
const DEFAULT_OUTPUT = 'server/board/eval/results/2026-09-01-drawing-g4-first-paint.json';
const DEFAULT_SCREENSHOT_DIR = 'artifacts/evaluation/drawing-g4-first-paint';
const G4_FAKE_RUNTIME = `(() => {
  class FakeRealtimeSocket {
    static OPEN = 1;
    OPEN = 1;
    readyState = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    identity = null;
    sequence = 0;
    sent = [];
    constructor() {
      window.__nouraFakeSocket = this;
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event('open')); });
    }
    send(raw) {
      const event = JSON.parse(raw);
      this.sent.push({ ...event, sentAtMs: performance.now() });
      const changed = !this.identity || event.connectionEpoch !== this.identity.connectionEpoch || event.turnId !== this.identity.turnId || event.generationId !== this.identity.generationId;
      this.identity = { sessionId: event.sessionId, connectionEpoch: event.connectionEpoch, turnId: event.turnId, generationId: event.generationId };
      if (changed) this.sequence = 0;
      if (event.type === 'hello') queueMicrotask(() => this.emit('ready', {}));
    }
    emit(type, payload, optional = {}) {
      if (!this.identity) throw new Error('fake socket has no runtime identity');
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
        eventId: crypto.randomUUID(), schemaVersion: '1.0.0', ...this.identity,
        sequence: this.sequence++, type, payload, ...optional,
      }) }));
    }
    close() { this.readyState = 3; this.onclose?.(new CloseEvent('close')); }
  }
  Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeRealtimeSocket });
  class FakeVoice {
    state = 'new';
    active = null;
    played = 0;
    constructor(handlers) { this.handlers = handlers; }
    connect() { this.state = 'connected'; this.handlers.onMicrophoneState?.(true, false); this.handlers.onStateChange('connected'); return Promise.resolve(); }
    noteResponse() {}
    suppressResponse() {}
    resumePlayback() { return Promise.resolve(true); }
    setMicMuted() {}
    playingResponseId() { return this.active; }
    playedMs() { return this.active ? this.played : 0; }
    stopPlayback() { const heard = this.playedMs(); this.active = null; this.played = 0; return heard; }
    readMicEnergy() { return 0; }
    readVoiceEnergy() { return this.active ? 0.4 : 0; }
    close() { this.state = 'closed'; this.handlers.onStateChange('closed'); }
    emitBoundary(boundary, responseId, playedMs = 0) {
      this.active = boundary === 'started' ? responseId : null;
      this.played = boundary === 'started' ? 0 : playedMs;
      this.handlers.onPlaybackBoundary(boundary, responseId, playedMs);
    }
  }
  window.__nouraVoiceTransport = ({ handlers }) => {
    const voice = new FakeVoice(handlers);
    window.__nouraFakeVoice = voice;
    return voice;
  };
})();`;
let regenerate = false;
let baseUrl = 'http://localhost:5180';
let outputPath = resolve(DEFAULT_OUTPUT);
let screenshotDir = resolve(DEFAULT_SCREENSHOT_DIR);
let workers = 6;
let limit = Number.POSITIVE_INFINITY;
let sample: number | null = null;
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === '--regenerate') regenerate = true;
  else if (argument === '--base-url') baseUrl = requiredValue(argv, ++index, argument);
  else if (argument === '--output') outputPath = resolve(requiredValue(argv, ++index, argument));
  else if (argument === '--screenshot-dir') screenshotDir = resolve(requiredValue(argv, ++index, argument));
  else if (argument === '--workers') workers = Number(requiredValue(argv, ++index, argument));
  else if (argument === '--limit') limit = Number(requiredValue(argv, ++index, argument));
  else if (argument === '--sample') sample = Number(requiredValue(argv, ++index, argument));
  else if (argument === '--help') {
    console.log('Usage: npm run test:first-paint [-- --regenerate --base-url http://localhost:5180 --workers 6]');
    process.exit(0);
  } else throw new Error(`Unknown G4 option: ${argument}`);
}
if (!regenerate) {
  const source = readFileSync(resolve(M0_PATH), 'utf8');
  const m1 = readFileSync(resolve(M1_PATH), 'utf8');
  const replayRows = buildFirstPaintReplayRows(source, m1);
  const evidence = compileFirstPaintReplayEvidence(readFileSync(outputPath, 'utf8'));
  if (evidence.pairedRows !== replayRows.length) throw new Error('G4 evidence row count no longer matches immutable inputs.');
  console.log(JSON.stringify({
    ok: evidence.summary.accepted,
    evidenceMode: 'offline_actual_lesson_ops_presented_replay_verification',
    providerCalls: 0,
    runtimeCostUsd: 0,
    ...evidence,
  }, null, 2));
  process.exit(evidence.summary.accepted ? 0 : 1);
}
const target = new URL(baseUrl);
if (target.protocol !== 'http:' || !isLoopback(target.hostname) || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('G4 accepts only a loopback HTTP origin.');
}
if (!Number.isInteger(workers) || workers < 1 || workers > 12) throw new Error('G4 workers must be an integer from 1 to 12.');
if ((!Number.isInteger(limit) && limit !== Number.POSITIVE_INFINITY) || limit < 1) throw new Error('G4 limit must be a positive integer.');
if (sample !== null && (!Number.isInteger(sample) || sample < 1 || limit !== Number.POSITIVE_INFINITY)) throw new Error('G4 sample must be a positive integer and cannot be combined with limit.');
if (existsSync(outputPath)) throw new Error(`Refusing to overwrite G4 evidence at ${outputPath}.`);

const sourceRawJson = readFileSync(resolve(M0_PATH), 'utf8');
const m1RawJson = readFileSync(resolve(M1_PATH), 'utf8');
const allRows = buildFirstPaintReplayRows(sourceRawJson, m1RawJson);
const rows = sample === null || sample >= allRows.length
  ? allRows.slice(0, limit)
  : Array.from({ length: sample }, (_, index) => allRows[Math.floor(index * allRows.length / sample)]);
const api = await createRequestContext.newContext({ baseURL: target.origin });
const { session, lessonCapability } = await createSyntheticSession(api, `g4-${Date.now().toString(36)}`);
const sessionInfoResponse = await api.get(`/api/sessions/${session.id}`, { headers: { Origin: target.origin } });
if (!sessionInfoResponse.ok()) throw new Error(`G4 session fixture read failed: ${sessionInfoResponse.status()}.`);
const sessionInfo = await sessionInfoResponse.json();
await api.dispose();
if (!lessonCapability) throw new Error('G4 synthetic session did not receive a lesson capability.');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: target.origin, serviceWorkers: 'block' });
let externalRequestCount = 0;
await context.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== target.origin) {
    externalRequestCount += 1;
    await route.abort('blockedbyclient');
    return;
  }
  if (request.method() === 'GET' && url.pathname === '/api/auth/session') {
    await route.fulfill({ json: { required: false, authenticated: true } });
    return;
  }
  if (request.method() === 'GET' && url.pathname === `/api/sessions/${session.id}`) {
    await route.fulfill({ json: sessionInfo });
    return;
  }
  await route.continue();
});
const jobs = rows.flatMap((row) => [
  { row, lane: 'streaming' as const },
  { row, lane: 'classic' as const },
]);
const observations: FirstPaintObservation[] = [];
const finalOrigins = new Set<string>();
let cursor = 0;
try {
  await Promise.all(Array.from({ length: workers }, async (_, workerIndex) => {
    const page = await createHarnessPage(context, session.id, lessonCapability);
    try {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const job = jobs[index];
        if (!job) return;
        try {
          const eventId = workerIndex * 10_000 + index + 1;
          observations.push(await measureFirstPaint(page, session.id, job.row, job.lane, eventId));
          finalOrigins.add(new URL(page.url()).origin);
        } catch (error) {
          throw new Error(`G4 ${job.lane} replay failed for ${job.row.sourceKey}: ${String(error)}`, { cause: error });
        }
      }
    } finally {
      await page.close();
    }
  }));
  observations.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey) || left.lane.localeCompare(right.lane));
  const summary = summarizeFirstPaintReplay(observations);
  const medianRow = [...rows].sort((left, right) => left.firstValidOpMs - right.firstValidOpMs)[Math.floor((rows.length - 1) / 2)];
  mkdirSync(screenshotDir, { recursive: true });
  const streamingScreenshot = resolve(screenshotDir, 'streaming-first-paint.png');
  const classicScreenshot = resolve(screenshotDir, 'classic-first-paint.png');
  await captureFirstPaint(context, session.id, lessonCapability, medianRow, 'streaming', 900_001, streamingScreenshot);
  await captureFirstPaint(context, session.id, lessonCapability, medianRow, 'classic', 900_002, classicScreenshot);
  const artifact = {
    schemaVersion: '1.0.0',
    evidenceMode: 'offline_actual_lesson_ops_presented_replay',
    evidenceBoundary: 'Hash-bound M0 provider delays backdate intent acceptance; every candidate traverses the real LessonPage, fake voice transport, runtime cue timeline, BoardSceneCoordinator, React paint, and outgoing ops_presented acknowledgement. No provider or external network request is made.',
    providerCalls: 0,
    runtimeCostUsd: 0,
    realChildData: false,
    ...(sample !== null ? { selection: { strategy: 'deterministic_stratified_index', sampleRows: rows.length, totalRows: allRows.length } } : {}),
    source: {
      m0Path: M0_PATH,
      m0Sha256: sha256(sourceRawJson),
      m1Path: M1_PATH,
      m1Sha256: sha256(m1RawJson),
      pairedValidDiagramRows: rows.length,
    },
    browserHarness: {
      origin: target.origin,
      finalOrigins: [...finalOrigins],
      engine: 'chromium',
      externalRequestCount,
      fakeVoiceTransport: true,
      actualLessonPage: true,
    },
    screenshots: {
      sourceKey: medianRow.sourceKey,
      streaming: { path: relativePath(streamingScreenshot), sha256: fileSha256(streamingScreenshot) },
      classic: { path: relativePath(classicScreenshot), sha256: fileSha256(classicScreenshot) },
    },
    summary,
    observations,
  };
  const raw = `${JSON.stringify(artifact, null, 2)}\n`;
  writeText(outputPath, raw);
  console.log(JSON.stringify({
    ok: summary.accepted && externalRequestCount === 0,
    providerCalls: 0,
    runtimeCostUsd: 0,
    outputPath,
    resultSha256: sha256(raw),
    summary,
    screenshots: artifact.screenshots,
    externalRequestCount,
  }, null, 2));
  if (!summary.accepted || externalRequestCount !== 0) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}

async function createHarnessPage(
  context: BrowserContext,
  sessionId: string,
  lessonCapability: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript({ content: G4_FAKE_RUNTIME });
  await setLessonCapability(page, sessionId, lessonCapability);
  return page;
}

async function captureFirstPaint(
  context: BrowserContext,
  sessionId: string,
  lessonCapability: string,
  row: FirstPaintReplayRow,
  lane: 'streaming' | 'classic',
  eventId: number,
  screenshotPath: string,
): Promise<void> {
  const page = await createHarnessPage(context, sessionId, lessonCapability);
  try {
    await measureFirstPaint(page, sessionId, row, lane, eventId, screenshotPath);
  } finally {
    await page.close();
  }
}

async function measureFirstPaint(
  page: Page,
  sessionId: string,
  row: FirstPaintReplayRow,
  lane: 'streaming' | 'classic',
  eventId: number,
  screenshotPath?: string,
): Promise<FirstPaintObservation> {
  await page.goto(`/lesson/${sessionId}`, { waitUntil: 'load' });
  try {
    await page.getByRole('button', { name: 'Begin' }).click({ timeout: 15_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({ url: location.href, bodyText: document.body.innerText.slice(0, 800), storageKeys: Object.keys(sessionStorage) }));
    throw new Error(`lesson Begin unavailable: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  try {
    await waitForFakeRealtimeStart(page);
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const host = window as typeof window & {
        __nouraFakeSocket?: { readyState: number; sent: Array<{ type: string }> };
        __nouraVoiceTransport?: unknown;
        __nouraFakeVoice?: { state: string };
      };
      return {
        url: location.href,
        socket: host.__nouraFakeSocket ? {
          readyState: host.__nouraFakeSocket.readyState,
          sent: host.__nouraFakeSocket.sent.map((event) => event.type),
        } : null,
        voiceFactory: typeof host.__nouraVoiceTransport,
        voiceState: host.__nouraFakeVoice?.state ?? null,
        storageKeys: Object.keys(sessionStorage),
        bodyText: document.body.innerText.slice(0, 500),
      };
    });
    throw new Error(`fake realtime start failed: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  if (row.existingOps.length > 0) {
    await page.evaluate((input) => {
      const socket = (window as typeof window & {
        __nouraFakeSocket: { emit(type: string, payload: Record<string, unknown>): void };
      }).__nouraFakeSocket;
      socket.emit('board_replay', {
        batches: [{
          ops: input.ops,
          semanticObjectId: input.semanticGroupId,
          groupLabel: 'Existing board context',
        }],
      });
    }, { ops: row.existingOps, semanticGroupId: row.semanticGroupId });
    await waitForItems(page, row.existingOps);
  }
  const providerDelayMs = lane === 'streaming' ? row.firstValidOpMs : row.completeSceneMs;
  const ops = lane === 'streaming' ? row.streamingOps : row.classicOps;
  const preflightId = `g4-preflight-${eventId}`;
  await page.evaluate((input) => {
    const host = window as typeof window & {
      __g4IntentStartedAt?: number;
      __nouraFakeSocket: {
        emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void;
      };
    };
    host.__g4IntentStartedAt = performance.now() - input.providerDelayMs;
    host.__nouraFakeSocket.emit('visual_preflight', {
      preflight_id: input.preflightId,
      ops: input.ops,
      semanticObjectId: input.semanticGroupId,
      groupLabel: input.groupLabel,
    });
  }, {
    providerDelayMs,
    preflightId,
    ops,
    groupLabel: row.groupLabel,
    semanticGroupId: row.semanticGroupId,
  });
  await page.waitForFunction((id) => {
    const socket = (window as typeof window & {
      __nouraFakeSocket?: { sent: Array<{ type: string; payload?: { preflight_id?: string } }> };
    }).__nouraFakeSocket;
    return socket?.sent.some((event) =>
      event.type === 'visual_preflight_result' && event.payload?.preflight_id === id) === true;
  }, preflightId, { timeout: 15_000 });
  const preflightAccepted = await page.evaluate((id) => {
    const socket = (window as typeof window & {
      __nouraFakeSocket: {
        sent: Array<{ type: string; payload?: { preflight_id?: string; accepted?: boolean; reasons?: string[] } }>;
      };
    }).__nouraFakeSocket;
    return socket.sent.find((event) =>
      event.type === 'visual_preflight_result' && event.payload?.preflight_id === id)?.payload;
  }, preflightId);
  if (preflightAccepted?.accepted !== true) {
    const boardHarness = await boardHarnessPreflight(page.context(), target.origin, ops, row.semanticGroupId);
    throw new Error(`Lesson preflight rejected ${lane}: ${(preflightAccepted?.reasons ?? []).join('; ')}; dev board=${JSON.stringify(boardHarness)}`);
  }
  await page.evaluate((input) => {
    const socket = (window as typeof window & {
      __nouraFakeSocket: {
        emit(type: string, payload: Record<string, unknown>, optional?: Record<string, unknown>): void;
      };
    }).__nouraFakeSocket;
    socket.emit('board_ops', {
      response_id: `g4-${input.lane}`,
      event_id: input.eventId,
      ops: input.ops,
      groupLabel: input.groupLabel,
      checkpoint: 'outline',
    }, {
      visualCueId: `g4-${input.eventId}`,
      semanticObjectId: input.semanticGroupId,
      providerResponseId: `g4-${input.lane}`,
    });
  }, {
    lane,
    eventId,
    ops,
    groupLabel: row.groupLabel,
    semanticGroupId: row.semanticGroupId,
  });
  try {
    await page.waitForFunction((id) => {
      const socket = (window as typeof window & {
        __nouraFakeSocket?: { sent: Array<{ type: string; payload?: { event_id?: number } }> };
      }).__nouraFakeSocket;
      return socket?.sent.some((event) => event.type === 'ops_presented' && event.payload?.event_id === id) === true;
    }, eventId, { timeout: 15_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => {
      const socket = (window as typeof window & {
        __nouraFakeSocket?: { sent: Array<{ type: string; payload?: Record<string, unknown> }> };
      }).__nouraFakeSocket;
      return {
        sent: socket?.sent.map((event) => ({ type: event.type, payload: event.payload })) ?? [],
        items: document.querySelectorAll('[data-item]').length,
        bodyText: document.body.innerText.slice(0, 500),
      };
    });
    throw new Error(`ops_presented missing: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  const measured = await page.evaluate((id) => {
    const host = window as typeof window & {
      __g4IntentStartedAt?: number;
      __nouraFakeSocket: {
        sent: Array<{ type: string; payload?: { event_id?: number }; sentAtMs?: number }>;
      };
    };
    const presented = host.__nouraFakeSocket.sent.find((event) =>
      event.type === 'ops_presented' && event.payload?.event_id === id);
    if (host.__g4IntentStartedAt === undefined || presented?.sentAtMs === undefined) {
      throw new Error('G4 did not capture the ops_presented timestamp.');
    }
    return presented.sentAtMs - host.__g4IntentStartedAt;
  }, eventId);
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  const firstPaintMs = Math.max(0, Math.round(measured));
  return {
    sourceKey: row.sourceKey,
    lane,
    providerDelayMs,
    uiCommitMs: Math.max(0, firstPaintMs - providerDelayMs),
    firstPaintMs,
  };
}

async function boardHarnessPreflight(
  context: BrowserContext,
  origin: string,
  ops: BoardOp[],
  semanticGroupId: string,
) {
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/dev/board`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof (window as typeof window & { nouraPreflightScene?: unknown }).nouraPreflightScene === 'function');
    return await page.evaluate(async (input) => {
      const hook = (window as typeof window & {
        nouraPreflightScene?: (candidate: BoardOp[], groupId?: string) => Promise<unknown>;
      }).nouraPreflightScene;
      return {
        unscoped: await hook?.(input.ops),
        scoped: await hook?.(input.ops, input.semanticGroupId),
      };
    }, { ops, semanticGroupId });
  } finally {
    await page.close();
  }
}

async function waitForItems(page: Page, ops: BoardOp[]): Promise<void> {
  const ids = ops.flatMap((op) => op.op === 'add' ? [op.id] : []);
  if (ids.length === 0) return;
  await page.waitForFunction((itemIds) => itemIds.every((id) =>
    document.querySelector(`[data-item="${CSS.escape(id)}"]`)), ids, { timeout: 10_000 });
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}
function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function relativePath(path: string): string {
  return path.startsWith(`${process.cwd()}/`) ? path.slice(process.cwd().length + 1) : path;
}
function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, value, { flag: 'wx' });
  const descriptor = openSync(temporaryPath, 'r');
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporaryPath, path);
}
