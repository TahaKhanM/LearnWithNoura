import { createHmac } from 'node:crypto';
import {
  MetricObservationSchema,
  TELEMETRY_ENCODING_VERSION,
  type MetricObservation,
} from '../../shared/sessionTelemetry.js';

const TOKEN_DIGEST_LENGTH = 24;
const SESSION_TAG_LENGTH = 10;

type TelemetryIdentifierField =
  | 'turnId'
  | 'generationId'
  | 'providerResponseId'
  | 'visualCueId'
  | 'semanticObjectId'
  | 'previousSemanticGroupId'
  | 'nextSemanticGroupId'
  | 'objectId';

export function pseudonymizeTelemetryId(
  sessionId: string,
  field: TelemetryIdentifierField,
  value: string,
): string {
  const digest = createHmac('sha256', `noura-phase0-telemetry:${sessionId}`)
    .update(field)
    .update('\0')
    .update(value)
    .digest('base64url')
    .slice(0, TOKEN_DIGEST_LENGTH);
  return `tel2_${sessionTag(sessionId)}_${digest}`;
}

export function encodeMetricObservation(
  sessionId: string,
  observation: MetricObservation,
): MetricObservation {
  return transformMetricObservation(sessionId, observation, false);
}

export function pseudonymizeMetricObservation(
  sessionId: string,
  observation: MetricObservation,
): MetricObservation {
  return transformMetricObservation(sessionId, observation, true);
}

function transformMetricObservation(
  sessionId: string,
  observation: MetricObservation,
  preserveTrusted: boolean,
): MetricObservation {
  if ('legacy' in observation) return observation;

  const tag = sessionTag(sessionId);
  const encode = (field: TelemetryIdentifierField, value: string): string =>
    preserveTrusted && hasTrustedEncoding(observation, tag, value)
      ? value
      : pseudonymizeTelemetryId(sessionId, field, value);
  const candidate: Record<string, unknown> = {
    ...observation,
    telemetryEncoding: {
      version: TELEMETRY_ENCODING_VERSION,
      sessionTag: tag,
    },
    turnId: encode('turnId', observation.turnId),
    generationId: encode('generationId', observation.generationId),
    ...(observation.providerResponseId
      ? {
          providerResponseId: encode('providerResponseId', observation.providerResponseId),
        }
      : {}),
  };

  if (observation.name === 'board_reveal_to_narration') {
    if (observation.visualCueId) {
      candidate.visualCueId = encode('visualCueId', observation.visualCueId);
    }
    if (observation.semanticObjectId) {
      candidate.semanticObjectId = encode('semanticObjectId', observation.semanticObjectId);
    }
  } else if (observation.name === 'section_navigation') {
    candidate.dimensions = {
      ...observation.dimensions,
      previousSemanticGroupId: encode(
        'previousSemanticGroupId',
        observation.dimensions.previousSemanticGroupId,
      ),
      nextSemanticGroupId: encode(
        'nextSemanticGroupId',
        observation.dimensions.nextSemanticGroupId,
      ),
    };
  } else if (observation.name === 'tutor_object_disappearance') {
    candidate.dimensions = {
      ...observation.dimensions,
      objectId: encode('objectId', observation.dimensions.objectId),
    };
  }

  return MetricObservationSchema.parse(candidate);
}

function sessionTag(sessionId: string): string {
  return createHmac('sha256', 'noura-phase0-telemetry-session-tag')
    .update(sessionId)
    .digest('base64url')
    .slice(0, SESSION_TAG_LENGTH);
}

function hasTrustedEncoding(
  observation: Exclude<MetricObservation, { legacy: true }>,
  expectedSessionTag: string,
  value: string,
): boolean {
  return observation.telemetryEncoding?.version === TELEMETRY_ENCODING_VERSION &&
    observation.telemetryEncoding.sessionTag === expectedSessionTag &&
    value.startsWith(`tel2_${expectedSessionTag}_`) &&
    value.length === `tel2_${expectedSessionTag}_`.length + TOKEN_DIGEST_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value);
}
