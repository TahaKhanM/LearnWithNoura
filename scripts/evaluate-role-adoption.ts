import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildM2RoleAdoptionEvidence,
  compileM2RoleAdoptionEvidence,
} from '../server/board/eval/roleAdoptionEvidence.js';

const OUTPUT = resolve('server/board/eval/results/2026-09-02-drawing-m2-role-adoption.json');
const read = (path: string) => readFileSync(resolve(path), 'utf8');
if (existsSync(OUTPUT)) {
  const evidence = compileM2RoleAdoptionEvidence({
    m0RawJson: read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'),
    recoveryRawJson: read('server/board/eval/results/2026-09-01-drawing-f9-recovery-study.json'),
    resultRawJson: read(OUTPUT),
  });
  console.log(JSON.stringify({
    ok: true,
    artifactVerified: true,
    providerCalls: 0,
    resultSha256: evidence.resultSha256,
    report: evidence.report,
  }, null, 2));
  process.exit(0);
}
if (!process.argv.slice(2).includes('--regenerate')) throw new Error('Missing immutable M2 evidence; pass --regenerate only after all offline gates are green.');
const report = buildM2RoleAdoptionEvidence({
  m0RawJson: read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'),
  recoveryRawJson: read('server/board/eval/results/2026-09-01-drawing-f9-recovery-study.json'),
  generatedAt: new Date().toISOString(),
});
const raw = `${JSON.stringify(report, null, 2)}\n`;
const temporaryPath = `${OUTPUT}.tmp-${process.pid}`;
writeFileSync(temporaryPath, raw, { flag: 'wx' });
const descriptor = openSync(temporaryPath, 'r');
try { fsyncSync(descriptor); }
finally { closeSync(descriptor); }
renameSync(temporaryPath, OUTPUT);
console.log(JSON.stringify({
  ok: report.contracts.strictProductionStepSchema && !report.contracts.piiSentinelEscaped,
  outputPath: OUTPUT,
  resultSha256: createHash('sha256').update(raw).digest('hex'),
  report,
}, null, 2));
