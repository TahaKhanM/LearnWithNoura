import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  compileM3MechanismAcceptanceEvidence,
  computeM3MechanismAcceptance,
} from '../server/board/eval/m3MechanismAcceptance.js';

const OUTPUT = resolve('server/board/eval/results/2026-09-02-drawing-m3-mechanism-acceptance.json');
const read = (path: string) => readFileSync(resolve(path), 'utf8');
const sources = {
  m0RawJson: read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'),
  m1BrowserRawJson: read('server/board/eval/results/2026-09-01-drawing-m1-pipeline-browser-observations.json'),
  m1ReportRawJson: read('server/board/eval/results/2026-09-01-drawing-m1-pipeline-study.json'),
  recoveryRawJson: read('server/board/eval/results/2026-09-01-drawing-f9-recovery-study.json'),
  fixtureRawJson: read('server/board/eval/fixtures/m3-template-routing-fixtures.json'),
  browserRawJson: read('server/board/eval/results/2026-09-02-drawing-m3-template-browser.json'),
  matrixRawJson: read('server/board/eval/curriculum-matrix.json'),
  templateLaneSource: read('server/board/templateLane.ts'),
  streamingDirectorSource: read('server/board/streamingDirector.ts'),
  visualRequestsSource: read('server/realtime/visualRequests.ts'),
  screenshots: {
    numberLine: readFileSync(resolve('artifacts/evaluation/drawing-m3-templates/number-line.jpg')),
    fractionStrips: readFileSync(resolve('artifacts/evaluation/drawing-m3-templates/fraction-strips.jpg')),
    plottedGraph: readFileSync(resolve('artifacts/evaluation/drawing-m3-templates/plotted-graph.jpg')),
  },
};
if (existsSync(OUTPUT)) {
  const evidence = compileM3MechanismAcceptanceEvidence({
    ...sources,
    resultRawJson: read(OUTPUT),
  });
  console.log(JSON.stringify({
    ok: evidence.report.accepted,
    artifactVerified: true,
    resultSha256: evidence.resultSha256,
    mechanism: evidence.report.mechanism,
    openSetGenerative: evidence.report.openSetGenerative,
    blendedFirstPassGate: evidence.report.blendedFirstPassGate,
  }, null, 2));
  process.exit(evidence.report.accepted ? 0 : 1);
}
if (!process.argv.slice(2).includes('--regenerate')) throw new Error('Missing immutable M3 evidence; regeneration requires --regenerate.');
const report = computeM3MechanismAcceptance({ ...sources, generatedAt: new Date().toISOString() });
const raw = `${JSON.stringify(report, null, 2)}\n`;
const temporary = `${OUTPUT}.tmp-${process.pid}`;
writeFileSync(temporary, raw, { flag: 'wx' });
const descriptor = openSync(temporary, 'r');
try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
renameSync(temporary, OUTPUT);
console.log(JSON.stringify({
  ok: report.accepted,
  outputPath: OUTPUT,
  resultSha256: createHash('sha256').update(raw).digest('hex'),
  mechanism: report.mechanism,
  openSetGenerative: report.openSetGenerative,
  blendedFirstPassGate: report.blendedFirstPassGate,
}, null, 2));
if (!report.accepted) process.exitCode = 1;
