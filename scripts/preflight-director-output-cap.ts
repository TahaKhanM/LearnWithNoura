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
import { runLiveOutputCapPreflight } from '../server/board/eval/liveOutputCapPreflight.js';

const argv = process.argv.slice(2);
let outputPath: string | null = null;
let priorReservedUsd = 0;
const intentIds: string[] = [];
const conditionIds: string[] = [];
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
  } else if (argv[index] === '--intent' || argv[index] === '--condition') {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    (flag === '--intent' ? intentIds : conditionIds).push(value);
    index += 1;
  } else authorizationArgs.push(argv[index]);
}

const authorization = parseDirectorEvalAuthorization(authorizationArgs);
if (!authorization.authorizedLiveRun) {
  throw new Error('Output-cap preflight requires --authorized-live-run and explicit user authorization.');
}
const apiKey = process.env.OPENAI_API_KEY;
const harnessUrl = process.env.NOURA_BOARD_HARNESS_URL;
if (!apiKey) throw new Error('OPENAI_API_KEY is required for the authorized output-cap preflight.');
if (!harnessUrl) throw new Error('NOURA_BOARD_HARNESS_URL is required for the authorized output-cap preflight.');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runId = `director-cap-preflight-${stamp}`;
const target = outputPath ?? resolve(`server/board/eval/results/director-cap-preflight-${stamp}.json`);
const partialPath = `${target}.partial.ndjson`;
if (existsSync(target) || existsSync(partialPath)) {
  throw new Error(`Output-cap preflight evidence already exists; choose a new --output path: ${target}`);
}
mkdirSync(dirname(partialPath), { recursive: true });
appendRecord(partialPath, {
  kind: 'run_started', runId, startedAt: new Date().toISOString(),
  maxSpendUsd: authorization.maxSpendUsd, priorReservedUsd,
});
let lastSpendEvent: unknown = null;
try {
  const report = await runLiveOutputCapPreflight({
    client: new OpenAI({ apiKey }),
    harnessUrl,
    maxSpendUsd: authorization.maxSpendUsd,
    priorReservedUsd,
    runId,
    ...(intentIds.length > 0 ? { intentIds } : {}),
    ...(conditionIds.length > 0 ? { conditionIds } : {}),
    onProgress: (message) => console.error(message),
    onCheckpoint: (trial) => appendRecord(partialPath, { kind: 'trial', trial }),
    onSpendEvent: (event) => {
      lastSpendEvent = event;
      appendRecord(partialPath, { kind: 'spend', event });
    },
  });
  writeJson(target, report);
  appendRecord(partialPath, {
    kind: 'run_completed', runId, completedAt: new Date().toISOString(),
    providerCalls: report.providerCalls,
    accountedCostUsd: report.accountedCostUsd,
  });
  console.log(JSON.stringify({
    ok: report.pass,
    providerCalls: report.providerCalls,
    trialCount: report.trials.length,
    estimatedCostUsd: report.estimatedCostUsd,
    accountedCostUsd: report.accountedCostUsd,
    outputPath: target,
    partialPath,
  }, null, 2));
} catch (error) {
  const failure = {
    schemaVersion: '1.0.0',
    pass: false,
    evidenceMode: 'authorized_live_synthetic_output_cap_preflight_incomplete',
    runId,
    maxSpendUsd: authorization.maxSpendUsd,
    priorReservedUsd,
    error: String(error instanceof Error ? error.message : error).slice(0, 500),
    lastSpendEvent,
    partialPath,
  };
  appendRecord(partialPath, {
    kind: 'run_failed', runId, failedAt: new Date().toISOString(),
    error: failure.error, lastSpendEvent,
  });
  writeJson(target, failure);
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  const descriptor = openSync(temporaryPath, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
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
