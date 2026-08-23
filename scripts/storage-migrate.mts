import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresStore, type StorageSnapshot } from '../server/store/portable';

const [command, file] = process.argv.slice(2);
if (!command || !file || !['export', 'verify', 'import'].includes(command)) {
  throw new Error('Usage: tsx scripts/storage-migrate.mts <export|verify|import> <snapshot.json>');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; no database was created automatically.');
const store = new PostgresStore(new Pool({ connectionString: databaseUrl, max: 4 }));
await store.initialize();
if (command === 'import') {
  const snapshot = JSON.parse(await readFile(file, 'utf8')) as StorageSnapshot;
  const counts = await store.importSnapshot(snapshot);
  console.log(JSON.stringify({ ok: true, counts }));
} else if (command === 'export') {
  const snapshot = await store.exportSnapshot();
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, counts: await store.counts() }));
} else {
  const snapshot = JSON.parse(await readFile(file, 'utf8')) as StorageSnapshot;
  const actual = await store.counts();
  const expected = { children: snapshot.children.length, sessions: snapshot.sessions.length, events: snapshot.events.length, evidence: snapshot.evidence.length };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Storage counts differ: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(JSON.stringify({ ok: true, counts: actual }));
}
await store.close();
