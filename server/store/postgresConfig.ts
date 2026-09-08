import type { PoolConfig } from 'pg';

/** One TLS authority: URL options must not replace the application's CA or verification setting. */
export function postgresPoolConfig(env: NodeJS.ProcessEnv): PoolConfig {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    // URL parsing errors can contain the supplied credentials.
    throw new Error('DATABASE_URL must be a valid Postgres connection URL.');
  }
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
    url.searchParams.delete(key);
  }
  return {
    connectionString: url.toString(),
    max: 1,
    allowExitOnIdle: true,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    ssl: {
      rejectUnauthorized: env.NOURA_DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
      ...(env.NOURA_DATABASE_CA_CERT ? { ca: env.NOURA_DATABASE_CA_CERT } : {}),
    },
  };
}
