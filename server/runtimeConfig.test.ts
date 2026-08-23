import { describe, expect, it } from 'vitest';
import { productionReadinessErrors, readRuntimeConfig } from './runtimeConfig';

describe('runtime configuration', () => {
  it('preserves the reviewed application model defaults', () => {
    const config = readRuntimeConfig({});
    expect(config.realtimeModel).toBe('gpt-realtime-2.1');
    expect(config.textModel).toBe('gpt-5.6-terra');
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
});
