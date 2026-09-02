import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertProviderStartAllowed } from './providerStartGuard.js';

const localKey = {
  apiKey: 'sk-test',
  lessonCompiler: undefined,
  argv: ['tsx', 'server/index.ts'],
  vercel: undefined,
  authorizedLiveRun: false,
  authorizedM2Smoke: false,
};

describe('provider start guard', () => {
  it('allows a local start with no provider key', () => {
    expect(() => assertProviderStartAllowed({ ...localKey, apiKey: undefined })).not.toThrow();
  });

  it('allows a local start when the fixture compiler is forced', () => {
    expect(() => assertProviderStartAllowed({ ...localKey, lessonCompiler: 'fixture' })).not.toThrow();
  });

  it('allows an explicit authorized live run when a key is present', () => {
    expect(() => assertProviderStartAllowed({
      ...localKey,
      argv: ['tsx', 'server/index.ts', '--authorized-live-run'],
    })).not.toThrow();
    expect(() => assertProviderStartAllowed({ ...localKey, authorizedLiveRun: true })).not.toThrow();
    expect(() => assertProviderStartAllowed({ ...localKey, authorizedM2Smoke: true, lessonCompiler: 'fixture' })).not.toThrow();
  });

  it('allows deployed Vercel and production processes with a key', () => {
    expect(() => assertProviderStartAllowed({ ...localKey, vercel: '1' })).not.toThrow();
  });

  it('refuses a local start when a key is present without the fixture compiler or live authorization', () => {
    expect(() => assertProviderStartAllowed(localKey)).toThrow(/NOURA_LESSON_COMPILER=fixture|--authorized-live-run/i);
  });

  it('is invoked by the server entry before a live compiler can be constructed', () => {
    const source = readFileSync(resolve('server/app.ts'), 'utf8');
    expect(source).toMatch(/assertProviderStartAllowed\(/);
    expect(source.indexOf('assertProviderStartAllowed({')).toBeLessThan(source.indexOf('createLiveCompilationService({'));
  });
});
