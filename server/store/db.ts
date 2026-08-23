import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local persistence via Node's built-in SQLite. Durable across restarts
 * for a local demo without adding a native dependency. A deployed
 * serverless preview would need a managed database instead; that boundary
 * lives entirely in this directory.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = join(here, '..', '..', 'data');

export interface DatabaseLocation {
  dataDir: string;
  databasePath: string;
  legacyAliasUsed: boolean;
  migratedLegacyDatabase: boolean;
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const location = prepareDatabaseLocation();
  db = new DatabaseSync(location.databasePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** In-memory database for tests. */
export function openTestDb(): DatabaseSync {
  const testDb = new DatabaseSync(':memory:');
  testDb.exec('PRAGMA foreign_keys = ON');
  migrate(testDb);
  return testDb;
}

/**
 * Resolves the active Noura database and performs the one-window legacy-file
 * migration. The old file and a verified backup are intentionally retained.
 */
export function prepareDatabaseLocation(env: NodeJS.ProcessEnv = process.env): DatabaseLocation {
  const legacyAliasUsed = !env.NOURA_DATA_DIR && Boolean(env.SENECA_DATA_DIR);
  const dataDir = env.NOURA_DATA_DIR || env.SENECA_DATA_DIR || DEFAULT_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });

  const databasePath = join(dataDir, 'noura.db');
  const legacyPath = join(dataDir, 'seneca.db');
  let migratedLegacyDatabase = false;

  if (!existsSync(databasePath) && existsSync(legacyPath)) {
    const backupPath = join(dataDir, 'seneca.db.noura-migration.bak');
    const candidatePath = join(dataDir, 'noura.db.migrating');
    const legacy = new DatabaseSync(legacyPath);
    try {
      legacy.exec('PRAGMA wal_checkpoint(FULL)');
      assertIntegrity(legacy, 'legacy database');
      const expectedCounts = tableCounts(legacy);
      if (!existsSync(backupPath)) copyFileSync(legacyPath, backupPath);
      copyFileSync(legacyPath, candidatePath);
      const candidate = new DatabaseSync(candidatePath);
      try {
        assertIntegrity(candidate, 'migration candidate');
        const actualCounts = tableCounts(candidate);
        if (JSON.stringify(actualCounts) !== JSON.stringify(expectedCounts)) {
          throw new Error('Noura database migration row-count verification failed.');
        }
      } finally {
        candidate.close();
      }
      renameSync(candidatePath, databasePath);
      migratedLegacyDatabase = true;
    } finally {
      legacy.close();
    }
  }

  return { dataDir, databasePath, legacyAliasUsed, migratedLegacyDatabase };
}

function assertIntegrity(database: DatabaseSync, label: string): void {
  const result = database.prepare('PRAGMA integrity_check').get() as
    | { integrity_check?: string }
    | undefined;
  if (result?.integrity_check !== 'ok') throw new Error(`${label} failed SQLite integrity_check.`);
}

function tableCounts(database: DatabaseSync): Record<string, number> {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as unknown as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => {
      if (!/^[a-z_]+$/i.test(name)) throw new Error('Unsafe SQLite table name.');
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number };
      return [name, Number(row.count)];
    }),
  );
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS children (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL DEFAULT 'local-synthetic-parent',
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
      summary_json TEXT,
      parent_session_id TEXT REFERENCES sessions(id),
      ended_event_id INTEGER,
      summary_version INTEGER,
      summary_through_event_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      released INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);

    CREATE TABLE IF NOT EXISTS fallback_turns (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      idempotency_key TEXT NOT NULL,
      connection_epoch INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      steps_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fallback_one_active_session
      ON fallback_turns(session_id) WHERE status = 'active';
  `);

  // Older local databases predate the released flag.
  try {
    database.exec('ALTER TABLE events ADD COLUMN released INTEGER NOT NULL DEFAULT 1');
  } catch {
    /* column already exists */
  }

  addColumn(database, 'sessions', 'parent_session_id TEXT REFERENCES sessions(id)');
  addColumn(database, 'sessions', 'ended_event_id INTEGER');
  addColumn(database, 'sessions', 'summary_version INTEGER');
  addColumn(database, 'sessions', 'summary_through_event_id INTEGER');
  addColumn(database, 'children', "parent_id TEXT NOT NULL DEFAULT 'local-synthetic-parent'");

  database.exec(`

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

    INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, unixepoch() * 1000);
  `);
  addColumn(database, 'evidence', 'evidence_id TEXT');
  addColumn(database, 'evidence', 'child_id TEXT REFERENCES children(id)');
  addColumn(database, 'evidence', 'concept_id TEXT');
  addColumn(database, 'evidence', 'response_taxonomy TEXT');
  addColumn(database, 'evidence', 'confidence_basis TEXT');
  addColumn(database, 'evidence', 'source_event_ids TEXT');
  addColumn(database, 'evidence', 'normalized_excerpt TEXT');
  addColumn(database, 'evidence', 'source_span_json TEXT');
  addColumn(database, 'evidence', 'task_id TEXT');
  addColumn(database, 'evidence', 'independence_level TEXT');
  addColumn(database, 'evidence', 'domain_check_json TEXT');
  addColumn(database, 'evidence', 'turn_id TEXT');
  addColumn(database, 'evidence', 'generation_id TEXT');
  addColumn(database, 'evidence', 'contradicts_json TEXT');
  addColumn(database, 'evidence', 'supersedes_json TEXT');
  addColumn(database, 'evidence', "opportunity_kind TEXT NOT NULL DEFAULT 'recall'");
  addColumn(database, 'evidence', 'retrieval_of TEXT');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_evidence_id ON evidence(evidence_id) WHERE evidence_id IS NOT NULL');
}

function addColumn(database: DatabaseSync, table: string, definition: string): void {
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (error) {
    if (!/duplicate column name/i.test(String(error))) throw error;
  }
}
