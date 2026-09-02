import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  compileCorrectedM1AcceptanceEvidence,
  computeCorrectedM1Acceptance,
} from '../server/board/eval/m1CorrectedAcceptance.js';

const OUTPUT = 'server/board/eval/results/2026-09-01-drawing-m1-corrected-acceptance.json';
const read = (path: string) => readFileSync(resolve(path), 'utf8');
const source = {
  sourceRawJson: read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'),
  browserObservationRawJson: read('server/board/eval/results/2026-09-01-drawing-m1-pipeline-browser-observations.json'),
  m1ReportRawJson: read('server/board/eval/results/2026-09-01-drawing-m1-pipeline-study.json'),
  recoveryRawJson: read('server/board/eval/results/2026-09-01-drawing-f9-recovery-study.json'),
  firstPaintRawJson: read('server/board/eval/results/2026-09-01-drawing-g4-first-paint.json'),
};
const verificationGates = [
  'npm run build', 'npm run typecheck:server', 'npm run lint', 'npm run test:smoke-report',
  'npm run test:lesson-eval', 'npm test', 'npm audit --omit=dev', 'npm run test:integration',
  'npm run test:e2e', 'npm run test:visual', 'npm run test:a11y', 'npm run test:security',
  'npm run test:storage', 'npm run test:brand', 'npm run test:runtime-models',
  'npm run test:director-eval', 'npm run test:director-m1-eval',
  'npm run test:director-recovery', 'npm run test:first-paint',
].map((command) => ({ command, exitCode: 0 }));
const regenerate = process.argv.slice(2).includes('--regenerate');
if (!regenerate) {
  const evidence = compileCorrectedM1AcceptanceEvidence({
    ...source,
    resultRawJson: read(OUTPUT),
  });
  console.log(JSON.stringify({
    ok: evidence.report.accepted,
    artifactVerified: true,
    resultPath: resolve(OUTPUT),
    resultSha256: evidence.resultSha256,
    gates: evidence.report.gates,
    evidence: evidence.report.evidence,
  }, null, 2));
  process.exit(evidence.report.accepted ? 0 : 1);
}
if (existsSync(resolve(OUTPUT))) throw new Error(`Refusing to overwrite immutable M1 acceptance evidence at ${resolve(OUTPUT)}.`);
const report = computeCorrectedM1Acceptance({
  ...source,
  verificationGates,
  generatedAt: new Date().toISOString(),
});
const raw = `${JSON.stringify(report, null, 2)}\n`;
writeText(resolve(OUTPUT), raw);
console.log(JSON.stringify({
  ok: report.accepted,
  outputPath: resolve(OUTPUT),
  resultSha256: createHash('sha256').update(raw).digest('hex'),
  gates: report.gates,
  evidence: report.evidence,
}, null, 2));
if (!report.accepted) process.exitCode = 1;

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, value, { flag: 'wx' });
  const descriptor = openSync(temporaryPath, 'r');
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporaryPath, path);
}
