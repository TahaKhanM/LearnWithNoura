import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { computeM7Acceptance } from '../server/board/eval/m7Acceptance.js';

const OUTPUT = resolve('server/board/eval/results/2026-09-03-drawing-m7-acceptance.json');
if (existsSync(OUTPUT)) throw new Error('Refusing to overwrite immutable M7 acceptance evidence.');
const read = (path: string) => readFileSync(resolve(path), 'utf8');
const curriculumResultRawJson = read('server/board/eval/results/2026-09-03-drawing-m7-curriculum-browser-verified.json');
const curriculumResult = JSON.parse(curriculumResultRawJson) as { rows: Array<{ rowId: string; screenshotPath: string }>; contactSheets: Array<{ path: string }> };
const report = computeM7Acceptance({
  curriculum: {
    matrixRawJson: read('server/board/eval/curriculum-matrix-m7.json'),
    baselineFixturesRawJson: read('server/board/eval/fixtures/curriculum-matrix-scenes.json'),
    m7FixturesRawJson: read('server/board/eval/fixtures/m7-curriculum-new-scenes.json'),
    resultRawJson: curriculumResultRawJson,
    screenshots: Object.fromEntries(curriculumResult.rows.map((row) => [row.rowId, readFileSync(resolve(row.screenshotPath))])),
    contactSheets: curriculumResult.contactSheets.map((sheet) => readFileSync(resolve(sheet.path))),
  },
  m0RawJson: read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'),
  relationalResultRawJson: read('server/board/eval/results/2026-09-03-drawing-m7-relational-m0-replay-accepted.json'),
  groundingFixtureRawJson: read('server/board/eval/fixtures/m7-image-grounding-study.json'),
  groundingResultRawJson: read('server/board/eval/results/2026-09-02-drawing-m7-image-grounding-study.json'),
  groundingLedgerRawJsonl: read('server/board/eval/results/2026-09-02-drawing-m7-image-grounding-study.ledger.jsonl'),
  previousG4RawJson: read('server/board/eval/results/2026-09-01-drawing-g4-first-paint.json'),
  m7G4RawJson: read('server/board/eval/results/2026-09-03-drawing-m7-g4-first-paint.json'),
  m7G4StreamingScreenshot: readFileSync(resolve('artifacts/evaluation/drawing-m7-g4-first-paint/streaming-first-paint.png')),
  m7G4ClassicScreenshot: readFileSync(resolve('artifacts/evaluation/drawing-m7-g4-first-paint/classic-first-paint.png')),
  incidentRawJson: read('server/board/eval/results/2026-09-03-m7-g4-harness-provider-incident.json'),
  fastTierUnitSource: read('server/realtime/proxy.test.ts'),
  fastTierE2ESource: read('tests/e2e/interaction-lifecycle.spec.ts'),
  fastTierScreenshot: readFileSync(resolve('artifacts/evaluation/drawing-m7-fast-annotations.png')),
  generatedAt: new Date().toISOString(),
});
const raw = `${JSON.stringify(report, null, 2)}\n`;
const descriptor = openSync(OUTPUT, 'wx');
try { writeFileSync(descriptor, raw); fsyncSync(descriptor); } finally { closeSync(descriptor); }
console.log(JSON.stringify({
  technicalAccepted: report.technicalAccepted,
  accepted: report.accepted,
  blockers: report.blockers,
  outputPath: OUTPUT,
  resultSha256: createHash('sha256').update(raw).digest('hex'),
}, null, 2));
