const DURATION_NAMES = new Set([
  'speech_end_to_response_started',
  'speech_end_to_first_audio',
  'ask_to_first_audio',
  'board_reveal_to_narration',
  'tutor_audio_output_duration',
]);
const LIFECYCLE_NAMES = new Set([
  'barge_in_gate_outcome',
  'barge_in_cancel_outcome',
  'section_navigation',
  'session_reconnect',
  'tutor_object_disappearance',
]);
const GAP_REASONS = [
  'server_queue_overflow',
  'server_persistence_failure',
  'client_queue_overflow',
];
const USAGE_KEYS = [
  'totalTokens',
  'inputTextTokens',
  'inputAudioTokens',
  'inputImageTokens',
  'cachedTextTokens',
  'cachedAudioTokens',
  'cachedImageTokens',
  'outputTextTokens',
  'outputAudioTokens',
];

export function projectObservation(value) {
  const observation = requireRecord(value, 'observation');
  return {
    browserConsoleErrorCount: observation.browserConsoleErrorCount,
    elapsedSmokeDurationMs: readSafeNonNegativeInteger(
      observation.elapsedSmokeDurationMs,
      'observation.elapsedSmokeDurationMs',
    ),
    journeyState: observation.journeyState,
    log: projectSessionLog(observation.log),
    milestones: observation.milestones,
    navigatedOrigin: readHttpOrigin(
      observation.navigatedOrigin,
      'observation.navigatedOrigin',
    ),
    sessionId: readBoundedString(observation.sessionId, 'observation.sessionId'),
    version: projectVersion(observation.version),
  };
}

function projectVersion(value) {
  const version = requireRecord(value, 'version');
  assertExactKeys(version, [
    'brand', 'version', 'gitSha', 'environment', 'schemaVersion', 'runtimeModels',
  ], 'version');
  if (version.brand !== 'Noura' || version.schemaVersion !== '1.0.0') {
    throw new Error('The version endpoint schema is not supported.');
  }
  readBoundedString(version.version, 'version.version');
  readBoundedString(version.environment, 'version.environment');
  const models = requireRecord(version.runtimeModels, 'version.runtimeModels');
  assertExactKeys(models, ['realtime', 'transcription', 'text'], 'version.runtimeModels');
  return {
    gitSha: readBoundedString(version.gitSha, 'version.gitSha'),
    runtimeModels: {
      realtime: readBoundedString(models.realtime, 'runtimeModels.realtime'),
      transcription: readBoundedString(
        models.transcription,
        'runtimeModels.transcription',
      ),
      text: readBoundedString(models.text, 'runtimeModels.text'),
    },
  };
}

function projectSessionLog(value) {
  const log = requireRecord(value, 'log');
  assertExactKeys(
    log,
    ['schemaVersion', 'sessionId', 'truncated', 'summary', 'timeline'],
    'log',
  );
  if (log.schemaVersion !== '1.0.0' || typeof log.truncated !== 'boolean') {
    throw new Error('The session log schema is not supported.');
  }
  if (!Array.isArray(log.timeline) || log.timeline.length > 5_000) {
    throw new Error('The session log timeline is invalid.');
  }
  const timeline = log.timeline.map((entry, index) =>
    projectTimelineEntry(entry, `log.timeline[${index}]`));
  const summary = projectSummary(log.summary);
  assertAscendingTimeline(timeline);
  const reconstructed = reconstructSummary(timeline);
  assertSummaryMatchesTimeline(summary, reconstructed);
  return {
    schemaVersion: '1.0.0',
    sessionId: readBoundedString(log.sessionId, 'log.sessionId'),
    truncated: log.truncated,
    summary,
    timeline,
  };
}

