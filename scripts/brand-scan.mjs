import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Git supplies the same tracked/unignored source set on developer machines and CI.
// Do not require an undeclared system search utility for a Node project check.
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});
if (listed.error) throw listed.error;
if (listed.status !== 0) {
  process.stderr.write(listed.stderr);
  process.exit(1);
}
const migrationFiles = new Set(['server/store/db.ts', 'server/store/db.test.ts', '.env.example']);
const failures = [];
for (const path of new Set(listed.stdout.split('\0').filter(Boolean))) {
  if (migrationFiles.has(path) || path.startsWith('docs/legacy/') || path.startsWith('docs/traceability/')) continue;
  let data;
  try { data = readFileSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') continue; // a tracked deletion in the working tree
    throw error;
  }
  if (data.includes(0)) continue; // binary assets are not active product copy
  let source = data.toString('utf8');
  if (path === 'README.md') {
    // Retain one explicit provenance statement, not a blanket README exemption.
    source = source.replace('This project began as **S' + 'eneca**,', '');
  }
  if (/s[e]neca/i.test(source)) failures.push(path);
}
if (failures.length) {
  console.error('Brand scan failed: unapproved legacy product references in:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('Brand scan passed: no unapproved legacy product references.');
