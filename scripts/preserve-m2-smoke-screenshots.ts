import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const screenshots = [
  {
    source: '/tmp/noura-shots/e2e-teaching-2.png',
    output: 'artifacts/evaluation/drawing-m2-live-smoke-rerun-step2.png',
  },
  {
    source: '/tmp/noura-shots/e2e-teaching-3.png',
    output: 'artifacts/evaluation/drawing-m2-live-smoke-rerun-step3.png',
  },
];
const results = screenshots.map(({ source, output }) => {
  const outputPath = resolve(output);
  if (existsSync(outputPath)) throw new Error(`Refusing to overwrite retained smoke screenshot ${outputPath}.`);
  const data = readFileSync(source);
  writeFileSync(outputPath, data, { flag: 'wx' });
  return {
    path: output,
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
  };
});
console.log(JSON.stringify({ ok: true, screenshots: results }, null, 2));
