import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { applyDirectorBoardPolicy } from '../server/board/directorSchema.js';
import { loadM7CurriculumFixtures, loadM7CurriculumMatrix, type M7CurriculumFixture } from '../server/board/eval/m7CurriculumMatrix.js';
import type { BoardOp } from '../shared/boardOps.js';
import type { LayoutIssue } from '../shared/layoutFeedback.js';

const OUTPUT = resolve('server/board/eval/results/2026-09-03-drawing-m7-curriculum-browser-verified.json');
const ARTIFACTS = resolve('artifacts/evaluation/drawing-m7-curriculum-verified');
const args = process.argv.slice(2);
if (!args.includes('--regenerate')) throw new Error('M7 curriculum generation requires --regenerate; verification uses the retained evidence compiler.');
if (existsSync(OUTPUT)) throw new Error('Refusing to overwrite immutable M7 curriculum evidence.');
const harnessIndex = args.indexOf('--harness-url');
if (harnessIndex < 0 || !args[harnessIndex + 1]) throw new Error('Pass --harness-url with the loopback board harness origin.');
const target = new URL('/dev/board', args[harnessIndex + 1]);
if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('M7 curriculum validation is loopback-only.');
const matrix = loadM7CurriculumMatrix();
const fixtures = loadM7CurriculumFixtures();
const matrixRaw = readFileSync(resolve('server/board/eval/curriculum-matrix-m7.json'), 'utf8');
const baselineFixturesRaw = readFileSync(resolve('server/board/eval/fixtures/curriculum-matrix-scenes.json'), 'utf8');
const m7FixturesRaw = readFileSync(resolve('server/board/eval/fixtures/m7-curriculum-new-scenes.json'), 'utf8');
mkdirSync(ARTIFACTS, { recursive: true });
const externalRequests: string[] = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === target.origin && url.pathname === '/api/auth/session') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ required: false, authenticated: true }) });
    return;
  }
  if (url.origin === target.origin && url.pathname === '/api/board-assets/img-a1b2c3d4') {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: syntheticMachineSvg() });
    return;
  }
  if (url.origin !== target.origin) {
    externalRequests.push(url.href);
    await route.abort();
    return;
  }
  await route.continue();
});
try {
  await page.goto(target.href, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const host = globalThis as typeof globalThis & { nouraPreflightSceneWithContext?: unknown; nouraRenderSceneWithContext?: unknown };
    return typeof host.nouraPreflightSceneWithContext === 'function' && typeof host.nouraRenderSceneWithContext === 'function';
  });
  const rows: Array<Record<string, unknown> & { rowId: string; fixtureId: string; browserAccepted: boolean; rasterSha256: string | null }> = [];
  const rasters: Array<{ rowId: string; dataUrl: string }> = [];
  for (const fixture of fixtures) {
    const visibleObjectIds = [...fixture.existingTutorOps, ...fixture.existingLearnerOps].flatMap((op) => op.op === 'add' ? [op.id] : []);
    const policy = applyDirectorBoardPolicy(fixture.candidateOps, { density: 'standard', visibleObjectIds });
    const startedAt = Date.now();
    const verdict = policy.ok ? await preflight(page, fixture, policy.ops) : { accepted: false, reasons: policy.reasons, layoutIssues: [] };
    const raster = verdict.accepted && policy.ok ? await render(page, fixture, policy.ops) : null;
    const firstPaintMs = Date.now() - startedAt;
    const bytes = raster ? Buffer.from(raster.split(',')[1] ?? '', 'base64') : null;
    const screenshotPath = bytes ? `artifacts/evaluation/drawing-m7-curriculum-verified/${fixture.rowId}.jpg` : null;
    if (bytes && screenshotPath) {
      writeFileSync(resolve(screenshotPath), bytes);
      rasters.push({ rowId: fixture.rowId, dataUrl: raster! });
    }
    rows.push({
      rowId: fixture.rowId,
      fixtureId: fixture.id,
      policyAccepted: policy.ok,
      browserAccepted: verdict.accepted,
      reasons: verdict.reasons,
      layoutIssues: verdict.layoutIssues,
      firstPaintMs,
      rasterSha256: bytes ? hash(bytes) : null,
      screenshotPath,
    });
  }
  const contactSheets = await createContactSheets(page, rasters);
  const accepted = externalRequests.length === 0 && rows.length === 39 && rows.every((row) => row.browserAccepted && row.rasterSha256);
  const result = {
    schemaVersion: '1.0.0',
    evidenceMode: 'offline_loopback_m7_curriculum_browser',
    generatedAt: new Date().toISOString(),
    accepted,
    providerCalls: 0,
    externalRequestCount: externalRequests.length,
    matrixSha256: hash(matrixRaw),
    baselineFixturesSha256: hash(baselineFixturesRaw),
    m7FixturesSha256: hash(m7FixturesRaw),
    summary: {
      totalRows: matrix.rows.length,
      supportedRows: matrix.rows.filter((row) => row.status === 'supported').length,
      composableRows: matrix.rows.filter((row) => row.status === 'composable').length,
      missingRows: 0,
      fixtureRows: rows.length,
      browserAccepted: rows.filter((row) => row.browserAccepted).length,
      maximumFirstPaintMs: Math.max(...rows.map((row) => Number(row.firstPaintMs))),
    },
    contactSheets,
    rows,
  };
  writeImmutable(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!accepted) process.exitCode = 1;
} finally {
  await browser.close();
}

