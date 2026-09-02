import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileM2LiveSmokeEvidence } from '../server/board/eval/m2LiveSmokeEvidence.js';
import { compileM2LiveSmokeRerunEvidence } from '../server/board/eval/m2LiveSmokeRerunEvidence.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const evidence = compileM2LiveSmokeEvidence({
  resultRawJson: read('server/board/eval/results/2026-09-02-drawing-m2-live-smoke.json'),
  sceneRawJson: read('server/board/eval/fixtures/m2-live-smoke-directed-scene.json'),
  correctedScreenshot: readFileSync(resolve('artifacts/evaluation/drawing-m2-live-smoke-corrected.jpg')),
});
const rerun = compileM2LiveSmokeRerunEvidence({
  resultRawJson: read('server/board/eval/results/2026-09-02-drawing-m2-live-smoke-rerun.json'),
  sceneRawJson: read('server/board/eval/fixtures/m2-live-smoke-rerun-directed-scene.json'),
  liveStep2Screenshot: readFileSync(resolve('artifacts/evaluation/drawing-m2-live-smoke-rerun-step2.png')),
  liveStep3Screenshot: readFileSync(resolve('artifacts/evaluation/drawing-m2-live-smoke-rerun-step3.png')),
  fullTerminalScreenshot: readFileSync(resolve('artifacts/evaluation/drawing-m2-live-smoke-rerun-full.jpg')),
});
console.log(JSON.stringify({
  ok: rerun.report.accepted,
  artifactVerified: true,
  initialQualityRejectionPreserved: !evidence.report.accepted,
  liveAcceptance: rerun.report.accepted,
  acceptanceScope: rerun.report.acceptanceScope,
  initialResultSha256: evidence.resultSha256,
  rerunResultSha256: rerun.resultSha256,
  providerUsage: rerun.report.providerUsage,
  quality: rerun.report.quality,
  evidenceBoundary: rerun.report.evidenceBoundary,
}, null, 2));
