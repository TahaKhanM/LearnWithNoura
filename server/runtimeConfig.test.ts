import { describe, expect, it } from 'vitest';
import { productionReadinessErrors, readRuntimeConfig } from './runtimeConfig';

describe('runtime configuration', () => {
  it('preserves the reviewed application model defaults', () => {
    const config = readRuntimeConfig({});
    expect(config.realtimeModel).toBe('gpt-realtime-2.1');
    expect(config.textModel).toBe('gpt-5.6-terra');
    expect(config.directorModel).toBe('gpt-5.6-terra');
    expect(config.directorReasoningEffort).toBe('medium');
  });

  it('reads the Board Director model and effort from the environment', () => {
    const config = readRuntimeConfig({
      NOURA_DIRECTOR_MODEL: 'custom-director-model',
      NOURA_DIRECTOR_REASONING_EFFORT: 'high',
    });
    expect(config.directorModel).toBe('custom-director-model');
    expect(config.directorReasoningEffort).toBe('high');
  });

  it('fails Production closed without durable storage, auth, privacy, and provider gates', () => {
    const env = { NOURA_DEPLOYMENT_MODE: 'production' };
    const errors = productionReadinessErrors(readRuntimeConfig(env), env);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/durable managed storage/i),
      expect.stringMatching(/authentication/i),
      expect.stringMatching(/privacy/i),
      expect.stringMatching(/provider/i),
      expect.stringMatching(/Postgres/i),
    ]));
  });

  it('does not accept an invented ZDR boolean as evidence', () => {
    const env = {
      NOURA_DEPLOYMENT_MODE: 'production',
      NOURA_UNDER_13_MODE: 'enabled',
      ZDR_VERIFIED: 'true',
    };
    expect(productionReadinessErrors(readRuntimeConfig(env), env)).toContain(
      'under-13 mode requires externally verified ZDR evidence',
    );
  });

  it('refuses to serve production with the fixture lesson compiler', () => {
    const env = {
      NOURA_DEPLOYMENT_MODE: 'production-v0',
      DATABASE_URL: 'postgres://fixture',
      OPENAI_API_KEY: 'fixture',
      NOURA_STORAGE_ADAPTER: 'postgres',
      NOURA_LESSON_CAPABILITY_SECRET: 'test-secret-at-least-32-characters',
      NOURA_LESSON_COMPILER: 'fixture',
    };
    expect(productionReadinessErrors(readRuntimeConfig(env), env)).toContain(
      'the fixture lesson compiler cannot serve production',
    );
  });

  it('keeps unverified database TLS outside the full Production boundary', () => {
    const env = {
      NOURA_DEPLOYMENT_MODE: 'production',
      DATABASE_URL: 'postgres://fixture',
      OPENAI_API_KEY: 'fixture',
      NOURA_STORAGE_ADAPTER: 'postgres',
      NOURA_LESSON_CAPABILITY_SECRET: 'test-secret-at-least-32-characters',
      NOURA_DATABASE_SSL_REJECT_UNAUTHORIZED: 'false',
    };
    expect(productionReadinessErrors(readRuntimeConfig(env), env)).toContain(
      'full Production requires verified database TLS',
    );
  });

  it('opens only the explicit guest v0 boundary when provider, Postgres, and signing are configured', () => {
    const env = {
      NOURA_DEPLOYMENT_MODE: 'production-v0',
      DATABASE_URL: 'postgres://fixture',
      OPENAI_API_KEY: 'fixture',
      NOURA_STORAGE_ADAPTER: 'postgres',
      NOURA_LESSON_CAPABILITY_SECRET: 'test-secret-at-least-32-characters',
    };
    const config = readRuntimeConfig(env);
    expect(config).toMatchObject({ production: true, v0: true, guestAccess: true, syntheticOnly: true });
    expect(productionReadinessErrors(config, env)).toEqual([]);
  });
});
