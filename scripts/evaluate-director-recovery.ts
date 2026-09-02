import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import OpenAI from 'openai';
import { chromium, type Page } from 'playwright';
import type { BoardOp } from '../shared/boardOps.js';
import type { LayoutPreflightResult } from '../shared/layoutFeedback.js';
import {
  buildLayoutFailureCohort,
  collectLayoutFailureFeedback,
  compileLayoutFailureFeedbackEvidence,
  F9_LAYOUT_RECOVERY_POLICY,
  layoutRecoveryBudgetPlan,
  summarizeProxyRecovery,
} from '../server/board/eval/layoutRecoveryStudy.js';
import type { M1PipelineStudyHarness } from '../server/board/eval/m1PipelineStudyTypes.js';
import { runAuthorizedLayoutRecoveryStudy } from '../server/board/eval/liveLayoutRecoveryStudy.js';
import { compileLiveLayoutRecoveryEvidence } from '../server/board/eval/layoutRecoveryEvidence.js';

const SOURCE_PATH = 'server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json';
const OBSERVATIONS_PATH = 'server/board/eval/results/2026-09-01-drawing-m1-pipeline-browser-observations.json';
const DEFAULT_FEEDBACK_OUTPUT = 'server/board/eval/results/2026-09-01-drawing-f9-layout-feedback.json';
const DEFAULT_LIVE_OUTPUT = 'server/board/eval/results/2026-09-01-drawing-f9-recovery-study.json';
const argv = process.argv.slice(2);
let collectFeedback = false;
let authorizedLiveRun = false;
let maxSpendUsd = Number.NaN;
let harnessUrl = '';
let outputPath = resolve(DEFAULT_FEEDBACK_OUTPUT);
let outputExplicit = false;
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === '--collect-feedback') collectFeedback = true;
  else if (argument === '--authorized-live-run') authorizedLiveRun = true;
  else if (argument === '--max-spend-usd') maxSpendUsd = Number(requiredValue(argv, ++index, argument));
  else if (argument === '--harness-url') harnessUrl = requiredValue(argv, ++index, argument);
  else if (argument === '--output') {
    outputPath = resolve(requiredValue(argv, ++index, argument));
    outputExplicit = true;
  } else if (argument === '--help') {
    console.log('Usage: npm run test:director-recovery [-- --collect-feedback --harness-url http://localhost:5180/dev/board | --authorized-live-run --max-spend-usd 5 --harness-url http://localhost:5180/dev/board]');
    process.exit(0);
  } else throw new Error(`Unknown recovery-study option: ${argument}`);
}
if (collectFeedback && authorizedLiveRun) throw new Error('Choose feedback collection or the authorized live study, not both.');
if (authorizedLiveRun && !outputExplicit) outputPath = resolve(DEFAULT_LIVE_OUTPUT);

