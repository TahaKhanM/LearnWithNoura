import { Pool } from 'pg';
import type { RuntimeConfig } from '../runtimeConfig.js';
import {
  AsyncDomainTelemetryRepository,
  SqliteWorkerTelemetryRepository,
  type ManagedSessionTelemetryRepository,
  type SessionTelemetryRepository,
} from '../session/telemetryRepository.js';
import type { DomainRepository, ManagedDomainRepository } from './domain.js';
import { getDatabasePath, getDb } from './db.js';
import { PostgresRepo } from './postgresRepo.js';
import { postgresPoolConfig } from './postgresConfig.js';
import { Repo } from './repo.js';

export interface RepositoryRuntime {
  repo: DomainRepository;
  telemetry: SessionTelemetryRepository;
  ready(): Promise<void>;
  close(): Promise<void>;
  managed: ManagedDomainRepository | null;
}

export function createRepositoryRuntime(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): RepositoryRuntime {
  if (config.durableStorageConfigured && env.NOURA_STORAGE_ADAPTER === 'postgres') {
    const pool = new Pool(postgresPoolConfig(env));
    const managed = new PostgresRepo(pool, env.NOURA_POSTGRES_AUTO_MIGRATE !== 'false');
    const telemetry = new AsyncDomainTelemetryRepository(managed);
    return {
      repo: managed,
      telemetry,
      ready: () => managed.initialize(),
      close: async () => {
        await telemetry.shutdown();
        await pool.end();
      },
      managed,
    };
  }

  const repo = new Repo(getDb(env));
  const telemetry: ManagedSessionTelemetryRepository =
    new SqliteWorkerTelemetryRepository(getDatabasePath(env));
  return {
    repo,
    telemetry,
    ready: () => Promise.resolve(),
    close: () => telemetry.shutdown(),
    managed: null,
  };
}
