import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'rg',
  [
    '-n',
    '-i',
    '--hidden',
    '-g',
    '!node_modules/**',
    '-g',
    '!dist/**',
    '-g',
    '!.git/**',
    '-g',
    '!docs/legacy/**',
    '-g',
    '!docs/traceability/**',
    '-g',
    '!server/store/db.ts',
    '-g',
    '!server/store/db.test.ts',
    '-g',
    '!.env.example',
    's[e]neca',
    '.',
  ],
  { encoding: 'utf8' },
);

if (result.error) throw result.error;
if (result.status === 1) {
  console.log('Brand scan passed: no unapproved legacy product references.');
  process.exit(0);
}

if (result.stdout) process.stderr.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.stderr.write(
  'Brand scan failed. Move truthful immutable/history or migration references under docs/legacy or docs/traceability, and rename every active product reference.\n',
);
process.exit(1);