const sourceRawJson = readFileSync(resolve(SOURCE_PATH), 'utf8');
const observationsRawJson = readFileSync(resolve(OBSERVATIONS_PATH), 'utf8');
const cohort = buildLayoutFailureCohort(sourceRawJson, observationsRawJson);
const proxy = summarizeProxyRecovery(cohort);
const budget = layoutRecoveryBudgetPlan({ failureCount: cohort.length, gradeRecoverySample: true });
const feedbackRawJson = readFileSync(resolve(F9_LAYOUT_RECOVERY_POLICY.layoutFeedbackPath), 'utf8');
const evidence = compileLayoutFailureFeedbackEvidence(
  sourceRawJson,
  observationsRawJson,
  feedbackRawJson,
);
if (authorizedLiveRun) {
  if (!harnessUrl) throw new Error('--authorized-live-run requires --harness-url.');
  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0) throw new Error('--authorized-live-run requires a positive --max-spend-usd.');
  if (budget.conservativeTotalUsd > maxSpendUsd) {
    throw new Error(`F9 conservative plan $${budget.conservativeTotalUsd} exceeds the requested $${maxSpendUsd} cap.`);
  }
  if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing F9 live evidence at ${outputPath}.`);
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ override: false });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required only for the explicitly authorized F9 live study.');
  const ledgerPath = resolve(`artifacts/evaluation/drawing-f9-${Date.now()}.partial.ndjson`);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, '', { flag: 'wx' });
  const browser = await createIsolatedBrowserHarness(harnessUrl);
  try {
    const report = await runAuthorizedLayoutRecoveryStudy({
      client: new OpenAI({ apiKey }),
      harness: { ...browser.harness, close: browser.close },
      sourceRawJson,
      observationsRawJson,
      feedbackRawJson,
      maxSpendUsd,
      onProgress: (message) => console.error(message),
      onSpendEvent: (event) => appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, 'utf8'),
    });
    const raw = `${JSON.stringify(report, null, 2)}\n`;
    writeText(outputPath, raw);
    console.log(JSON.stringify({
      ok: true,
      evidenceMode: report.evidenceMode,
      providerCalls: report.providerCalls,
      accountedCostUsd: report.accountedCostUsd,
      maxSpendUsd: report.maxSpendUsd,
      headroomUsd: Math.round((report.maxSpendUsd - report.accountedCostUsd) * 10_000) / 10_000,
      outputPath,
      resultSha256: sha256(raw),
      localLedgerPath: ledgerPath,
      decision: report.decision,
    }, null, 2));
  } finally {
    await browser.close();
  }
} else if (collectFeedback) {
  if (!harnessUrl) throw new Error('--collect-feedback requires --harness-url.');
  const browser = await createIsolatedBrowserHarness(harnessUrl);
  try {
    const artifact = await collectLayoutFailureFeedback({
      sourceRawJson,
      observationsRawJson,
      harness: browser.harness,
    });
    const raw = `${JSON.stringify(artifact, null, 2)}\n`;
    writeText(outputPath, raw);
    console.log(JSON.stringify({
      ok: true,
      evidenceMode: artifact.evidenceMode,
      providerCalls: 0,
      runtimeCostUsd: 0,
      outputPath,
      sha256: sha256(raw),
      rows: artifact.rows.length,
      browserHarness: artifact.browserHarness,
      proxy,
      budget,
    }, null, 2));
  } finally {
    await browser.close();
  }
} else {
  const liveResultPath = resolve(DEFAULT_LIVE_OUTPUT);
  const liveEvidence = existsSync(liveResultPath)
    ? compileLiveLayoutRecoveryEvidence(readFileSync(liveResultPath, 'utf8'))
    : null;
  console.log(JSON.stringify({
    ok: true,
    evidenceMode: 'offline_hash_bound_recovery_verification',
    providerCalls: 0,
    runtimeCostUsd: 0,
    feedbackArtifactVerified: true,
    feedbackSha256: evidence.feedbackSha256,
    feedbackRows: evidence.artifact.rows.length,
    liveResultVerified: liveEvidence !== null,
    liveEvidence,
    proxy,
    budget,
    requiresAuthorizedLiveStudy: liveEvidence === null,
  }, null, 2));
}

async function createIsolatedBrowserHarness(url: string): Promise<{
  harness: M1PipelineStudyHarness;
  close(): Promise<void>;
}> {
  const target = new URL(url);
  if (target.protocol !== 'http:' || !isLoopback(target.hostname) ||
      target.pathname !== '/dev/board' || target.username || target.password) {
    throw new Error('F9 feedback collection only accepts http://localhost:<port>/dev/board.');
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let externalRequestCount = 0;
  await context.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== target.origin) {
      externalRequestCount += 1;
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket('**/*', async (socket) => {
    const socketUrl = new URL(socket.url());
    if (socketUrl.host !== target.host || !['ws:', 'wss:'].includes(socketUrl.protocol)) {
      externalRequestCount += 1;
      await socket.close({ code: 1008, reason: 'Only the local F9 harness is allowed.' });
      return;
    }
    socket.connectToServer();
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input.url;
      const requestUrl = new URL(raw, location.href);
      if (requestUrl.pathname === '/api/auth/session' && requestUrl.origin === location.origin) {
        return Promise.resolve(new Response(JSON.stringify({ required: false, authenticated: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      }
      return nativeFetch(input, init);
    };
  });
  try {
    await page.goto(target.href, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const host = globalThis as typeof globalThis & {
        nouraPreflightScene?: unknown;
        nouraRenderScene?: unknown;
      };
      return typeof host.nouraPreflightScene === 'function' && typeof host.nouraRenderScene === 'function';
    }, undefined, { timeout: 30_000 });
    const final = new URL(page.url());
    if (final.origin !== target.origin || final.pathname !== '/dev/board') {
      throw new Error('Browser did not remain on the exact local board-harness origin and path.');
    }
  } catch (error) {
    await browser.close();
    throw error;
  }
  return {
    harness: {
      origin: target.origin,
      path: '/dev/board',
      validate: (ops) => validateOnPage(page, ops),
      render: (ops, semanticGroupId) => renderOnPage(page, ops, semanticGroupId),
      browserState: () => {
        const final = new URL(page.url());
        return {
          finalOrigin: final.origin,
          finalPath: final.pathname,
          externalRequestCount,
        };
      },
    },
    close: () => browser.close(),
  };
}

async function validateOnPage(page: Page, ops: BoardOp[]) {
  return page.evaluate(async (candidateOps) => {
    const hook = (globalThis as typeof globalThis & {
      nouraPreflightScene?: (ops: BoardOp[]) => Promise<LayoutPreflightResult>;
    }).nouraPreflightScene;
    if (!hook) throw new Error('Board preflight hook is unavailable.');
    const verdict = await hook(candidateOps);
    return verdict.accepted
      ? { ok: true as const }
      : { ok: false as const, issues: verdict.reasons, layoutIssues: verdict.layoutIssues };
  }, ops);
}

async function renderOnPage(page: Page, ops: BoardOp[], semanticGroupId?: string) {
  return page.evaluate(async (input) => {
    const hook = (globalThis as typeof globalThis & {
      nouraRenderScene?: (ops: BoardOp[], groupId?: string) => Promise<string | null>;
    }).nouraRenderScene;
    if (!hook) throw new Error('Board render hook is unavailable.');
    return hook(input.ops, input.semanticGroupId);
  }, { ops, semanticGroupId });
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

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, value, { flag: 'wx' });
  const descriptor = openSync(temporaryPath, 'r');
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporaryPath, path);
}