function projectSummary(value) {
  const summary = requireRecord(value, 'log.summary');
  assertExactKeys(summary, [
    'durations',
    'bargeIn',
    'sectionSwitchCount',
    'reconnectCount',
    'tutorObjectDisappearanceCount',
    'providerUsage',
    'telemetryGaps',
  ], 'log.summary');
  const source = requireRecord(summary.durations, 'log.summary.durations');
  assertAllowedKeys(source, [...DURATION_NAMES], 'log.summary.durations');
  const durations = {};
  for (const [name, aggregate] of Object.entries(source)) {
    durations[name] = projectDurationAggregate(
      aggregate,
      name,
      `log.summary.durations.${name}`,
    );
  }
  const bargeIn = requireRecord(summary.bargeIn, 'log.summary.bargeIn');
  const bargeKeys = [
    'localOnlyRejected', 'providerOnlyRejected', 'confirmed',
    'providerCancelled', 'providerCompleted', 'providerFailed', 'unresolved',
  ];
  assertExactKeys(bargeIn, bargeKeys, 'log.summary.bargeIn');
  return {
    durations,
    bargeIn: Object.fromEntries(bargeKeys.map((key) => [
      key,
      readSafeNonNegativeInteger(bargeIn[key], `log.summary.bargeIn.${key}`),
    ])),
    sectionSwitchCount: readSafeNonNegativeInteger(
      summary.sectionSwitchCount,
      'log.summary.sectionSwitchCount',
    ),
    reconnectCount: readSafeNonNegativeInteger(
      summary.reconnectCount,
      'log.summary.reconnectCount',
    ),
    tutorObjectDisappearanceCount: readSafeNonNegativeInteger(
      summary.tutorObjectDisappearanceCount,
      'log.summary.tutorObjectDisappearanceCount',
    ),
    providerUsage: projectUsage(summary.providerUsage, false, 'log.summary.providerUsage'),
    telemetryGaps: projectGaps(summary.telemetryGaps),
  };
}

function projectDurationAggregate(value, name, label) {
  const aggregate = requireRecord(value, label);
  assertExactKeys(aggregate, ['count', 'min', 'max', 'mean', 'latest'], label);
  const count = readSafePositiveInteger(aggregate.count, `${label}.count`);
  const readValue = name === 'board_reveal_to_narration'
    ? readSafeInteger
    : readSafeNonNegativeInteger;
  const min = readValue(aggregate.min, `${label}.min`);
  const max = readValue(aggregate.max, `${label}.max`);
  const mean = readValue(aggregate.mean, `${label}.mean`);
  const latest = readValue(aggregate.latest, `${label}.latest`);
  if (min > max || mean < min || mean > max || latest < min || latest > max) {
    throw new Error(`${label} is internally inconsistent.`);
  }
  return { count, min, max, mean, latest };
}

function projectTimelineEntry(value, label) {
  const entry = requireRecord(value, label);
  assertAllowedKeys(entry, [
    'eventId', 'ts', 'name', 'unit', 'value', 'connectionEpoch', 'turnId',
    'generationId', 'providerResponseId', 'visualCueId', 'semanticObjectId',
    'dimensions', 'legacy',
  ], label);
  const eventId = readSafePositiveInteger(entry.eventId, `${label}.eventId`);
  const ts = readSafeNonNegativeInteger(entry.ts, `${label}.ts`);
  for (const field of [
    'turnId', 'generationId', 'providerResponseId', 'visualCueId', 'semanticObjectId',
  ]) {
    if (entry[field] !== undefined) readBoundedString(entry[field], `${label}.${field}`);
  }
  if (entry.connectionEpoch !== undefined) {
    readSafeNonNegativeInteger(entry.connectionEpoch, `${label}.connectionEpoch`);
  }
  if (entry.legacy !== undefined && entry.legacy !== true) {
    throw new Error(`${label}.legacy is invalid.`);
  }
  const name = readBoundedString(entry.name, `${label}.name`);
  const correlation = entry.providerResponseId === undefined
    ? {}
    : {
        providerResponseId: readBoundedString(
          entry.providerResponseId,
          `${label}.providerResponseId`,
        ),
      };
  if (DURATION_NAMES.has(name)) {
    if (entry.unit !== 'ms' || entry.dimensions !== undefined) {
      throw new Error(`${label} has invalid duration fields.`);
    }
    const valueNumber = name === 'board_reveal_to_narration'
      ? readSafeInteger(entry.value, `${label}.value`)
      : readSafeNonNegativeInteger(entry.value, `${label}.value`);
    return { eventId, ts, name, value: valueNumber };
  }
  if (name === 'provider_usage') {
    if (entry.unit !== 'count') throw new Error(`${label}.unit is invalid.`);
    const dimensions = projectUsage(entry.dimensions, true, `${label}.dimensions`);
    const valueNumber = readSafePositiveInteger(entry.value, `${label}.value`);
    if (valueNumber !== dimensions.totalTokens) {
      throw new Error(`${label}.value does not match totalTokens.`);
    }
    return { eventId, ts, name, value: valueNumber, dimensions };
  }
  if (name === 'telemetry_gap') {
    if (entry.unit !== 'count') throw new Error(`${label}.unit is invalid.`);
    const dimensions = requireRecord(entry.dimensions, `${label}.dimensions`);
    assertExactKeys(dimensions, ['reason'], `${label}.dimensions`);
    if (!GAP_REASONS.includes(dimensions.reason)) {
      throw new Error(`${label}.dimensions.reason is invalid.`);
    }
    return {
      eventId,
      ts,
      name,
      value: readSafePositiveInteger(entry.value, `${label}.value`),
      dimensions: { reason: dimensions.reason },
    };
  }
  if (!LIFECYCLE_NAMES.has(name) || entry.unit !== 'count' || entry.value !== 1) {
    throw new Error(`${label} has an unknown metric contract.`);
  }
  const dimensions = projectLifecycleDimensions(
    name,
    entry.dimensions,
    `${label}.dimensions`,
  );
  return { eventId, ts, name, value: 1, dimensions, ...correlation };
}

