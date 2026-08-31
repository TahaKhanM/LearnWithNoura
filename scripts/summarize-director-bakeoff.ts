import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileDirectorBakeoffDecisionEvidence } from '../server/board/eval/decisionEvidence.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  console.log(`Usage:
  npx tsx scripts/summarize-director-bakeoff.ts <completed-raw.json>
  npx tsx scripts/summarize-director-bakeoff.ts <completed-raw.json> --json

Validates and independently reproduces the completed M0 decisions, then writes
copy-ready Markdown (default) or structured decision inputs (--json) to stdout.
It does not create or modify the architecture decision record.`);
  process.exit(args.length === 0 ? 1 : 0);
}

const jsonOutput = args.includes('--json');
const paths = args.filter((arg) => arg !== '--json');
if (paths.length !== 1 || args.some((arg) => arg.startsWith('--') && arg !== '--json')) {
  throw new Error('Provide exactly one completed raw JSON path and optional --json.');
}
const sourcePath = paths[0];
const absolutePath = resolve(sourcePath);
const rawJson = readFileSync(absolutePath, 'utf8');
const evidence = compileDirectorBakeoffDecisionEvidence(rawJson, { rawEvidencePath: sourcePath });
console.log(jsonOutput ? JSON.stringify(evidence, null, 2) : evidence.markdown);
