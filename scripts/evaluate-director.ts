import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import OpenAI from 'openai';
import { parseDirectorEvalAuthorization } from '../server/board/eval/authorization.js';
import { runLiveDirectorEval } from '../server/board/eval/liveDirectorEval.js';
import { runOfflineDirectorEval } from '../server/board/eval/runDirectorEval.js';
import {
  loadDirectorResumeEvidence,
  mergeDirectorResumeEvidence,
} from '../server/board/eval/resumeEvidence.js';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(`Usage:
  npm run test:director-eval
  npm run test:director-eval -- --authorized-live-run [--max-spend-usd 30] [--prior-reserved-usd 0] [--resume-from partial.ndjson] [--output path]

The default is deterministic and offline. Live mode requires the explicit
authorization flag, OPENAI_API_KEY, and a reachable NOURA_BOARD_HARNESS_URL.
It uses synthetic fixtures only and enforces a hard $30 ceiling.`);
  process.exit(0);
}

let outputPath: string | null = null;
let priorReservedUsd = 0;
const resumeFromPaths: string[] = [];
const authorizationArgs: string[] = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--output') {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--output requires a path.');
    outputPath = resolve(value);
    index += 1;
  } else if (argv[index] === '--prior-reserved-usd') {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--prior-reserved-usd requires a value.');
    priorReservedUsd = Number(value);
    if (!Number.isFinite(priorReservedUsd) || priorReservedUsd < 0) {
      throw new Error('--prior-reserved-usd must be a finite non-negative number.');
    }
    index += 1;
  } else if (argv[index] === '--resume-from') {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--resume-from requires a path.');
    resumeFromPaths.push(resolve(value));
    index += 1;
  } else {
    authorizationArgs.push(argv[index]);
  }
}

const authorization = parseDirectorEvalAuthorization(authorizationArgs);
if (!authorization.authorizedLiveRun) {
  const report = runOfflineDirectorEval();
  const target = outputPath ?? resolve('artifacts/evaluation/director-eval-report.json');
  writeJson(target, report);
  console.log(JSON.stringify({
    ok: report.pass,
    evidenceMode: report.evidenceMode,
    providerCalls: report.providerCalls,
    runtimeCostUsd: report.runtimeCostUsd,
    trialCount: report.trials.length,
    outputPath: target,
    compositionDecision: report.compositionDecision,
    visionAudit: report.visionAudit,
    sketchGrounding: report.sketchGrounding,
  }, null, 2));
  if (!report.pass) process.exitCode = 1;
} else {
  const apiKey = process.env.OPENAI_API_KEY;
  const harnessUrl = process.env.NOURA_BOARD_HARNESS_URL;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for an authorized live Director evaluation.');
  if (!harnessUrl) throw new Error('NOURA_BOARD_HARNESS_URL is required for raster validation in an authorized live Director evaluation.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `director-eval-${stamp}`;
  const target = outputPath ?? resolve(`server/board/eval/results/director-bakeoff-${stamp}.json`);
  const partialPath = `${target}.partial.ndjson`;
  if (existsSync(target) || existsSync(partialPath)) {
    throw new Error(`Live evidence output already exists; choose a new --output path: ${target}`);
  }
  mkdirSync(dirname(partialPath), { recursive: true });
  const resumeEvidence = resumeFromPaths.length > 0
    ? mergeDirectorResumeEvidence(resumeFromPaths.map(loadDirectorResumeEvidence))
    : null;
  appendRecord(partialPath, {
    kind: 'run_started',
    runId,
    startedAt: new Date().toISOString(),
    maxSpendUsd: authorization.maxSpendUsd,
    priorReservedUsd,
    sessionHardCapUsd: 30,
    combinedMaximumUsd: Math.round((priorReservedUsd + authorization.maxSpendUsd) * 1e10) / 1e10,
    resumedEvidence: resumeEvidence?.metadata ?? null,
    evidenceMode: 'authorized_live_synthetic',
  });
  let lastSpendEvent: unknown = null;
  try {
    const report = await runLiveDirectorEval({
      client: new OpenAI({ apiKey }),
      harnessUrl,
      maxSpendUsd: authorization.maxSpendUsd,
      priorReservedUsd,
      runId,
      ...(resumeEvidence ? { resumeEvidence } : {}),
      onProgress: (message) => console.error(message),
      onCheckpoint: (checkpoint) => {
        appendRecord(partialPath, { kind: 'trial', checkpoint });
      },
      onSpendEvent: (event) => {
        lastSpendEvent = event;
        appendRecord(partialPath, { kind: 'spend', event });
      },
    });
    writeJson(target, report);
    appendRecord(partialPath, {
      kind: 'run_completed',
      runId,
      completedAt: new Date().toISOString(),
      providerCalls: report.providerCalls,
      estimatedCostUsd: report.estimatedCostUsd,
      accountedCostUsd: report.accountedCostUsd,
      openReservationUsd: report.spendLedger.openReservationUsd,
    });
    console.log(JSON.stringify({
      ok: report.pass,
      evidenceMode: report.evidenceMode,
      providerCalls: report.providerCalls,
      estimatedCostUsd: report.estimatedCostUsd,
      accountedCostUsd: report.accountedCostUsd,
      outputPath: target,
      partialPath,
      compositionDecision: report.compositionDecision,
    }, null, 2));
    if (!report.pass) process.exitCode = 1;
  } catch (error) {
    const failure = {
      schemaVersion: '1.0.0',
      pass: false,
      evidenceMode: 'authorized_live_synthetic_incomplete',
      error: String(error instanceof Error ? error.message : error).slice(0, 500),
      runId,
      maxSpendUsd: authorization.maxSpendUsd,
      priorReservedUsd,
      lastSpendEvent,
      partialPath,
    };
    appendRecord(partialPath, {
      kind: 'run_failed',
      runId,
      failedAt: new Date().toISOString(),
      error: failure.error,
      lastSpendEvent,
    });
    writeJson(target, failure);
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  const descriptor = openSync(temporaryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
}

function appendRecord(path: string, value: unknown): void {
  const descriptor = openSync(path, 'a');
  try {
    writeSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
