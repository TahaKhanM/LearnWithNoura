import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local persistence via Node's built-in SQLite. Durable across restarts
 * for a local demo without adding a native dependency. A deployed
 * serverless preview would need a managed database instead; that boundary
 * lives entirely in this directory.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SENECA_DATA_DIR || join(here, '..', '..', 'data');

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(join(DATA_DIR, 'seneca.db'));
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

/** In-memory database for tests. */
export function openTestDb(): DatabaseSync {
  const testDb = new DatabaseSync(':memory:');
  migrate(testDb);
  return testDb;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS children (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      age INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      child_id TEXT NOT NULL REFERENCES children(id),
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      summary_json TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);

    CREATE TABLE IF NOT EXISTS evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      ts INTEGER NOT NULL,
      concept TEXT NOT NULL,
      observation TEXT NOT NULL,
      verdict TEXT NOT NULL,
      confidence TEXT NOT NULL,
      excerpt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_session ON evidence(session_id, id);
  `);
}
