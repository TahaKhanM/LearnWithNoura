import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { postgresPoolConfig } from './postgresConfig';

describe('Postgres connection security', () => {
  it.each(['sslmode=disable', 'sslmode=no-verify', 'ssl=false', 'ssl=no-verify'])('does not let %s override application TLS', (option) => {
    const config = postgresPoolConfig({ DATABASE_URL: `postgres://user:password@db.example.test/app?${option}` });
    const client = new Client(config);
    expect(client.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('keeps a configured CA through node-postgres URL parsing', () => {
    const ca = 'test-certificate-pem';
    const config = postgresPoolConfig({
      DATABASE_URL: 'postgres://user:p%40ss@db.example.test/app?sslmode=require&sslrootcert=/untrusted/path&application_name=noura',
      NOURA_DATABASE_CA_CERT: ca,
    });
    const client = new Client(config);
    expect(client.ssl).toEqual({ rejectUnauthorized: true, ca });
    expect(client.password).toBe('p@ss');
    expect(config.connectionString).toContain('application_name=noura');
  });

  it('requires the explicit legacy environment opt-out for unverified TLS', () => {
    expect(new Client(postgresPoolConfig({
      DATABASE_URL: 'postgres://user:password@db.example.test/app',
      NOURA_DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
    })).ssl).toEqual({ rejectUnauthorized: false });
  });

  it('does not expose a malformed connection string in errors', () => {
    expect(() => postgresPoolConfig({ DATABASE_URL: 'secret-credential' })).toThrow('DATABASE_URL must be a valid Postgres connection URL.');
  });
});
