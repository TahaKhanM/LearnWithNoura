import type { EventRow } from '../store/repo.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  isDurationMetricName,
  normalizeStoredMetric,
  type BargeInOutcomeCounts,
  type DurationAggregate,
  type MetricInput,
  type ProviderUsageTotals,
  type SessionMetricEntry,
  type SessionTelemetryLog,
} from '../../shared/sessionTelemetry.js';

const emptyBargeInCounts = (): BargeInOutcomeCounts => ({
  localOnlyRejected: 0,
  providerOnlyRejected: 0,
  confirmed: 0,
  providerCancelled: 0,
  providerCompleted: 0,
  providerFailed: 0,
  unresolved: 0,
});

const emptyProviderUsage = (): ProviderUsageTotals => ({
  totalTokens: 0,
  inputTextTokens: 0,
  inputAudioTokens: 0,
  inputImageTokens: 0,
  cachedTextTokens: 0,
  cachedAudioTokens: 0,
  cachedImageTokens: 0,
  outputTextTokens: 0,
  outputAudioTokens: 0,
});

function roundMean(total: number, count: number): number {
  return Math.round(total / count);
}

function updateDurationAggregate(
  aggregates: Partial<Record<MetricInput['name'], DurationAggregate>>,
  name: MetricInput['name'],
  value: number,
): void {
  const current = aggregates[name];
  if (!current) {
    aggregates[name] = {
      count: 1,
      min: value,
      max: value,
      mean: value,
      latest: value,
    };
    return;
  }

  current.count += 1;
  current.min = Math.min(current.min, value);
  current.max = Math.max(current.max, value);
  current.latest = value;
  current.mean = roundMean(current.mean * (current.count - 1) + value, current.count);
}

function toTimelineDimensions(
  dimensions: Record<string, unknown> | undefined,
): Record<string, string | number> | undefined {
  if (!dimensions) return undefined;

  const bounded: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(dimensions)) {
    if (typeof value === 'string' || typeof value === 'number') {
      bounded[key] = value;
    }
  }
  return Object.keys(bounded).length > 0 ? bounded : undefined;
}

function toTimelineEntry(event: EventRow, metric: NonNullable<ReturnType<typeof normalizeStoredMetric>>): SessionMetricEntry {
  const entry: SessionMetricEntry = {
    eventId: event.id,
    ts: event.ts,
    name: metric.name,
    unit: metric.unit,
    value: metric.value,
  };

  if ('legacy' in metric && metric.legacy) {
    entry.legacy = true;
    return entry;
  }

  if ('connectionEpoch' in metric) entry.connectionEpoch = metric.connectionEpoch;
  if ('turnId' in metric) entry.turnId = metric.turnId;
  if ('generationId' in metric) entry.generationId = metric.generationId;
  if ('providerResponseId' in metric && metric.providerResponseId) {
    entry.providerResponseId = metric.providerResponseId;
  }
  if ('visualCueId' in metric && metric.visualCueId) entry.visualCueId = metric.visualCueId;
  if ('semanticObjectId' in metric && metric.semanticObjectId) {
    entry.semanticObjectId = metric.semanticObjectId;
  }
  if ('dimensions' in metric && metric.dimensions) {
    entry.dimensions = toTimelineDimensions(metric.dimensions as Record<string, unknown>);
  }

  return entry;
}

export function buildSessionTelemetryLog(
  sessionId: string,
  events: EventRow[],
  limit: number,
): SessionTelemetryLog {
  const durations: Partial<Record<MetricInput['name'], DurationAggregate>> = {};
  const bargeIn = emptyBargeInCounts();
  const providerUsage = emptyProviderUsage();
  const confirmedByResponseId = new Map<string, number>();
  const resolvedByResponseId = new Map<string, number>();
  let sectionSwitchCount = 0;
  let reconnectCount = 0;
  let tutorObjectDisappearanceCount = 0;
  const timeline: SessionMetricEntry[] = [];

  for (const event of events) {
    if (!event.released || event.type !== 'metric') continue;

    const metric = normalizeStoredMetric(event.payload);
    if (!metric) continue;

    timeline.push(toTimelineEntry(event, metric));

    if (isDurationMetricName(metric.name)) {
      updateDurationAggregate(durations, metric.name, metric.value);
    }

    if (metric.name === 'barge_in_gate_outcome' && 'dimensions' in metric) {
      switch (metric.dimensions.outcome) {
        case 'local_only_rejected':
          bargeIn.localOnlyRejected += 1;
          break;
        case 'provider_only_rejected':
          bargeIn.providerOnlyRejected += 1;
          break;
        case 'confirmed': {
          bargeIn.confirmed += 1;
          const responseId = 'providerResponseId' in metric ? metric.providerResponseId : undefined;
          if (responseId) {
            confirmedByResponseId.set(responseId, (confirmedByResponseId.get(responseId) ?? 0) + 1);
          }
          break;
        }
      }
    }

    if (metric.name === 'barge_in_cancel_outcome' && 'dimensions' in metric) {
      switch (metric.dimensions.outcome) {
        case 'provider_cancelled':
          bargeIn.providerCancelled += 1;
          break;
        case 'provider_completed':
          bargeIn.providerCompleted += 1;
          break;
        case 'provider_failed':
          bargeIn.providerFailed += 1;
          break;
      }

      const responseId = 'providerResponseId' in metric ? metric.providerResponseId : undefined;
      if (responseId) {
        resolvedByResponseId.set(responseId, (resolvedByResponseId.get(responseId) ?? 0) + 1);
      }
    }

    if (metric.name === 'section_navigation' && 'dimensions' in metric) {
      if (metric.dimensions.cause !== 'initial_anchor') {
        sectionSwitchCount += 1;
      }
    }

    if (metric.name === 'session_reconnect') {
      reconnectCount += 1;
    }

    if (metric.name === 'tutor_object_disappearance') {
      tutorObjectDisappearanceCount += 1;
    }

    if (metric.name === 'provider_usage' && 'dimensions' in metric) {
      providerUsage.totalTokens += metric.dimensions.totalTokens;
      providerUsage.inputTextTokens += metric.dimensions.inputTextTokens;
      providerUsage.inputAudioTokens += metric.dimensions.inputAudioTokens;
      providerUsage.inputImageTokens += metric.dimensions.inputImageTokens;
      providerUsage.cachedTextTokens += metric.dimensions.cachedTextTokens;
      providerUsage.cachedAudioTokens += metric.dimensions.cachedAudioTokens;
      providerUsage.cachedImageTokens += metric.dimensions.cachedImageTokens;
      providerUsage.outputTextTokens += metric.dimensions.outputTextTokens;
      providerUsage.outputAudioTokens += metric.dimensions.outputAudioTokens;
    }
  }

  let unresolved = 0;
  for (const [responseId, confirmedCount] of confirmedByResponseId) {
    const resolvedCount = resolvedByResponseId.get(responseId) ?? 0;
    unresolved += Math.max(0, confirmedCount - resolvedCount);
  }
  bargeIn.unresolved = unresolved;

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    sessionId,
    truncated: events.length >= limit,
    summary: {
      durations,
      bargeIn,
      sectionSwitchCount,
      reconnectCount,
      tutorObjectDisappearanceCount,
      providerUsage,
    },
    timeline,
  };
}