async function preflight(page: Page, fixture: M7CurriculumFixture, candidateOps: BoardOp[]) {
  return page.evaluate(async (input) => {
    const hook = (globalThis as typeof globalThis & { nouraPreflightSceneWithContext?: (value: typeof input) => Promise<{ accepted: boolean; reasons: string[]; layoutIssues: LayoutIssue[] }> }).nouraPreflightSceneWithContext;
    if (!hook) throw new Error('Context preflight hook unavailable.');
    return hook(input);
  }, { ...fixture, candidateOps, semanticGroupId: fixture.rowId });
}
async function render(page: Page, fixture: M7CurriculumFixture, candidateOps: BoardOp[]) {
  return page.evaluate(async (input) => {
    const hook = (globalThis as typeof globalThis & { nouraRenderSceneWithContext?: (value: typeof input) => Promise<string | null> }).nouraRenderSceneWithContext;
    if (!hook) throw new Error('Context render hook unavailable.');
    return hook(input);
  }, { ...fixture, candidateOps, semanticGroupId: fixture.rowId });
}
async function createContactSheets(page: Page, rasters: Array<{ rowId: string; dataUrl: string }>) {
  const output: Array<{ path: string; sha256: string }> = [];
  for (let index = 0; index < rasters.length; index += 10) {
    const rows = rasters.slice(index, index + 10);
    await page.setContent(`<style>body{font:14px sans-serif;margin:12px;background:#eee}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.card{background:white;padding:8px}.card img{width:100%;display:block}.card b{display:block;margin-bottom:6px}</style><div class="grid">${rows.map((row) => `<div class="card"><b>${row.rowId}</b><img src="${row.dataUrl}"></div>`).join('')}</div>`);
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    const path = `${ARTIFACTS}/contact-sheet-${index / 10 + 1}.png`;
    const bytes = await page.screenshot({ path, fullPage: true });
    output.push({ path: path.replace(`${resolve('.')}/`, ''), sha256: hash(bytes) });
  }
  return output;
}
function syntheticMachineSvg(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="430"><rect width="800" height="430" fill="#eef4ff"/><circle cx="400" cy="220" r="90" fill="#f0a227"/><rect x="310" y="205" width="180" height="30" fill="#26231f"/><text x="400" y="370" text-anchor="middle" font-size="36">Wheel and axle</text></svg>';
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function writeImmutable(path: string, raw: string): void { const descriptor = openSync(path, 'wx'); try { writeFileSync(descriptor, raw); fsyncSync(descriptor); } finally { closeSync(descriptor); } }
