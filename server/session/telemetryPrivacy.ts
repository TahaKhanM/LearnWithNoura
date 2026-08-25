import { createHmac } from 'node:crypto';
import {
  MetricObservationSchema,
  type MetricObservation,
} from '../../shared/sessionTelemetry.js';

const OPAQUE_ID_PATTERN = /^tel1_[A-Za-z0-9_-]{24}$/;

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
  if (OPAQUE_ID_PATTERN.test(value)) return value;
  const digest = createHmac('sha256', `noura-phase0-telemetry:${sessionId}`)
    .update(field)
    .update('\0')
    .update(value)
    .digest('base64url')
    .slice(0, 24);
  return `tel1_${digest}`;
}

export function pseudonymizeMetricObservation(
  sessionId: string,
  observation: MetricObservation,
): MetricObservation {
  if ('legacy' in observation) return observation;

  const candidate: Record<string, unknown> = {
    ...observation,
    turnId: pseudonymizeTelemetryId(sessionId, 'turnId', observation.turnId),
    generationId: pseudonymizeTelemetryId(
      sessionId,
      'generationId',
      observation.generationId,
    ),
    ...(observation.providerResponseId
      ? {
          providerResponseId: pseudonymizeTelemetryId(
            sessionId,
            'providerResponseId',
            observation.providerResponseId,
          ),
        }
      : {}),
  };

  if (observation.name === 'board_reveal_to_narration') {
    if (observation.visualCueId) {
      candidate.visualCueId = pseudonymizeTelemetryId(
        sessionId,
        'visualCueId',
        observation.visualCueId,
      );
    }
    if (observation.semanticObjectId) {
      candidate.semanticObjectId = pseudonymizeTelemetryId(
        sessionId,
        'semanticObjectId',
        observation.semanticObjectId,
      );
    }
  } else if (observation.name === 'section_navigation') {
    candidate.dimensions = {
      ...observation.dimensions,
      previousSemanticGroupId: pseudonymizeTelemetryId(
        sessionId,
        'previousSemanticGroupId',
        observation.dimensions.previousSemanticGroupId,
      ),
      nextSemanticGroupId: pseudonymizeTelemetryId(
        sessionId,
        'nextSemanticGroupId',
        observation.dimensions.nextSemanticGroupId,
      ),
    };
  } else if (observation.name === 'tutor_object_disappearance') {
    candidate.dimensions = {
      ...observation.dimensions,
      objectId: pseudonymizeTelemetryId(
        sessionId,
        'objectId',
        observation.dimensions.objectId,
      ),
    };
  }

  return MetricObservationSchema.parse(candidate);
}
