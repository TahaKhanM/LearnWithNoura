import { Buffer } from 'node:buffer';
import type { RuntimeEventEnvelope } from '../../shared/runtimeProtocol.js';
import { TELEMETRY_SCHEMA_VERSION, type MetricInput } from '../../shared/sessionTelemetry.js';
import { metricContextFromIdentity } from '../session/telemetryRecorder.js';
import type { CoordinatorContext } from './coordinatorContext.js';
import { OUTPUT_AUDIO_SAMPLES_PER_MS } from './sessionConfig.js';
import { addBounded } from './responseRegistry.js';

/**
 * Telemetry glue between the runtime coordinator and the Phase 0 pipeline:
 * which browser metrics are trusted, how client-carried response correlation
 * is verified, and the once-only terminal provider telemetry per response.
 */

const MAX_TERMINAL_TELEMETRY_RESPONSES = 512;
export const MAX_PENDING_VOICE_BARGE_INS = 256;

export function isAllowedClientMetric(input: MetricInput): boolean {
  switch (input.name) {
    case 'speech_end_to_response_started':
    case 'speech_end_to_first_audio':
    case 'ask_to_first_audio':
    case 'board_reveal_to_narration':
    case 'section_navigation':
    case 'tutor_object_disappearance':
      return true;
    case 'barge_in_gate_outcome':
      return input.dimensions.outcome === 'local_only_rejected' ||
        input.dimensions.outcome === 'provider_only_rejected';
    case 'telemetry_gap':
      return input.dimensions.reason === 'client_queue_overflow' &&
        input.value <= 64;
    default:
      return false;
  }
}

export function trustedClientResponseId(
  ctx: CoordinatorContext,
  metric: MetricInput,
  envelope: RuntimeEventEnvelope,
): string | undefined {
  if (metric.name !== 'board_reveal_to_narration') return undefined;
  const responseId = envelope.providerResponseId;
  if (!responseId) return undefined;
  const identity = ctx.state.responseIdentities.get(responseId);
  if (!identity) return undefined;
  return identity.sessionId === envelope.sessionId &&
    identity.connectionEpoch === envelope.connectionEpoch &&
    identity.turnId === envelope.turnId &&
    identity.generationId === envelope.generationId
    ? responseId
    : undefined;
}

/** Records provider usage, audio duration, and barge-in outcome exactly once
 * per known terminal response identity. Unknown identities emit nothing. */
export function recordTerminalResponseTelemetry(
  ctx: CoordinatorContext,
  response: { id?: string; status?: string; usage?: unknown } | undefined,
  status: string,
): void {
  const { state } = ctx;
  const terminalTelemetryIdentity = response?.id
    ? state.responseIdentities.get(response.id)
    : undefined;
  if (!response?.id || !terminalTelemetryIdentity || state.terminalTelemetryResponses.has(response.id)) return;
  addBounded(
    state.terminalTelemetryResponses,
    response.id,
    MAX_TERMINAL_TELEMETRY_RESPONSES,
  );
  const context = metricContextFromIdentity(
    terminalTelemetryIdentity,
    response.id,
  );
  ctx.telemetryWriter.submitProviderUsage(response.usage, context);
  const outputSamples = state.responseSegments.get(response.id)?.totalSamples();
  if (outputSamples !== undefined && outputSamples > 0) {
    ctx.telemetryWriter.submit({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      name: 'tutor_audio_output_duration',
      unit: 'ms',
      value: Math.round(outputSamples / OUTPUT_AUDIO_SAMPLES_PER_MS),
    }, context);
  }
  if (state.pendingVoiceBargeInResponses.has(response.id)) {
    const outcome = status === 'cancelled'
      ? 'provider_cancelled'
      : status === 'completed'
        ? 'provider_completed'
        : 'provider_failed';
    ctx.telemetryWriter.submit({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      name: 'barge_in_cancel_outcome',
      unit: 'count',
      value: 1,
      dimensions: { outcome },
    }, context);
    state.pendingVoiceBargeInResponses.delete(response.id);
  }
}

export function pcmSampleCount(base64: string): number {
  try { return Math.floor(Buffer.from(base64, 'base64').byteLength / 2); }
  catch { return 0; }
}
