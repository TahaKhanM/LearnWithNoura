import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { chromium, type Browser } from 'playwright';
import { createOpenAIImageGroundingProposalPort } from '../server/board/imageGroundingService.js';
import { createOpenAIVisionAuditPort } from '../server/board/visionAuditService.js';
import { estimateUsageCostUsd } from '../server/board/eval/budget.js';
import {
  evaluateImageGroundingStudy,
  parseImageGroundingStudyFixture,
  planImageGroundingStudy,
  type GroundingStudyObservations,
} from '../server/board/eval/imageGroundingStudy.js';
import { LiveSpendLedger, type SpendUsageEvidence } from '../server/board/eval/spendLedger.js';
import type { DirectorStreamUsage } from '../server/board/directorStreamingService.js';
import type { ImageRegionSelector } from '../shared/boardOps.js';

const FIXTURE_PATH = resolve('server/board/eval/fixtures/m7-image-grounding-study.json');
const OUTPUT_PATH = resolve('server/board/eval/results/2026-09-02-drawing-m7-image-grounding-study.json');
const LEDGER_PATH = resolve('server/board/eval/results/2026-09-02-drawing-m7-image-grounding-study.ledger.jsonl');
const RESERVE_PER_CALL_USD = 0.03;
const HARD_CAP_USD = 0.6;
const rawFixture = readFileSync(FIXTURE_PATH, 'utf8');
const fixture = parseImageGroundingStudyFixture(rawFixture);
const plan = planImageGroundingStudy(rawFixture, { reservePerCallUsd: RESERVE_PER_CALL_USD, capUsd: HARD_CAP_USD });
if (!plan.fits || plan.canary.maximumCalls > 5 || plan.full.maximumCalls > 17) throw new Error('Image grounding study does not fit its pre-registered budget.');

if (!process.argv.includes('--live')) {
  const browser = await chromium.launch({ headless: true });
  try {
    const rasterized = await Promise.all(fixture.items.map(async (item) => Boolean(await raster(browser, item.svg))));
    const observations: GroundingStudyObservations = {
      proposals: fixture.items.map((item) => ({ itemId: item.id, selector: item.expected, confidence: 0.9 })),
      correctSelfChecks: fixture.items.map((item) => ({ itemId: item.id, outcome: 'approved' as const })),
      defectSelfChecks: fixture.defectItemIds.map((itemId) => ({ itemId, outcome: 'rejected' as const })),
      malformedReplies: 0,
    };
    console.log(JSON.stringify({
      ok: rasterized.every(Boolean),
      evidenceMode: 'offline_dry_run',
      providerCalls: 0,
      externalRequestCount: 0,
      fixtureSha256: sha(rawFixture),
      plan,
      rasterized,
      syntheticEvaluation: evaluateImageGroundingStudy(rawFixture, observations),
      liveStatus: 'requires_fresh_itemized_authorization',
    }, null, 2));
  } finally {
    await browser.close();
  }
  process.exit(0);
}

