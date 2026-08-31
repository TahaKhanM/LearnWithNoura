import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import OpenAI from 'openai';
import { parseDirectorEvalAuthorization } from '../server/board/eval/authorization.js';
import { runLiveDirectorEval } from '../server/board/eval/liveDirectorEval.js';
import { runOfflineDirectorEval } from '../server/board/eval/runDirectorEval.js';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(`Usage:
  npm run test:director-eval
  npm run test:director-eval -- --authorized-live-run [--max-spend-usd 30] [--output path]

The default is deterministic and offline. Live mode requires the explicit
authorization flag, OPENAI_API_KEY, and a reachable NOURA_BOARD_HARNESS_URL.
It uses synthetic fixtures only and enforces a hard $30 ceiling.`);
  process.exit(0);
}

let outputPath: string | null = null;
const authorizationArgs: string[] = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--output') {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--output requires a path.');
    outputPath = resolve(value);
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
  const target = outputPath ?? resolve(`server/board/eval/results/director-bakeoff-${stamp}.json`);
  const partialPath = `${target}.partial.ndjson`;
  try {
    const report = await runLiveDirectorEval({
      client: new OpenAI({ apiKey }),
      harnessUrl,
      maxSpendUsd: authorization.maxSpendUsd,
      onProgress: (message) => console.error(message),
      onCheckpoint: (checkpoint) => {
        mkdirSync(dirname(partialPath), { recursive: true });
        appendFileSync(partialPath, `${JSON.stringify(checkpoint)}\n`);
      },
    });
    writeJson(target, report);
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
      partialPath,
    };
    writeJson(target, failure);
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
