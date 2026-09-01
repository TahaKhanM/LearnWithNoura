import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import type { BoardOp } from '../shared/boardOps.js';
import { compileM1PipelineStudyEvidence } from '../server/board/eval/m1PipelineStudyEvidence.js';
import {
  collectM1BrowserObservations,
  M1_PIPELINE_STUDY_POLICY,
  m1EvidenceSha256,
  runM1PipelineStudy,
} from '../server/board/eval/m1PipelineStudy.js';
import type { M1PipelineStudyHarness } from '../server/board/eval/m1PipelineStudyTypes.js';

const DEFAULT_RESULT_PATH = 'server/board/eval/results/2026-09-01-drawing-m1-pipeline-study.json';
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(`Usage:
  npx tsx scripts/evaluate-director-m1.ts
  npx tsx scripts/evaluate-director-m1.ts --collect-observations --harness-url http://localhost:5180/dev/board
  npx tsx scripts/evaluate-director-m1.ts --regenerate --harness-url http://localhost:5180/dev/board

Default mode verifies the separately pinned browser ledger and derived report.
Browser modes permit loopback traffic only and contain no model client, model
credential lookup, paid-call flag, or remote-network fallback.`);
  process.exit(0);
}

let mode: 'verify' | 'collect' | 'regenerate' = 'verify';
let harnessUrl = '';
let resultPath = resolve(DEFAULT_RESULT_PATH);
let observationPath = resolve(M1_PIPELINE_STUDY_POLICY.browserObservationPath);
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === '--collect-observations') mode = exclusiveMode(mode, 'collect');
  else if (argument === '--regenerate') mode = exclusiveMode(mode, 'regenerate');
  else if (argument === '--harness-url') harnessUrl = requiredValue(argv, ++index, argument);
  else if (argument === '--output') resultPath = resolve(requiredValue(argv, ++index, argument));
  else if (argument === '--observations-output') {
    observationPath = resolve(requiredValue(argv, ++index, argument));
  } else throw new Error(`Unknown argument: ${argument}`);
}

const sourceRawJson = readFileSync(resolve(M1_PIPELINE_STUDY_POLICY.sourceEvidencePath), 'utf8');
if (mode === 'verify') {
  const browserObservationRawJson = readFileSync(observationPath, 'utf8');
  const resultRawJson = readFileSync(resultPath, 'utf8');
  const evidence = compileM1PipelineStudyEvidence(
    sourceRawJson, browserObservationRawJson, resultRawJson,
  );
  printEvidence(evidence, resultPath, observationPath);
} else {
  if (!harnessUrl) throw new Error(`${mode} requires an explicit --harness-url.`);
  const browserHarness = await createIsolatedBrowserHarness(harnessUrl);
  try {
    const observations = await collectM1BrowserObservations({
      sourceRawJson,
      harness: browserHarness.harness,
    });
    const browserObservationRawJson = `${JSON.stringify(observations, null, 2)}\n`;
    const observationSha256 = m1EvidenceSha256(browserObservationRawJson);
    if (mode === 'collect') {
      writeText(observationPath, browserObservationRawJson);
      console.log(JSON.stringify({
        ok: true,
        evidenceMode: observations.evidenceMode,
        providerCalls: 0,
        runtimeCostUsd: 0,
        browserObservationPath: observationPath,
        browserObservationSha256: observationSha256,
        pinnedSha256: M1_PIPELINE_STUDY_POLICY.browserObservationSha256,
        matchesPinnedPolicy: observationSha256 ===
          M1_PIPELINE_STUDY_POLICY.browserObservationSha256,
        browserHarness: observations.browserHarness,
      }, null, 2));
    } else {
      if (observationSha256 !== M1_PIPELINE_STUDY_POLICY.browserObservationSha256) {
        throw new Error(
          `Fresh browser observations do not match pinned SHA-256; collect and review them first. Observed ${observationSha256}.`,
        );
      }
      writeText(observationPath, browserObservationRawJson);
      const report = runM1PipelineStudy({ sourceRawJson, browserObservationRawJson });
      writeText(resultPath, `${JSON.stringify(report, null, 2)}\n`);
      const resultRawJson = readFileSync(resultPath, 'utf8');
      const evidence = compileM1PipelineStudyEvidence(
        sourceRawJson, browserObservationRawJson, resultRawJson,
      );
      printEvidence(evidence, resultPath, observationPath);
    }
  } finally {
    await browserHarness.close();
  }
}

async function createIsolatedBrowserHarness(url: string): Promise<{
  harness: M1PipelineStudyHarness;
  close(): Promise<void>;
}> {
  const target = new URL(url);
  if (target.protocol !== 'http:' || !isLoopback(target.hostname) ||
      target.pathname !== '/dev/board' || target.username || target.password) {
    throw new Error('Browser collection only accepts http://localhost:<port>/dev/board.');
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
      await socket.close({ code: 1008, reason: 'Only the local M1 harness is allowed.' });
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
      return typeof host.nouraPreflightScene === 'function' &&
        typeof host.nouraRenderScene === 'function';
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
      nouraPreflightScene?: (ops: BoardOp[]) => Promise<{ accepted: boolean; reasons: string[] }>;
    }).nouraPreflightScene;
    if (!hook) throw new Error('Board preflight hook is unavailable.');
    const verdict = await hook(candidateOps);
    return verdict.accepted ? { ok: true as const } : { ok: false as const, issues: verdict.reasons };
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

function printEvidence(
  evidence: ReturnType<typeof compileM1PipelineStudyEvidence>,
  resultPath: string,
  browserObservationPath: string,
): void {
  console.log(JSON.stringify({
    ok: true,
    artifactVerified: true,
    m1AcceptancePass: evidence.report.pass,
    pairedDeliveryNonInferiorityPass: evidence.report.summary.deliveryPathStudyPass,
    providerCalls: evidence.report.providerCalls,
    runtimeCostUsd: evidence.report.runtimeCostUsd,
    sourceSha256: evidence.sourceSha256,
    browserObservationSha256: evidence.browserObservationSha256,
    resultSha256: evidence.resultSha256,
    resultPath,
    browserObservationPath,
    summary: evidence.report.summary,
  }, null, 2));
}

function exclusiveMode(current: typeof mode, next: Exclude<typeof mode, 'verify'>): typeof mode {
  if (current !== 'verify') throw new Error('Choose only one browser mode.');
  return next;
}
function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}
function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
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