if (!process.argv.includes('--confirm-authorized')) throw new Error('Live grounding calls require the explicit --confirm-authorized flag after itemized user authorization.');
if (existsSync(OUTPUT_PATH) || existsSync(LEDGER_PATH)) throw new Error('Refusing to overwrite immutable M7 grounding evidence.');
const { config: loadEnv } = await import('dotenv');
loadEnv({ override: false });
const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY is required for an authorized live study.');
const client = new OpenAI({ apiKey });
const runId = `m7-image-grounding-${Date.now().toString(36)}`;
const ledger = new LiveSpendLedger(HARD_CAP_USD, (entry) => appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`, { flag: 'a' }), runId);
writeFileSync(LEDGER_PATH, '', { flag: 'wx' });
let latestUsage: DirectorStreamUsage | null = null;
const proposal = createOpenAIImageGroundingProposalPort({
  client, model: 'gpt-5.6-luna', reasoningEffort: 'low', onUsage: (usage) => { latestUsage = usage; },
});
const audit = createOpenAIVisionAuditPort({
  client, model: 'gpt-5.6-luna', reasoningEffort: 'low', onUsage: (usage) => { latestUsage = usage; },
});
const observations: GroundingStudyObservations = { proposals: [], correctSelfChecks: [], defectSelfChecks: [], malformedReplies: 0 };
const browser = await chromium.launch({ headless: true });
let stoppedAfterCanary = false;
try {
  const byId = new Map(fixture.items.map((item) => [item.id, item]));
  const runItem = async (itemId: string) => {
    const item = byId.get(itemId);
    if (!item) throw new Error(`Unknown fixture ${itemId}.`);
    const boardImage = await raster(browser, item.svg);
    if (!boardImage) throw new Error('Synthetic rasterization failed.');
    const proposed = await providerCall(ledger, async () => proposal.propose({
      imageId: `fixture-${item.id}`, hint: item.hint, boardImage,
    }, { signal: new AbortController().signal }));
    if (!proposed) {
      observations.malformedReplies += 1;
      return;
    }
    observations.proposals.push({ itemId: item.id, selector: proposed.selector, confidence: proposed.confidence });
    if (proposed.confidence < fixture.confidenceThreshold) return;
    const candidateImage = await raster(browser, overlay(item.svg, proposed.selector));
    if (!candidateImage) throw new Error('Candidate rasterization failed.');
    const verdict = await providerCall(ledger, async () => audit.inspect({
      purpose: 'Verify a proposed image-region annotation.', idea: item.hint,
      constraints: 'Approve only if the red annotation points to the requested target.', candidateImage,
    }, { signal: new AbortController().signal }));
    observations.correctSelfChecks.push({ itemId: item.id, outcome: verdict.outcome });
  };
  const runDefect = async (itemId: string) => {
    const item = byId.get(itemId);
    if (!item) throw new Error(`Unknown defect fixture ${itemId}.`);
    const candidateImage = await raster(browser, overlay(item.svg, item.defect));
    if (!candidateImage) throw new Error('Defect rasterization failed.');
    const verdict = await providerCall(ledger, async () => audit.inspect({
      purpose: 'Verify a proposed image-region annotation.', idea: item.hint,
      constraints: 'Approve only if the red annotation points to the requested target.', candidateImage,
    }, { signal: new AbortController().signal }));
    observations.defectSelfChecks.push({ itemId: item.id, outcome: verdict.outcome });
  };

  for (const itemId of fixture.canaryItemIds) await runItem(itemId);
  await runDefect(fixture.defectItemIds[0]);
  const canarySafe = observations.malformedReplies === 0 &&
    observations.proposals.length === fixture.canaryItemIds.length &&
    observations.correctSelfChecks.length === fixture.canaryItemIds.length &&
    observations.correctSelfChecks.every((row) => row.outcome === 'approved') &&
    observations.defectSelfChecks[0]?.outcome === 'rejected';
  if (!canarySafe) stoppedAfterCanary = true;
  if (canarySafe) {
    for (const item of fixture.items) if (!fixture.canaryItemIds.includes(item.id)) await runItem(item.id);
    for (const itemId of fixture.defectItemIds.slice(1)) await runDefect(itemId);
  }
} finally {
  await browser.close();
}
const report = evaluateImageGroundingStudy(rawFixture, observations);
const result = {
  schemaVersion: '1.0.0',
  evidenceMode: 'authorized_synthetic_image_grounding_microstudy',
  generatedAt: new Date().toISOString(),
  fixtureSha256: sha(rawFixture),
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  plan,
  stoppedAfterCanary,
  observations,
  report,
  ledger: ledger.snapshot(),
};
const raw = `${JSON.stringify(result, null, 2)}\n`;
writeImmutable(OUTPUT_PATH, raw);
console.log(JSON.stringify({
  ok: report.accepted && !stoppedAfterCanary,
  outputPath: OUTPUT_PATH,
  resultSha256: sha(raw),
  providerCalls: result.ledger.providerCalls,
  observedCostUsd: result.ledger.observedCostUsd,
  accountedCostUsd: result.ledger.accountedCostUsd,
  metrics: report.metrics,
  stoppedAfterCanary,
}, null, 2));
if (!report.accepted || stoppedAfterCanary) process.exitCode = 1;

async function providerCall<T>(ledger: LiveSpendLedger, run: () => Promise<T>): Promise<T> {
  const callId = ledger.begin({ phase: 'image_grounding', models: ['gpt-5.6-luna'], reserveUsd: RESERVE_PER_CALL_USD });
  ledger.noteProviderCalls(callId, 1);
  latestUsage = null;
  try {
    const value = await run();
    const usage = latestUsage;
    const observedCostUsd = usage ? estimateUsageCostUsd('gpt-5.6-luna', usage) : 0;
    ledger.complete(callId, {
      status: 'completed', observedCostUsd, upperBoundUsd: RESERVE_PER_CALL_USD,
      usage: usage ? [usageEvidence(usage)] : [],
    });
    return value;
  } catch (error) {
    ledger.complete(callId, { status: 'failed', observedCostUsd: 0, upperBoundUsd: RESERVE_PER_CALL_USD, usage: [] });
    throw error;
  }
}

async function raster(browser: Browser, svg: string): Promise<string | null> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  try {
    await page.setContent(svg);
    const bytes = await page.locator('svg').screenshot({ type: 'jpeg', quality: 88 });
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  } finally {
    await page.close();
  }
}

function overlay(svg: string, selector: ImageRegionSelector): string {
  const box = selectorBox(selector);
  const x = box.x * 1000; const y = box.y * 600; const w = Math.max(20, box.w * 1000); const h = Math.max(20, box.h * 600);
  const mark = `<ellipse cx='${x + w / 2}' cy='${y + h / 2}' rx='${w / 2 + 10}' ry='${h / 2 + 10}' fill='none' stroke='#e14b3c' stroke-width='10'/>`;
  return svg.replace('</svg>', `${mark}</svg>`);
}
function selectorBox(selector: ImageRegionSelector): { x: number; y: number; w: number; h: number } {
  if (selector.type === 'FragmentSelector') return selector;
  if (selector.type === 'PointSelector') return { x: selector.x - 0.01, y: selector.y - 0.0167, w: 0.02, h: 0.0334 };
  const xs = selector.points.map((point) => point[0]); const ys = selector.points.map((point) => point[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
function usageEvidence(usage: DirectorStreamUsage): SpendUsageEvidence {
  return { model: 'gpt-5.6-luna', ...usage, usageComplete: true };
}
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function writeImmutable(path: string, raw: string): void {
  const descriptor = openSync(path, 'wx');
  try { writeFileSync(descriptor, raw); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
