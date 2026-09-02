import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { applyDirectorBoardPolicy } from '../server/board/directorSchema.js';
import { validateOps, type AddOp, type BoardOp, type ShapeSpec, type Vec } from '../shared/boardOps.js';
import type { LayoutIssue } from '../shared/layoutFeedback.js';

const M0_PATH = resolve('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json');
const OUTPUT = resolve('server/board/eval/results/2026-09-03-drawing-m7-relational-m0-replay-accepted.json');
const FAILURE_DIR = resolve('artifacts/evaluation/drawing-m7-relational-failures-accepted');
const args = process.argv.slice(2);
if (!args.includes('--regenerate')) throw new Error('Relational replay generation requires --regenerate.');
if (existsSync(OUTPUT)) throw new Error('Refusing to overwrite immutable relational replay evidence.');
const harnessIndex = args.indexOf('--harness-url');
if (harnessIndex < 0 || !args[harnessIndex + 1]) throw new Error('Pass --harness-url with a loopback board harness.');
const target = new URL('/dev/board', args[harnessIndex + 1]);
if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('Relational replay is loopback-only.');
const m0Raw = readFileSync(M0_PATH, 'utf8');
if (hash(m0Raw) !== 'e02ccc9f240f72a7937fe192f30867434eb7f857fb6c45a5f8b52fa06507ae79') throw new Error('M0 source hash mismatch.');
const m0 = JSON.parse(m0Raw) as { trials: Array<{ intentId: string; conditionId: string; cacheState: string; trial: number; strictSchemaValid: boolean; validatorPassed: boolean; storyboardCoverage: boolean; proposalText: string }> };
const selected = m0.trials.filter((row) => row.conditionId === 'terra-low' && row.cacheState === 'cold' && row.trial === 1);
if (selected.length !== 36 || new Set(selected.map((row) => row.intentId)).size !== 36) throw new Error('Representative M0 selection must contain one first cold Terra-low row per intent.');
mkdirSync(FAILURE_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const externalRequests: string[] = [];
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === target.origin && url.pathname === '/api/auth/session') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ required: false, authenticated: true }) });
  } else if (url.origin !== target.origin) {
    externalRequests.push(url.href);
    await route.abort();
  } else await route.continue();
});
try {
  await page.goto(target.href, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof (globalThis as typeof globalThis & { nouraPreflightScene?: unknown }).nouraPreflightScene === 'function');
  const rows = [];
  for (const source of selected) {
    const proposal = JSON.parse(source.proposalText) as { steps?: Array<{ ops?: unknown[] }> };
    const rawOps = proposal.steps?.flatMap((step) => step.ops ?? []) ?? [];
    const validated = validateOps(rawOps, { tier: 'authored' });
    const relationalOps = addRepresentativePlacement(validated.ops.filter((op): op is AddOp => op.op === 'add'));
    const policy = applyDirectorBoardPolicy(relationalOps, { density: 'standard', visibleObjectIds: [] });
    const verdict = policy.ok ? await preflight(page, policy.ops) : { accepted: false, reasons: policy.reasons, layoutIssues: [] };
    const strictValid = source.strictSchemaValid && validated.rejected.length === 0 && validated.ops.length === rawOps.length;
    const accepted = strictValid && source.storyboardCoverage && policy.ok && verdict.accepted;
    if (!accepted) {
      const image = policy.ok ? await render(page, policy.ops) : null;
      if (image) writeFileSync(`${FAILURE_DIR}/${source.intentId}.jpg`, Buffer.from(image.split(',')[1] ?? '', 'base64'));
    }
    rows.push({
      intentId: source.intentId,
      sourceTrial: { conditionId: source.conditionId, cacheState: source.cacheState, trial: source.trial },
      relationalPlacementCount: relationalOps.filter((op) => op.place).length,
      strictValid,
      originalValidatorPassed: source.validatorPassed,
      authoredPolicyAccepted: policy.ok,
      browserAccepted: verdict.accepted,
      reasons: verdict.reasons,
      layoutIssues: verdict.layoutIssues,
      accepted,
    });
  }
  const cohort = rows.filter((row) => row.relationalPlacementCount > 0);
  const acceptedRows = cohort.filter((row) => row.accepted).length;
  const validity = acceptedRows / cohort.length;
  const result = {
    schemaVersion: '1.0.0',
    evidenceMode: 'offline_m0_representative_relational_replay',
    generatedAt: new Date().toISOString(),
    accepted: cohort.length >= 30 && validity >= 0.95 && externalRequests.length === 0,
    providerCalls: 0,
    externalRequestCount: externalRequests.length,
    sourceSha256: hash(m0Raw),
    selection: 'first cold terra-low trial for each of 36 M0 intents',
    summary: {
      sourceRows: rows.length,
      rows: cohort.length,
      rowsWithRelationalPlacement: cohort.length,
      originalValidatorAcceptedRows: cohort.filter((row) => row.originalValidatorPassed).length,
      relationalRecoveredRows: cohort.filter((row) => !row.originalValidatorPassed && row.accepted).length,
      acceptedRows,
      singleShotConjunctiveValidity: validity,
      threshold: 0.95,
    },
    rows,
  };
  writeImmutable(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.accepted) process.exitCode = 1;
} finally {
  await browser.close();
}

