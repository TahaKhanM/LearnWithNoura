import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileImageGroundingStudyEvidence } from '../server/board/eval/imageGroundingEvidence.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const evidence = compileImageGroundingStudyEvidence({
  fixtureRawJson: read('server/board/eval/fixtures/m7-image-grounding-study.json'),
  resultRawJson: read('server/board/eval/results/2026-09-02-drawing-m7-image-grounding-study.json'),
  ledgerRawJsonl: read('server/board/eval/results/2026-09-02-drawing-m7-image-grounding-study.ledger.jsonl'),
});
console.log(JSON.stringify({
  ok: evidence.accepted,
  resultSha256: evidence.resultSha256,
  ledgerSha256: evidence.ledgerSha256,
  metrics: evidence.metrics,
  spend: evidence.spend,
  scope: evidence.scope,
}, null, 2));
if (!evidence.accepted) process.exitCode = 1;