function projectLifecycleDimensions(name, value, label) {
  if (name === 'session_reconnect') {
    if (value !== undefined) throw new Error(`${label} is not allowed.`);
    return undefined;
  }
  const dimensions = requireRecord(value, label);
  if (name === 'barge_in_gate_outcome') {
    assertExactKeys(dimensions, ['outcome'], label);
    if (!['local_only_rejected', 'provider_only_rejected', 'confirmed'].includes(dimensions.outcome)) {
      throw new Error(`${label}.outcome is invalid.`);
    }
    return { outcome: dimensions.outcome };
  } else if (name === 'barge_in_cancel_outcome') {
    assertExactKeys(dimensions, ['outcome'], label);
    if (!['provider_cancelled', 'provider_completed', 'provider_failed'].includes(dimensions.outcome)) {
      throw new Error(`${label}.outcome is invalid.`);
    }
    return { outcome: dimensions.outcome };
  } else if (name === 'section_navigation') {
    assertExactKeys(
      dimensions,
      ['previousSemanticGroupId', 'nextSemanticGroupId', 'cause'],
      label,
    );
    readBoundedString(dimensions.previousSemanticGroupId, `${label}.previousSemanticGroupId`);
    readBoundedString(dimensions.nextSemanticGroupId, `${label}.nextSemanticGroupId`);
    if (!['initial_anchor', 'notice_open', 'picker', 'draft_restore'].includes(dimensions.cause)) {
      throw new Error(`${label}.cause is invalid.`);
    }
    return {
      previousSemanticGroupId: dimensions.previousSemanticGroupId,
      nextSemanticGroupId: dimensions.nextSemanticGroupId,
      cause: dimensions.cause,
    };
  } else {
    assertExactKeys(dimensions, ['objectId', 'cause'], label);
    readBoundedString(dimensions.objectId, `${label}.objectId`);
    if (!['scene_mutation', 'unknown'].includes(dimensions.cause)) {
      throw new Error(`${label}.cause is invalid.`);
    }
    return { objectId: dimensions.objectId, cause: dimensions.cause };
  }
}

function assertAscendingTimeline(timeline) {
  let previousEventId = 0;
  for (const entry of timeline) {
    if (entry.eventId <= previousEventId) {
      throw new Error('Session log timeline event IDs must be strictly ascending.');
    }
    previousEventId = entry.eventId;
  }
}