function addRepresentativePlacement(ops: AddOp[]): AddOp[] {
  const output: AddOp[] = [];
  let placementAdded = false;
  for (const op of ops) {
    if (!placementAdded && (op.spec.kind === 'text' || op.spec.kind === 'equation')) {
      const point = specPoint(op.spec);
      const candidates = output.filter((candidate) => structural(candidate.spec)).map((candidate) => ({ candidate, point: specPoint(candidate.spec) })).filter((entry): entry is { candidate: AddOp; point: Vec } => Boolean(entry.point));
      if (point && candidates.length > 0) {
        const nearest = candidates.sort((left, right) => distance(point, left.point) - distance(point, right.point))[0];
        const dx = point[0] - nearest.point[0]; const dy = point[1] - nearest.point[1];
        const side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'below' : 'above');
        output.push({ ...op, place: { anchor: nearest.candidate.id, side, gap: 24, align: 'center' } });
        placementAdded = true;
        continue;
      }
    }
    output.push(op);
  }
  if (!placementAdded && output.length >= 2) {
    const movableIndex = output.findIndex((op, index) => index > 0 && ['box', 'circle', 'ellipse', 'point', 'polygon', 'asset'].includes(op.spec.kind));
    const anchorIndex = movableIndex > 0 ? output.slice(0, movableIndex).findLastIndex((op) => structural(op.spec)) : -1;
    if (movableIndex > 0 && anchorIndex >= 0) output[movableIndex] = { ...output[movableIndex], place: { anchor: output[anchorIndex].id, side: 'right', gap: 36, align: 'center' } };
  }
  return output;
}
function structural(spec: ShapeSpec): boolean { return !['text', 'equation', 'label', 'connector', 'plot', 'annotate', 'transform'].includes(spec.kind); }
function specPoint(spec: ShapeSpec): Vec | null {
  if ('at' in spec && Array.isArray(spec.at)) return spec.at;
  if ('center' in spec && Array.isArray(spec.center)) return spec.center;
  if (spec.kind === 'line') return [(spec.from[0] + spec.to[0]) / 2, (spec.from[1] + spec.to[1]) / 2];
  if (spec.kind === 'polygon' || spec.kind === 'path' || spec.kind === 'curve') return [spec.points.reduce((sum, point) => sum + point[0], 0) / spec.points.length, spec.points.reduce((sum, point) => sum + point[1], 0) / spec.points.length];
  if (spec.kind === 'angle') return spec.vertex;
  return null;
}
function distance(a: Vec, b: Vec): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
async function preflight(page: Page, ops: BoardOp[]) { return page.evaluate(async (candidate) => { const hook = (globalThis as typeof globalThis & { nouraPreflightScene?: (ops: BoardOp[]) => Promise<{ accepted: boolean; reasons: string[]; layoutIssues: LayoutIssue[] }> }).nouraPreflightScene; if (!hook) throw new Error('Preflight unavailable.'); return hook(candidate); }, ops); }
async function render(page: Page, ops: BoardOp[]) { return page.evaluate(async (candidate) => { const hook = (globalThis as typeof globalThis & { nouraRenderScene?: (ops: BoardOp[]) => Promise<string | null> }).nouraRenderScene; return hook ? hook(candidate) : null; }, ops); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function writeImmutable(path: string, raw: string): void { const descriptor = openSync(path, 'wx'); try { writeFileSync(descriptor, raw); fsyncSync(descriptor); } finally { closeSync(descriptor); } }
