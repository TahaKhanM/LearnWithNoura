import { describe, expect, it } from 'vitest';
import {
  metricContextFromIdentity,
  prepareMetric,
  prepareProviderUsage,
} from './telemetryRecorder.js';

describe('telemetry recorder', () => {
  it('validates and prepares a metric with pseudonymous server-owned context', () => {
    const observation = prepareMetric('session-1', {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
    }, {
      connectionEpoch: 2,
      turnId: 'turn-0',
      generationId: 'generation-0',
    });

    expect(observation).toMatchObject({
      name: 'session_reconnect',
      connectionEpoch: 2,
      telemetryEncoding: {
        version: 'hmac-sha256-v2',
        sessionTag: expect.stringMatching(/^[A-Za-z0-9_-]{10}$/),
      },
      turnId: expect.stringMatching(/^tel2_[A-Za-z0-9_-]{10}_[A-Za-z0-9_-]{24}$/),
      generationId: expect.stringMatching(/^tel2_[A-Za-z0-9_-]{10}_[A-Za-z0-9_-]{24}$/),
    });
    expect(JSON.stringify(observation)).not.toContain('turn-0');
    expect(JSON.stringify(observation)).not.toContain('generation-0');
  });

  it('always transforms token-shaped input and strips attempted encoding metadata', () => {
    const forged = {
      version: 'hmac-sha256-v2',
      sessionTag: 'AAAAAAAAAA',
    };
    const tokenShapedInput = `tel2_${forged.sessionTag}_${'B'.repeat(24)}`;
    const observation = prepareMetric('session-1', {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
      telemetryEncoding: forged,
    }, {
      connectionEpoch: 2,
      turnId: tokenShapedInput,
      generationId: tokenShapedInput,
    });

    expect(observation?.turnId).not.toBe(tokenShapedInput);
    expect(observation?.generationId).not.toBe(tokenShapedInput);
    expect(observation?.telemetryEncoding).not.toEqual(forged);
    expect(observation?.turnId).toMatch(/^tel2_[A-Za-z0-9_-]{10}_[A-Za-z0-9_-]{24}$/);
  });

  it('returns null for invalid input', () => {
    const observation = prepareMetric('session-1', {
      schemaVersion: '1.0.0',
      name: 'unknown_metric',
      unit: 'count',
      value: 1,
    }, {
      connectionEpoch: 2,
      turnId: 'turn-0',
      generationId: 'generation-0',
    });

    expect(observation).toBeNull();
  });

  it('pseudonymizes every identifier field consistently within one session', () => {
    const secretSentinels = {
      turnId: 'MAYA_PRIVATE_NAME',
      generationId: 'TRANSCRIPT_SECRET',
      providerResponseId: 'sk-provider-secret',
      visualCueId: 'visual-private',
      semanticObjectId: 'semantic-private',
      previousSemanticGroupId: 'section-private-a',
      nextSemanticGroupId: 'section-private-b',
      objectId: 'object-private',
    };
    const context = {
      connectionEpoch: 3,
      turnId: secretSentinels.turnId,
      generationId: secretSentinels.generationId,
      providerResponseId: secretSentinels.providerResponseId,
    };
    const reveal = prepareMetric('session-private', {
      schemaVersion: '1.0.0',
      name: 'board_reveal_to_narration',
      unit: 'ms',
      value: -20,
      visualCueId: secretSentinels.visualCueId,
      semanticObjectId: secretSentinels.semanticObjectId,
    }, context);
    const navigation = prepareMetric('session-private', {
      schemaVersion: '1.0.0',
      name: 'section_navigation',
      unit: 'count',
      value: 1,
      dimensions: {
        previousSemanticGroupId: secretSentinels.previousSemanticGroupId,
        nextSemanticGroupId: secretSentinels.nextSemanticGroupId,
        cause: 'picker',
      },
    }, context);
    const disappearance = prepareMetric('session-private', {
      schemaVersion: '1.0.0',
      name: 'tutor_object_disappearance',
      unit: 'count',
      value: 1,
      dimensions: { objectId: secretSentinels.objectId, cause: 'scene_mutation' },
    }, context);
    const serialized = JSON.stringify([reveal, navigation, disappearance]);

    for (const secret of Object.values(secretSentinels)) {
      expect(serialized).not.toContain(secret);
    }
    expect(reveal).toMatchObject({
      turnId: navigation?.turnId,
      generationId: navigation?.generationId,
      providerResponseId: navigation?.providerResponseId,
    });
    expect(prepareMetric('different-session', {
      schemaVersion: '1.0.0',
      name: 'session_reconnect',
      unit: 'count',
      value: 1,
    }, context)?.turnId).not.toBe(reveal?.turnId);
  });

  it('prepares provider usage without retaining provider content', () => {
    const observation = prepareProviderUsage('session-1', {
      total_tokens: 3,
      input_token_details: {
        text_tokens: 1,
        audio_tokens: 0,
        image_tokens: 0,
        cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
      },
      output_token_details: { text_tokens: 1, audio_tokens: 1 },
      transcript: 'PRIVATE_TRANSCRIPT',
    }, {
      connectionEpoch: 1,
      turnId: 'turn-1',
      generationId: 'generation-1',
      providerResponseId: 'response-1',
    });

    expect(observation).toMatchObject({
      name: 'provider_usage',
      value: 3,
      providerResponseId: expect.stringMatching(/^tel2_/),
    });
    expect(JSON.stringify(observation)).not.toContain('PRIVATE_TRANSCRIPT');
  });

  it('derives metric context from authoritative identity', () => {
    expect(metricContextFromIdentity({
      sessionId: 'session-authoritative',
      connectionEpoch: 4,
      turnId: 'turn-authoritative',
      generationId: 'generation-authoritative',
    }, 'response-1')).toEqual({
      connectionEpoch: 4,
      turnId: 'turn-authoritative',
      generationId: 'generation-authoritative',
      providerResponseId: 'response-1',
    });
  });
});
