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
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 1,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 8_000,
      idleTimeoutMillis: 10_000,
      query_timeout: 15_000,
      statement_timeout: 15_000,
      ssl: env.NOURA_DATABASE_SSL_REJECT_UNAUTHORIZED === 'false'
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true },
    });
    const managed = new PostgresRepo(pool, env.NOURA_POSTGRES_AUTO_MIGRATE === 'true');
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
