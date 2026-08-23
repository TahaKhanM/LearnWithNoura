import { describe, expect, it } from 'vitest';
import { capabilityFromProtocols, SecurityBoundary } from './security';
import { readRuntimeConfig } from './runtimeConfig';

describe('security boundary', () => {
  it('accepts only exact configured origins', () => {
    const boundary = new SecurityBoundary(readRuntimeConfig({}), { NOURA_ALLOWED_ORIGINS: 'https://preview.example.test' });
    expect(boundary.isAllowedOrigin('https://learnwithnoura.com')).toBe(true);
    expect(boundary.isAllowedOrigin('https://preview.example.test')).toBe(true);
    expect(boundary.isAllowedOrigin('https://learnwithnoura.com.attacker.test')).toBe(false);
    expect(boundary.isAllowedOrigin(undefined)).toBe(false);
  });

  it('issues short-lived lesson capabilities scoped to child and session', () => {
    const boundary = new SecurityBoundary(readRuntimeConfig({}), { NOURA_LESSON_CAPABILITY_SECRET: 'test-secret-at-least-32-characters' });
    const issue = boundary.apiSecurity().issueLessonCapability;
    expect(issue).toBeTypeOf('function');
    const token = issue?.('session-a', 'child-a', 'parent-a') ?? '';
    expect(boundary.verifyLessonCapability(token, 'session-a')).toMatchObject({ childId: 'child-a', parentId: 'parent-a' });
    expect(boundary.verifyLessonCapability(token, 'session-b')).toBeNull();
    expect(boundary.verifyLessonCapability(`${token}x`, 'session-a')).toBeNull();
    expect(capabilityFromProtocols(`noura.v1, cap.${token}`)).toBe(token);
  });

  it('applies bounded per-key rate limits', () => {
    const boundary = new SecurityBoundary(readRuntimeConfig({}));
    expect(boundary.allow('parent:child:session:ip', 2, 1000)).toBe(true);
    expect(boundary.allow('parent:child:session:ip', 2, 1000)).toBe(true);
    expect(boundary.allow('parent:child:session:ip', 2, 1000)).toBe(false);
  });
});
