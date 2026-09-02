import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { productionReadinessErrors, readRuntimeConfig } from './runtimeConfig';

describe('runtime configuration', () => {
  it('preserves the reviewed application model defaults', () => {
    const config = readRuntimeConfig({});
    expect(config.realtimeModel).toBe('gpt-realtime-2.1');
    expect(config.textModel).toBe('gpt-5.6-terra');
    expect(config.directorModel).toBe('gpt-5.6-terra');
    expect(config.directorReasoningEffort).toBe('low');
    expect(config.directorPipeline).toBe('streaming');
    expect(config.visionAuditModel).toBe('gpt-5.6-luna');
    expect(config.visionAuditReasoningEffort).toBe('low');
    expect(config.illustrationModel).toBe('gpt-image-1.5');
    expect(config.illustrationsEnabled).toBe(true);
  });

  it('defaults dev and Preview to streaming while preserving classic rollback', () => {
    expect(readRuntimeConfig({ VERCEL_ENV: 'preview' })).toMatchObject({
      deploymentMode: 'preview-synthetic',
      directorPipeline: 'streaming',
      directorReasoningEffort: 'low',
    });
    expect(readRuntimeConfig({ NOURA_DEPLOYMENT_MODE: 'production-v0' })).toMatchObject({
      directorPipeline: 'classic',
      directorReasoningEffort: 'medium',
    });
    expect(readRuntimeConfig({ NOURA_DIRECTOR_PIPELINE: 'classic' })).toMatchObject({
      directorPipeline: 'classic',
      directorReasoningEffort: 'medium',
    });
  });

  it('pins the Director pipeline rollback and source-cohesion documentation', () => {
    const read = (path: string) => readFileSync(resolve(path), 'utf8');
    const readme = read('README.md');
    const runtimeAdr = read('docs/architecture/2026-08-23-noura-runtime-architecture.md');
    const environment = read('.env.example');
    const runner = read('server/realtime/storyboardRunner.ts');
    const handoff = read('docs/architecture/2026-09-01-drawing-vnext-m1-handoff.md');

    expect(readme).toMatch(/NOURA_DIRECTOR_PIPELINE/);
    expect(readme).toMatch(/classic.*rollback/is);
    expect(runtimeAdr).toMatch(/NOURA_DIRECTOR_PIPELINE/);
    expect(runtimeAdr).toMatch(/classic.*rollback/is);
    expect(environment).toMatch(/classic[^\n]*medium/is);
    expect(runner.slice(0, 2_000)).toMatch(/cohesive.*state machine/is);
    expect(handoff).not.toContain('--reporter=basic');
  });

  it('disables illustrations when NOURA_ILLUSTRATIONS=off and reads the image model', () => {
    const config = readRuntimeConfig({
      NOURA_ILLUSTRATIONS: 'off',
      NOURA_ILLUSTRATION_MODEL: 'gpt-image-2',
    });
    expect(config.illustrationsEnabled).toBe(false);
    expect(config.illustrationModel).toBe('gpt-image-2');
  });

  it('reads the Board Director model and effort from the environment', () => {
    const config = readRuntimeConfig({
      NOURA_DIRECTOR_MODEL: 'custom-director-model',
      NOURA_DIRECTOR_REASONING_EFFORT: 'high',
      NOURA_DIRECTOR_PIPELINE: 'streaming',
      NOURA_VISION_AUDIT_MODEL: 'gpt-5.6-terra',
      NOURA_VISION_AUDIT_REASONING_EFFORT: 'medium',
    });
    expect(config.directorModel).toBe('custom-director-model');
    expect(config.directorReasoningEffort).toBe('high');
    expect(config.directorPipeline).toBe('streaming');
    expect(config.visionAuditModel).toBe('gpt-5.6-terra');
    expect(config.visionAuditReasoningEffort).toBe('medium');
  });

  it('does not let the legacy generic text model select drawing roles', () => {
    const config = readRuntimeConfig({ OPENAI_MODEL: 'legacy-text-model' });
    expect(config.textModel).toBe('legacy-text-model');
    expect(config.compilerModel).toBe('legacy-text-model');
    expect(config.directorModel).toBe('gpt-5.6-terra');
    expect(config.visionAuditModel).toBe('gpt-5.6-luna');
  });

  it('uses the reviewed low-effort interim when streaming is enabled', () => {
    const config = readRuntimeConfig({ NOURA_DIRECTOR_PIPELINE: 'streaming' });
    expect(config.directorPipeline).toBe('streaming');
    expect(config.directorReasoningEffort).toBe('low');
  });

  it('honors an explicit medium-effort streaming override', () => {
    const config = readRuntimeConfig({
      NOURA_DIRECTOR_PIPELINE: 'streaming',
      NOURA_DIRECTOR_REASONING_EFFORT: 'medium',
    });
    expect(config.directorReasoningEffort).toBe('medium');
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
