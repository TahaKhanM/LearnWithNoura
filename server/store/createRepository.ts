import { Pool } from 'pg';
import type { RuntimeConfig } from '../runtimeConfig.js';
import type { DomainRepository, ManagedDomainRepository } from './domain.js';
import { getDb } from './db.js';
import { PostgresRepo } from './postgresRepo.js';
import { Repo } from './repo.js';

export interface RepositoryRuntime {
  repo: DomainRepository;
  ready(): Promise<void>;
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
    return { repo: managed, ready: () => managed.initialize(), managed };
  }

  const repo = new Repo(getDb());
  return { repo, ready: () => Promise.resolve(), managed: null };
}