function reconstructSummary(timeline) {
  const durationState = {};
  const bargeIn = {
    localOnlyRejected: 0,
    providerOnlyRejected: 0,
    confirmed: 0,
    providerCancelled: 0,
    providerCompleted: 0,
    providerFailed: 0,
    unresolved: 0,
  };
  const confirmedByResponse = new Map();
  const resolvedByResponse = new Map();
  let uncorrelatedConfirmed = 0;
  let sectionSwitchCount = 0;
  let reconnectCount = 0;
  let tutorObjectDisappearanceCount = 0;
  const providerUsage = emptyUsage();
  const telemetryGaps = emptyGaps();

  for (const entry of timeline) {
    if (DURATION_NAMES.has(entry.name)) {
      const current = durationState[entry.name];
      if (!current) {
        durationState[entry.name] = {
          count: 1,
          min: entry.value,
          max: entry.value,
          latest: entry.value,
          total: entry.value,
        };
      } else {
        current.count = checkedAdd(current.count, 1, 'Duration count overflowed.');
        current.min = Math.min(current.min, entry.value);
        current.max = Math.max(current.max, entry.value);
        current.latest = entry.value;
        current.total = checkedAdd(
          current.total,
          entry.value,
          'Duration total overflowed.',
        );
      }
      continue;
    }
    if (entry.name === 'provider_usage') {
      addUsage(providerUsage, entry.dimensions);
      continue;
    }
    if (entry.name === 'telemetry_gap') {
      const reason = entry.dimensions.reason;
      telemetryGaps[reason] = checkedAdd(
        telemetryGaps[reason],
        entry.value,
        'Telemetry gap total overflowed.',
      );
      continue;
    }
    if (entry.name === 'barge_in_gate_outcome') {
      const outcome = entry.dimensions.outcome;
      if (outcome === 'local_only_rejected') {
        bargeIn.localOnlyRejected = checkedAdd(
          bargeIn.localOnlyRejected,
          1,
          'Barge-in count overflowed.',
        );
      } else if (outcome === 'provider_only_rejected') {
        bargeIn.providerOnlyRejected = checkedAdd(
          bargeIn.providerOnlyRejected,
          1,
          'Barge-in count overflowed.',
        );
      } else {
        bargeIn.confirmed = checkedAdd(
          bargeIn.confirmed,
          1,
          'Barge-in count overflowed.',
        );
        if (entry.providerResponseId) {
          confirmedByResponse.set(
            entry.providerResponseId,
            checkedAdd(
              confirmedByResponse.get(entry.providerResponseId) ?? 0,
              1,
              'Barge-in correlation overflowed.',
            ),
          );
        } else {
          uncorrelatedConfirmed = checkedAdd(
            uncorrelatedConfirmed,
            1,
            'Barge-in correlation overflowed.',
          );
        }
      }
      continue;
    }
    if (entry.name === 'barge_in_cancel_outcome') {
      const outcome = entry.dimensions.outcome;
      const key = outcome === 'provider_cancelled'
        ? 'providerCancelled'
        : outcome === 'provider_completed'
          ? 'providerCompleted'
          : 'providerFailed';
      bargeIn[key] = checkedAdd(
        bargeIn[key],
        1,
        'Barge-in count overflowed.',
      );
      if (entry.providerResponseId) {
        resolvedByResponse.set(
          entry.providerResponseId,
          checkedAdd(
            resolvedByResponse.get(entry.providerResponseId) ?? 0,
            1,
            'Barge-in correlation overflowed.',
          ),
        );
      }
      continue;
    }
    if (
      entry.name === 'section_navigation' &&
      entry.dimensions.cause !== 'initial_anchor'
    ) {
      sectionSwitchCount = checkedAdd(
        sectionSwitchCount,
        1,
        'Section switch count overflowed.',
      );
    } else if (entry.name === 'session_reconnect') {
      reconnectCount = checkedAdd(
        reconnectCount,
        1,
        'Reconnect count overflowed.',
      );
    } else if (entry.name === 'tutor_object_disappearance') {
      tutorObjectDisappearanceCount = checkedAdd(
        tutorObjectDisappearanceCount,
        1,
        'Disappearance count overflowed.',
      );
    }
  }

  let unresolved = uncorrelatedConfirmed;
  for (const [responseId, confirmedCount] of confirmedByResponse) {
    unresolved = checkedAdd(
      unresolved,
      Math.max(0, confirmedCount - (resolvedByResponse.get(responseId) ?? 0)),
      'Unresolved barge-in count overflowed.',
    );
  }
  bargeIn.unresolved = unresolved;

  const durations = {};
  for (const name of DURATION_NAMES) {
    const state = durationState[name];
    if (!state) continue;
    durations[name] = {
      count: state.count,
      min: state.min,
      max: state.max,
      mean: Math.round(state.total / state.count),
      latest: state.latest,
    };
  }
  return {
    durations,
    bargeIn,
    sectionSwitchCount,
    reconnectCount,
    tutorObjectDisappearanceCount,
    providerUsage,
    telemetryGaps,
  };
}

