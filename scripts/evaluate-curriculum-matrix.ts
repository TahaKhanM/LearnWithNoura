import { chromium, type Page } from 'playwright';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  compileCurriculumMatrixEvidence,
  loadCurriculumFixtures,
  loadCurriculumMatrix,
} from '../server/board/eval/curriculumMatrix.js';
import { applyDirectorBoardPolicy } from '../server/board/directorSchema.js';
import type { BoardOp } from '../shared/boardOps.js';
import type { LayoutIssue } from '../shared/layoutFeedback.js';

const OUTPUT = 'server/board/eval/results/2026-09-02-curriculum-matrix-validation.json';
const SCREENSHOTS = 'artifacts/evaluation/curriculum-matrix';
const read = (path: string) => readFileSync(resolve(path), 'utf8');
const args = process.argv.slice(2);
if (!args.includes('--regenerate')) {
  const evidence = compileCurriculumMatrixEvidence({
    matrixRawJson: read('server/board/eval/curriculum-matrix.json'),
    fixturesRawJson: read('server/board/eval/fixtures/curriculum-matrix-scenes.json'),
    resultRawJson: read(OUTPUT),
  });
  console.log(JSON.stringify({
    ok: evidence.result.accepted,
    artifactVerified: true,
    providerCalls: 0,
    resultSha256: evidence.resultSha256,
    summary: evidence.result.summary,
    m7MissingCapabilities: evidence.result.m7MissingCapabilities,
  }, null, 2));
  process.exit(0);
}
const harnessArg = args.indexOf('--harness-url');
if (harnessArg < 0 || !args[harnessArg + 1]) throw new Error('Pass --harness-url with the local board harness origin.');
const target = new URL('/dev/board', args[harnessArg + 1]);
if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('Curriculum validation permits only a loopback board harness.');

const matrix = loadCurriculumMatrix();
const fixtures = loadCurriculumFixtures();
const externalRequests: string[] = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
await page.route('**/*', async (route) => {
  const requestUrl = new URL(route.request().url());
  if (requestUrl.origin === target.origin && requestUrl.pathname === '/api/auth/session') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ required: false, authenticated: true }),
    });
    return;
  }
  if (requestUrl.origin !== target.origin) {
    externalRequests.push(requestUrl.href);
    await route.abort();
    return;
  }
  await route.continue();
});
try {
  await page.goto(target.href, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const host = globalThis as typeof globalThis & { nouraPreflightScene?: unknown; nouraRenderScene?: unknown };
    return typeof host.nouraPreflightScene === 'function' && typeof host.nouraRenderScene === 'function';
  }, undefined, { timeout: 30_000 });
  const final = new URL(page.url());
  if (final.origin !== target.origin || final.pathname !== '/dev/board') throw new Error('Browser left the exact local board harness.');

  mkdirSync(resolve(SCREENSHOTS), { recursive: true });
  const rows = [];
  for (const fixture of fixtures) {
    const policy = applyDirectorBoardPolicy(fixture.ops, { density: 'standard', visibleObjectIds: [] });
    const verdict = policy.ok ? await preflight(page, policy.ops) : { accepted: false, reasons: policy.reasons, layoutIssues: [] };
    const raster = verdict.accepted ? await render(page, policy.ops) : null;
    const rasterBuffer = raster ? Buffer.from(raster.split(',')[1] ?? '', 'base64') : null;
    const rasterSha256 = rasterBuffer ? createHash('sha256').update(rasterBuffer).digest('hex') : null;
    const screenshotPath = rasterBuffer ? `${SCREENSHOTS}/${fixture.id}.jpg` : null;
    if (rasterBuffer && screenshotPath) writeFileSync(resolve(screenshotPath), rasterBuffer);
    rows.push({
      rowId: fixture.rowId,
      fixtureId: fixture.id,
      policyAccepted: policy.ok,
      browserAccepted: verdict.accepted,
      reasons: verdict.reasons,
      layoutIssues: verdict.layoutIssues,
      rasterSha256,
      screenshotPath,
    });
  }
  const accepted = externalRequests.length === 0 && rows.every((row) => row.policyAccepted && row.browserAccepted && row.rasterSha256);
  const matrixRaw = readFileSync(resolve('server/board/eval/curriculum-matrix.json'));
  const fixturesRaw = readFileSync(resolve('server/board/eval/fixtures/curriculum-matrix-scenes.json'));
  const generatedAt = existsSync(resolve(OUTPUT))
    ? (JSON.parse(read(OUTPUT)) as { generatedAt: string }).generatedAt
    : new Date().toISOString();
  const report = {
    schemaVersion: '1.0.0',
    evidenceMode: 'offline_loopback_browser_fixture_validation',
    generatedAt,
    accepted,
    providerCalls: 0,
    externalRequestCount: externalRequests.length,
    matrixSha256: createHash('sha256').update(matrixRaw).digest('hex'),
    fixturesSha256: createHash('sha256').update(fixturesRaw).digest('hex'),
    summary: {
      totalRows: matrix.rows.length,
      supportedRows: matrix.rows.filter((row) => row.status === 'supported').length,
      composableRows: matrix.rows.filter((row) => row.status === 'composable').length,
      missingRows: matrix.rows.filter((row) => row.status === 'missing').length,
      fixtureRows: rows.length,
      fixturesAccepted: rows.filter((row) => row.policyAccepted && row.browserAccepted && row.rasterSha256).length,
    },
    m7MissingCapabilities: matrix.m7MissingCapabilities,
    rows,
  };
  const reportRaw = `${JSON.stringify(report, null, 2)}\n`;
  if (existsSync(resolve(OUTPUT))) {
    if (read(OUTPUT) !== reportRaw) throw new Error('Browser replay diverged from immutable curriculum evidence.');
  } else {
    writeText(resolve(OUTPUT), reportRaw);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!accepted) process.exitCode = 1;
} finally {
  await browser.close();
}

async function preflight(page: Page, ops: BoardOp[]) {
  return page.evaluate(async (candidateOps) => {
    const hook = (globalThis as typeof globalThis & {
      nouraPreflightScene?: (ops: BoardOp[]) => Promise<{ accepted: boolean; reasons: string[]; layoutIssues: LayoutIssue[] }>;
    }).nouraPreflightScene;
    if (!hook) throw new Error('Board preflight hook is unavailable.');
    return hook(candidateOps);
  }, ops);
}

async function render(page: Page, ops: BoardOp[]) {
  return page.evaluate(async (candidateOps) => {
    const hook = (globalThis as typeof globalThis & { nouraRenderScene?: (ops: BoardOp[]) => Promise<string | null> }).nouraRenderScene;
    if (!hook) throw new Error('Board render hook is unavailable.');
    return hook(candidateOps);
  }, ops);
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
