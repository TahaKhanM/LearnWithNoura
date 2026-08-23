import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareDatabaseLocation } from './db';

const tempDirs: string[] = [];
afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Noura local database migration', () => {
  it('copies, verifies, and retains the legacy database and backup', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'noura-db-'));
    tempDirs.push(dataDir);
    const legacyPath = join(dataDir, 'seneca.db');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec('CREATE TABLE children (id TEXT PRIMARY KEY, name TEXT); INSERT INTO children VALUES (\'1\', \'Synthetic Learner\')');
    legacy.close();

    const location = prepareDatabaseLocation({ NOURA_DATA_DIR: dataDir });
    expect(location.databasePath).toBe(join(dataDir, 'noura.db'));
    expect(location.migratedLegacyDatabase).toBe(true);
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(join(dataDir, 'seneca.db.noura-migration.bak'))).toBe(true);

    const migrated = new DatabaseSync(location.databasePath, { readOnly: true });
    expect((migrated.prepare('SELECT COUNT(*) AS count FROM children').get() as { count: number }).count).toBe(1);
    migrated.close();

    expect(prepareDatabaseLocation({ NOURA_DATA_DIR: dataDir }).migratedLegacyDatabase).toBe(false);
  });

  it('supports the deprecated data-directory alias for one migration window', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'noura-alias-'));
    tempDirs.push(dataDir);
    const location = prepareDatabaseLocation({ SENECA_DATA_DIR: dataDir });
    expect(location.legacyAliasUsed).toBe(true);
    expect(location.dataDir).toBe(dataDir);
  });
});
