import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRealtimeIncident, safeIncidentReason } from './incidentLogging';

describe('realtime incident logging', () => {
  it('emits one-line structured fields and bounds free-form values', () => {
    const line = formatRealtimeIncident('storyboard_abandoned', {
      sessionId: 'session-1',
      runId: 'run-1',
      stage: 'reveal_timeout',
      reason: `ops_shown_timeout\n${'x'.repeat(400)}`,
      revealedSteps: 0,
      totalSteps: 3,
    });

    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toMatchObject({
      event: 'storyboard_abandoned',
      sessionId: 'session-1',
      runId: 'run-1',
      stage: 'reveal_timeout',
      revealedSteps: 0,
      totalSteps: 3,
    });
    expect((JSON.parse(line) as { reason: string }).reason.length).toBeLessThanOrEqual(240);
  });

  it('redacts URL credentials from setup errors', () => {
    const reason = safeIncidentReason(new Error('connect postgresql://noura:secret@example.test/db failed'));
    expect(reason).toContain('postgresql://[redacted]@example.test/db');
    expect(reason).not.toContain('noura:secret');
  });

  it('pins the websocket setup catch to a structured error log before close', () => {
    const source = readFileSync(resolve('server/app.ts'), 'utf8');
    expect(source).toMatch(/connectRealtimeProxy[\s\S]*?\.catch\(\(error\)[\s\S]*?realtime_proxy_setup_error[\s\S]*?client\.close\(1011/);
  });
});
