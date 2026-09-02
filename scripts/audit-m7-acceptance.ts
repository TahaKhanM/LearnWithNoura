import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileM7AcceptanceEvidence } from '../server/board/eval/m7Acceptance.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const curriculumResultRawJson = read('server/board/eval/results/2026-09-03-drawing-m7-curriculum-browser-verified.json');
const curriculumResult = JSON.parse(curriculumResultRawJson) as { rows: Array<{ rowId: string; screenshotPath: string }>; contactSheets: Array<{ path: string }> };
const evidence = compileM7AcceptanceEvidence({
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
  resultRawJson: read('server/board/eval/results/2026-09-03-drawing-m7-acceptance.json'),
});
console.log(JSON.stringify({
  artifactVerified: true,
  resultSha256: evidence.resultSha256,
  technicalAccepted: evidence.report.technicalAccepted,
  processCompliant: evidence.report.processCompliant,
  accepted: evidence.report.accepted,
  blockers: evidence.report.blockers,
  curriculum: evidence.report.curriculum,
  relational: evidence.report.relational,
  grounding: evidence.report.grounding,
  g4: evidence.report.g4,
}, null, 2));