function assertSummaryMatchesTimeline(summary, reconstructed) {
  const durationNames = new Set([
    ...Object.keys(summary.durations),
    ...Object.keys(reconstructed.durations),
  ]);
  if (
    durationNames.size !== Object.keys(summary.durations).length ||
    durationNames.size !== Object.keys(reconstructed.durations).length ||
    [...durationNames].some((name) =>
      !sameNumericRecord(
        summary.durations[name] ?? {},
        reconstructed.durations[name] ?? {},
      ))
  ) {
    throw new Error('Duration summary does not match timeline rows.');
  }
  if (!sameNumericRecord(summary.bargeIn, reconstructed.bargeIn)) {
    throw new Error('Barge-in summary does not match timeline rows.');
  }
  for (const key of [
    'sectionSwitchCount',
    'reconnectCount',
    'tutorObjectDisappearanceCount',
  ]) {
    if (summary[key] !== reconstructed[key]) {
      throw new Error(`${key} does not match timeline rows.`);
    }
  }
  if (!sameNumericRecord(summary.providerUsage, reconstructed.providerUsage)) {
    throw new Error('Provider usage summary does not match timeline rows.');
  }
  if (!sameNumericRecord(summary.telemetryGaps, reconstructed.telemetryGaps)) {
    throw new Error('Telemetry gap summary does not match timeline rows.');
  }
}

function projectUsage(value, requirePositive, label) {
  const usage = requireRecord(value, label);
  assertExactKeys(usage, USAGE_KEYS, label);
  const projected = Object.fromEntries(USAGE_KEYS.map((key) => [
    key,
    readSafeNonNegativeInteger(usage[key], `${label}.${key}`),
  ]));
  if (requirePositive && projected.totalTokens <= 0) {
    throw new Error(`${label}.totalTokens must be positive.`);
  }
  const categorizedTotal = projected.inputTextTokens + projected.inputAudioTokens
    + projected.inputImageTokens + projected.outputTextTokens
    + projected.outputAudioTokens;
  if (!Number.isSafeInteger(categorizedTotal) || categorizedTotal !== projected.totalTokens) {
    throw new Error(`${label}.totalTokens is inconsistent.`);
  }
  return projected;
}

function projectGaps(value) {
  const gaps = requireRecord(value, 'log.summary.telemetryGaps');
  assertExactKeys(gaps, GAP_REASONS, 'log.summary.telemetryGaps');
  return Object.fromEntries(GAP_REASONS.map((reason) => [
    reason,
    readSafeNonNegativeInteger(gaps[reason], `log.summary.telemetryGaps.${reason}`),
  ]));
}

function emptyUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
}

function emptyGaps() {
  return Object.fromEntries(GAP_REASONS.map((reason) => [reason, 0]));
}

function addUsage(total, usage) {
  for (const key of USAGE_KEYS) {
    total[key] = checkedAdd(
      total[key],
      usage[key],
      'Provider usage total overflowed.',
    );
  }
}

function checkedAdd(left, right, message) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error(message);
  return value;
}

function sameNumericRecord(left, right) {
  return Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([key, value]) => right[key] === value);
}

function assertExactKeys(record, expected, label) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unexpected or missing fields.`);
  }
}

function assertAllowedKeys(record, allowed, label) {
  const allowlist = new Set(allowed);
  if (Object.keys(record).some((key) => !allowlist.has(key))) {
    throw new Error(`${label} contains unexpected fields.`);
  }
}

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function readBoundedString(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new Error(`${label} must be a bounded string.`);
  }
  return value;
}

function readSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`);
  return value;
}

function readSafeNonNegativeInteger(value, label) {
  const integer = readSafeInteger(value, label);
  if (integer < 0) throw new Error(`${label} must be non-negative.`);
  return integer;
}

function readSafePositiveInteger(value, label) {
  const integer = readSafeNonNegativeInteger(value, label);
  if (integer < 1) throw new Error(`${label} must be positive.`);
  return integer;
}

function readHttpOrigin(value, label) {
  const stringValue = readBoundedString(value, label);
  const parsed = new URL(stringValue);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== stringValue) {
    throw new Error(`${label} must be an HTTP(S) origin.`);
  }
  return parsed.origin;
}
