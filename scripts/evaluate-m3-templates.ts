import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { z } from 'zod';
import { loadDirectorEvalCorpus } from '../server/board/eval/corpus.js';
import { extractIntentTemplateScene } from '../server/board/templateLane.js';
import type { BoardOp } from '../shared/boardOps.js';
import type { LayoutIssue } from '../shared/layoutFeedback.js';
import fixtureJson from '../server/board/eval/fixtures/m3-template-routing-fixtures.json' with { type: 'json' };

const FixtureSchema = z.object({
  schemaVersion: z.literal('1.1.0'),
  scope: z.literal('mechanism_only'),
  captures: z.array(z.object({
    id: z.string(), idea: z.string(), constraints: z.string().nullable(), expectedTemplate: z.string(),
  }).strict()).length(3),
  retainedCompletedExtractors: z.array(z.string()),
  deferredExtractorPolicy: z.string().min(1),
  corpusExpectedCaptures: z.record(z.string(), z.string()),
  openSetIntentIds: z.array(z.string()).min(1),
  matrixInformedRows: z.array(z.string()).min(1),
}).strict();
const fixtures = FixtureSchema.parse(fixtureJson);
const OUTPUT = 'server/board/eval/results/2026-09-02-drawing-m3-template-browser.json';
const SCREENSHOTS = 'artifacts/evaluation/drawing-m3-templates';
const args = process.argv.slice(2);
if (!args.includes('--regenerate')) throw new Error('M3 template browser generation requires --regenerate.');
const harnessIndex = args.indexOf('--harness-url');
if (harnessIndex < 0 || !args[harnessIndex + 1]) throw new Error('Pass the loopback --harness-url.');
const target = new URL('/dev/board', args[harnessIndex + 1]);
if (!['localhost', '127.0.0.1'].includes(target.hostname)) throw new Error('M3 template evidence is loopback-only.');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let externalRequestCount = 0;
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === target.origin && url.pathname === '/api/auth/session') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ required: false, authenticated: true }) });
  } else if (url.origin === target.origin) await route.continue();
  else { externalRequestCount += 1; await route.abort(); }
});
try {
  await page.goto(target.href, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const host = globalThis as typeof globalThis & { nouraPreflightScene?: unknown; nouraRenderScene?: unknown };
    return typeof host.nouraPreflightScene === 'function' && typeof host.nouraRenderScene === 'function';
  });
  mkdirSync(resolve(SCREENSHOTS), { recursive: true });
  const rows = [];
  for (const fixture of fixtures.captures) {
    const startedAt = performance.now();
    const scene = extractIntentTemplateScene({ ...fixture, sectionId: `m3-${fixture.id}` });
    if (!scene || scene.template !== fixture.expectedTemplate) throw new Error(`Template fixture ${fixture.id} did not route exactly.`);
    const browserResult = await evaluateScene(page, scene.ops);
    const firstPaintMs = Math.round(performance.now() - startedAt);
    const raster = browserResult.raster ? Buffer.from(browserResult.raster.split(',')[1] ?? '', 'base64') : null;
    const screenshotPath = raster ? `${SCREENSHOTS}/${fixture.id}.jpg` : null;
    if (raster && screenshotPath) writeFileSync(resolve(screenshotPath), raster);
    rows.push({
      fixtureId: fixture.id,
      template: scene.template,
      browserAccepted: browserResult.preflight.accepted,
      reasons: browserResult.preflight.reasons,
      layoutIssues: browserResult.preflight.layoutIssues,
      firstPaintMs,
      rasterSha256: raster ? createHash('sha256').update(raster).digest('hex') : null,
      screenshotPath,
    });
  }
  const corpus = loadDirectorEvalCorpus();
  const corpusRows = [];
  for (const [index, intent] of corpus.entries()) {
    const scene = extractIntentTemplateScene({ idea: intent.intent, constraints: null, sectionId: `m3-c-${index}` });
    if (!scene) continue;
    const browserResult = await evaluateScene(page, scene.ops);
    corpusRows.push({
      intentId: intent.id,
      template: scene.template,
      browserAccepted: browserResult.preflight.accepted,
      reasons: browserResult.preflight.reasons,
      layoutIssues: browserResult.preflight.layoutIssues,
      rasterSha256: browserResult.raster
        ? createHash('sha256').update(Buffer.from(browserResult.raster.split(',')[1] ?? '', 'base64')).digest('hex')
        : null,
    });
  }
  const openSetCaptures = fixtures.openSetIntentIds.filter((intentId) => {
    const intent = corpus.find((entry) => entry.id === intentId);
    return intent && extractIntentTemplateScene({ idea: intent.intent, constraints: null, sectionId: `m3-open-${intent.id}` });
  });
  const durations = rows.map((row) => row.firstPaintMs).sort((a, b) => a - b);
  const uniqueTemplates = new Set(rows.map((row) => row.template)).size;
  const accepted = externalRequestCount === 0 && uniqueTemplates === 3 && openSetCaptures.length === 0 &&
    rows.every((row) => row.browserAccepted && row.rasterSha256 && row.firstPaintMs <= 2_000) &&
    corpusRows.every((row) => row.browserAccepted && row.rasterSha256) &&
    JSON.stringify(Object.fromEntries(corpusRows.map((row) => [row.intentId, row.template]))) === JSON.stringify(fixtures.corpusExpectedCaptures);
  const report = {
    schemaVersion: '1.1.0',
    evidenceMode: 'offline_loopback_template_mechanism_browser',
    scope: fixtures.scope,
    generatedAt: new Date().toISOString(),
    accepted,
    providerCalls: 0,
    externalRequestCount,
    fixtureSha256: sha(readFileSync(resolve('server/board/eval/fixtures/m3-template-routing-fixtures.json'))),
    matrixSha256: sha(readFileSync(resolve('server/board/eval/curriculum-matrix.json'))),
    summary: {
      fixtureRows: rows.length,
      uniqueTemplates,
      browserAccepted: rows.filter((row) => row.browserAccepted).length,
      maximumFirstPaintMs: Math.max(...durations),
      p50FirstPaintMs: percentile(durations, 0.5),
      p95FirstPaintMs: percentile(durations, 0.95),
      firstPaintThresholdMs: 2_000,
      falseHoldoutCaptures: openSetCaptures.length,
      corpusCapturedIntents: corpusRows.length,
    },
    matrixInformedRows: fixtures.matrixInformedRows,
    retainedCompletedExtractors: fixtures.retainedCompletedExtractors,
    deferredExtractorPolicy: fixtures.deferredExtractorPolicy,
    rows,
    corpusRows,
    openSetCaptures,
  };
  writeText(resolve(OUTPUT), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!accepted) process.exitCode = 1;
} finally {
  await browser.close();
}

async function evaluateScene(page: Page, ops: BoardOp[]) {
  return page.evaluate(async (candidateOps) => {
    const host = globalThis as typeof globalThis & {
      nouraPreflightScene?: (value: BoardOp[]) => Promise<{ accepted: boolean; reasons: string[]; layoutIssues: LayoutIssue[] }>;
      nouraRenderScene?: (value: BoardOp[]) => Promise<string | null>;
    };
    if (!host.nouraPreflightScene || !host.nouraRenderScene) throw new Error('Board harness hooks are unavailable.');
    return { preflight: await host.nouraPreflightScene(candidateOps), raster: await host.nouraRenderScene(candidateOps) };
  }, ops);
}
function percentile(values: number[], quantile: number): number { return values[Math.max(0, Math.ceil(values.length * quantile) - 1)] ?? 0; }
function sha(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, value, { flag: 'wx' });
  const descriptor = openSync(temporary, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
}
