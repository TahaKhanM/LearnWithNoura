import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseLessonEvalAuthorization } from '../server/lesson/eval/authorization.js';
import { runOfflineLessonEval } from '../server/lesson/eval/runLessonEval.js';

const argv = process.argv.slice(2);
const auth = parseLessonEvalAuthorization(argv);
const outputArg = argv.find((arg) => !arg.startsWith('-'));
const outputDir = resolve(outputArg ?? 'artifacts/evaluation');
mkdirSync(outputDir, { recursive: true });

if (auth.authorizedLiveRun) {
  console.error(JSON.stringify({
    ok: false,
    error: 'Live lesson evaluation is not implemented; remove --authorized-live-run or use the authorized smoke reporter.',
    liveSessionBudget: auth.liveSessionBudget,
  }, null, 2));
  process.exit(1);
}

const report = runOfflineLessonEval();
const reportPath = join(outputDir, 'lesson-eval-report.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
  ok: report.pass,
  reportPath,
  gateCount: report.gates.length,
  gates: report.gates.map((gate) => ({
    dimension: gate.dimension,
    fixtureLabel: gate.fixtureLabel,
    pass: gate.pass,
    expectPass: gate.expectPass,
    scorerPass: gate.details.pass,
  })),
}, null, 2));

if (!report.pass) process.exit(1);
