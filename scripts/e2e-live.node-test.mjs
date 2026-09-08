import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./e2e-live.mjs', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const fixtureDirectory = join(tmpdir(), `noura-smoke-reporter-${process.pid}`);
mkdirSync(fixtureDirectory, { recursive: true });

after(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

function runScript(args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NOURA_BASE_URL: 'https://smoke.example.test',
      NOURA_PROVIDER_REPORTED_COST_USD: '',
      NOURA_VERCEL_PROTECTION_BYPASS: '',
      ...env,
    },
    timeout: 10_000,
  });
}

function writeFixture(name, value) {
  const path = join(fixtureDirectory, `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function parseReport(result) {
  assert.equal(result.stderr, '', `expected no stderr or stack trace:\n${result.stderr}`);
  assert.notEqual(result.stdout, '', 'expected a structured JSON report');
  return JSON.parse(result.stdout);
}

function createFakeBrowserContext() {
  const cookies = [];
  return {
    cookies,
    routeCalls: 0,
    async addCookies(values) {
      cookies.push(...structuredClone(values));
    },
    async route() {
      this.routeCalls += 1;
      throw new Error('Browser routing must not be used for the bypass.');
    },
  };
}

function createFakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ options: structuredClone(options), url });
    if (responses.length === 0) throw new Error('Unexpected fetch call.');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function fakeResponse(status, { location = null, setCookies = [] } = {}) {
  return {
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'location') return location;
        if (name.toLowerCase() === 'set-cookie') return setCookies[0] ?? null;
        return null;
      },
      getSetCookie() {
        return [...setCookies];
      },
    },
  };
}

async function bootstrapBypass(context, baseUrl, bypass, fetchImpl) {
  const { bootstrapVercelProtectionBypass } = await import(
    './e2e-live-vercel-bypass.mjs'
  );
  await bootstrapVercelProtectionBypass(context, baseUrl, bypass, fetchImpl);
}

function assertStructuredFailure(result, expectedCode, expectedRequiredDurations = [
  'ask_to_first_audio',
  'tutor_audio_output_duration',
]) {
  assert.equal(result.status, 1);
  const report = parseReport(result);
  assert.equal(report.reportSchemaVersion, '1.0.0');
  assert.equal(report.smokeGate.passed, false);
  assert.deepEqual(report.smokeGate.requiredDurationNames, expectedRequiredDurations);
  assert.equal(report.error.code, expectedCode);
  return report;
}

const providerUsage = {
  totalTokens: 180,
  inputTextTokens: 60,
  inputAudioTokens: 30,
  inputImageTokens: 0,
  cachedTextTokens: 10,
  cachedAudioTokens: 5,
  cachedImageTokens: 0,
  outputTextTokens: 35,
  outputAudioTokens: 55,
};

function telemetryFixture(overrides = {}) {
  return {
    elapsedSmokeDurationMs: 12_345,
    sessionId: 'session-fixture',
    navigatedOrigin: 'https://smoke.example.test',
    version: {
      brand: 'LearnWithNoura',
      version: '1.0.0',
      gitSha: 'fixture-sha',
      environment: 'test',
      schemaVersion: '1.0.0',
      runtimeModels: {
        realtime: 'gpt-realtime-fixture',
        transcription: 'transcription-fixture',
        text: 'text-fixture',
      },
    },
    log: {
      schemaVersion: '1.0.0',
      sessionId: 'session-fixture',
      truncated: false,
      summary: {
        durations: {
          ask_to_first_audio: { count: 1, min: 420, max: 420, mean: 420, latest: 420 },
          tutor_audio_output_duration: { count: 2, min: 250, max: 300, mean: 275, latest: 300 },
        },
        bargeIn: {
          localOnlyRejected: 0,
          providerOnlyRejected: 0,
          confirmed: 0,
          providerCancelled: 0,
          providerCompleted: 0,
          providerFailed: 0,
          unresolved: 0,
        },
        sectionSwitchCount: 1,
        reconnectCount: 0,
        tutorObjectDisappearanceCount: 0,
        providerUsage: { ...providerUsage },
        telemetryGaps: {
          server_queue_overflow: 0,
          server_persistence_failure: 0,
          server_history_failure: 0,
          server_accounting_overflow: 0,
          client_queue_overflow: 0,
        },
      },
      timeline: [
        { eventId: 1, ts: 1, name: 'ask_to_first_audio', unit: 'ms', value: 420 },
        { eventId: 2, ts: 2, name: 'tutor_audio_output_duration', unit: 'ms', value: 250 },
        { eventId: 3, ts: 3, name: 'tutor_audio_output_duration', unit: 'ms', value: 300 },
        {
          eventId: 4,
          ts: 4,
          name: 'section_navigation',
          unit: 'count',
          value: 1,
          dimensions: {
            previousSemanticGroupId: 'encoded-a',
            nextSemanticGroupId: 'encoded-b',
            cause: 'picker',
          },
        },
        {
          eventId: 5,
          ts: 5,
          name: 'provider_usage',
          unit: 'count',
          value: providerUsage.totalTokens,
          dimensions: { ...providerUsage },
        },
      ],
    },
    milestones: [{ elapsedMs: 10, label: 'home_loaded' }],
    journeyState: {
      tutorCaptionLineCount: 3,
      learnerLineCount: 2,
      boardItemCount: 4,
    },
    browserConsoleErrorCount: 1,
    ...overrides,
  };
}

test('help is immediate offline success and documents explicit authorization', () => {
  const result = runScript(['--unknown-option', '--help'], {
    NOURA_BASE_URL: 'not a URL',
    NOURA_PROVIDER_REPORTED_COST_USD: 'not a cost',
  });

  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /npm run e2e:live -- --authorized-live-run/);
  assert.match(result.stdout, /NOURA_VERCEL_PROTECTION_BYPASS/);
  assert.match(result.stdout, /does not verify live provider evidence/i);
});

test('package scripts keep deterministic reporting separate from live authorization', () => {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));

  assert.equal(
    packageJson.scripts['test:smoke-report'],
    'node --test scripts/e2e-live.node-test.mjs',
  );
  assert.equal(packageJson.scripts['e2e:live'], 'node scripts/e2e-live.mjs');
  assert.doesNotMatch(packageJson.scripts['e2e:live'], /authorized-live-run/);
});

test('Drawing vNext latency and audit metrics survive the strict report allowlist', () => {
  const fixture = telemetryFixture();
  const drawingMetrics = [
    { name: 'visual_first_paint', value: 5_200, dimensions: { lane: 'director' } },
    { name: 'visual_scene_complete', value: 7_900, dimensions: { lane: 'director' } },
    {
      name: 'director_stream_first_op', value: 4_800,
      dimensions: { model: 'gpt-5.6-luna', reasoningEffort: 'low' },
    },
    {
      name: 'vision_audit_outcome', value: 1_300,
      dimensions: { model: 'gpt-5.6-luna', reasoningEffort: 'low', outcome: 'approved' },
    },
  ];
  for (const [index, metric] of drawingMetrics.entries()) {
    fixture.log.timeline.push({
      eventId: 6 + index,
      ts: 6 + index,
      unit: 'ms',
      ...metric,
    });
    fixture.log.summary.durations[metric.name] = {
      count: 1,
      min: metric.value,
      max: metric.value,
      mean: metric.value,
      latest: metric.value,
    };
  }

  const result = runScript([
    '--report-fixture',
    writeFixture('drawing-vnext-telemetry', fixture),
    '--text-only',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = parseReport(result);
  for (const metric of drawingMetrics) {
    assert.deepEqual(report.phase0Aggregates.durations[metric.name], {
      count: 1,
      min: metric.value,
      max: metric.value,
      mean: metric.value,
      latest: metric.value,
    });
  }
});

test('Drawing telemetry rejects unknown gpt-prefixed model dimensions', () => {
  const fixture = telemetryFixture();
  fixture.log.timeline.push({
    eventId: 6,
    ts: 6,
    name: 'director_stream_first_op',
    unit: 'ms',
    value: 4_800,
    dimensions: { model: 'gpt-learner-name-2014', reasoningEffort: 'low' },
  });
  fixture.log.summary.durations.director_stream_first_op = {
    count: 1, min: 4_800, max: 4_800, mean: 4_800, latest: 4_800,
  };
  const result = runScript([
    '--report-fixture',
    writeFixture('drawing-vnext-unknown-model', fixture),
    '--text-only',
  ]);
  assert.equal(result.status, 1);
});

test('live journey readiness accepts an existing learner with no selection', () => {
  const script = readFileSync(scriptPath, 'utf8');
  const readySelector = script.match(
    /page\.goto\(new URL\('\/', url\)\.href, \{ waitUntil: 'domcontentloaded' \}\);\s*await page\.waitForSelector\(\s*'([^']+)'/,
  )?.[1];

  assert.ok(readySelector, 'expected a home readiness selector');
  assert.ok(
    readySelector.split(',').map((selector) => selector.trim()).includes('.home__child'),
    'expected a visible learner button to mark the existing-learner home as ready',
  );
});

test('non-fixture execution fails closed without explicit authorization', () => {
  const result = runScript(['--text-only'], {
    NOURA_BASE_URL: 'http://127.0.0.1:1',
  });

  const report = assertStructuredFailure(result, 'authorization_required');
  assert.equal(report.preparationStatus, 'live_smoke_not_authorized');
  assert.equal(report.liveProviderEvidenceVerified, false);
});

test('authorization_required wins over an invalid ambient Vercel bypass', () => {
  const result = runScript(['--text-only'], {
    NOURA_BASE_URL: 'https://preview.vercel.app',
    NOURA_VERCEL_PROTECTION_BYPASS: `${'S'.repeat(31)}!`,
  });

  const report = assertStructuredFailure(result, 'authorization_required');
  assert.equal(report.preparationStatus, 'live_smoke_not_authorized');
});

test('offline fixture reports telemetry without claiming live provider verification', () => {
  const fixture = telemetryFixture();
  const fixturePath = writeFixture('text-only', fixture);
  const result = runScript(['--report-fixture', fixturePath, '--text-only'], {
    NOURA_PROVIDER_REPORTED_COST_USD: '1.25',
  });

  assert.equal(result.status, 0, result.stdout || result.stderr);
  const report = parseReport(result);
  assert.equal(report.preparationStatus, 'offline_fixture');
  assert.equal(report.liveProviderEvidenceVerified, false);
  assert.equal(report.configuredBaseUrl, 'https://smoke.example.test');
  assert.equal(report.navigatedOrigin, 'https://smoke.example.test');
  assert.equal(report.gitSha, 'fixture-sha');
  assert.deepEqual(report.runtimeModelIds, fixture.version.runtimeModels);
  assert.equal(report.sessionId, 'session-fixture');
  assert.equal(report.elapsedSmokeDurationMs, 12_345);
  assert.equal(report.totalTutorAudioOutputDurationMs, 550);
  assert.deepEqual(report.providerTokenUsage, providerUsage);
  assert.equal(report.providerTokenUsageSource, 'offline_fixture_not_provider_evidence');
  assert.equal(report.providerReportedCostUsd, 1.25);
  assert.equal(report.providerReportedCostSource, 'optional_user_supplied_provider_billing_surface');
  assert.deepEqual(report.phase0Aggregates, fixture.log.summary);
  assert.deepEqual(report.smokeGate.requiredDurationNames, [
    'ask_to_first_audio',
    'tutor_audio_output_duration',
  ]);
  assert.deepEqual(
    report.requiresAuthorizedLiveVerification.map((entry) => entry.id),
    ['acoustic_onset_to_silence', 'target_hardware', 'live_provider_run'],
  );
});

test('offline fixture ignores an invalid ambient Vercel bypass', () => {
  const secret = `${'S'.repeat(31)}!`;
  const fixturePath = writeFixture('ambient-bypass-ignored', telemetryFixture());
  const result = runScript(['--report-fixture', fixturePath, '--text-only'], {
    NOURA_VERCEL_PROTECTION_BYPASS: secret,
  });

  assert.equal(result.status, 0, result.stdout || result.stderr);
  const report = parseReport(result);
  assert.equal(report.preparationStatus, 'offline_fixture');
  assert.equal(result.stdout.includes(secret), false);
});

test('argument, URL, cost, and fixture errors use the structured failure report', async (t) => {
  const fixturePath = writeFixture('valid-for-config-errors', telemetryFixture());
  const missingFixturePath = join(fixtureDirectory, 'missing.json');
  const cases = [
    {
      name: 'unknown option',
      args: ['--unknown-option'],
      env: {},
      code: 'invalid_arguments',
    },
    {
      name: 'missing fixture argument',
      args: ['--report-fixture'],
      env: {},
      code: 'invalid_arguments',
    },
    {
      name: 'malformed base URL',
      args: ['--report-fixture', fixturePath],
      env: { NOURA_BASE_URL: 'not a URL' },
      code: 'invalid_base_url',
    },
    {
      name: 'invalid provider cost',
      args: ['--report-fixture', fixturePath],
      env: { NOURA_PROVIDER_REPORTED_COST_USD: '-0.01' },
      code: 'invalid_provider_reported_cost',
    },
    {
      name: 'missing fixture file',
      args: ['--report-fixture', missingFixturePath],
      env: {},
      code: 'fixture_load_failed',
    },
  ];

  for (const row of cases) {
    await t.test(row.name, () => {
      assertStructuredFailure(runScript(row.args, row.env), row.code);
    });
  }
});

test('base URL accepts only a credential-free HTTP(S) origin and never reports URL secrets', async (t) => {
  const fixturePath = writeFixture('valid-origin-only', telemetryFixture());
  const secret = 'PRIVATE_QUERY_CREDENTIAL_SENTINEL';
  const invalidUrls = [
    `https://user:${secret}@smoke.example.test`,
    `https://smoke.example.test/private/${secret}`,
    `https://smoke.example.test/?token=${secret}`,
    `https://smoke.example.test/#${secret}`,
    'ftp://smoke.example.test',
  ];

  for (const value of invalidUrls) {
    await t.test(value.replace(secret, '[secret]'), () => {
      const result = runScript(['--report-fixture', fixturePath, '--text-only'], {
        NOURA_BASE_URL: value,
      });
      const report = assertStructuredFailure(result, 'invalid_base_url');
      assert.equal(report.configuredBaseUrl, null);
      assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
    });
  }
});

test('fixture reporting rejects redirect, session, schema, and runtime-model mismatches', async (t) => {
  const secret = 'MALICIOUS_ENDPOINT_SENTINEL';
  const cases = [
    {
      name: 'redirected origin',
      fixture: telemetryFixture({ navigatedOrigin: 'https://redirected.example.test' }),
    },
    {
      name: 'session mismatch',
      fixture: telemetryFixture({
        log: {
          ...telemetryFixture().log,
          sessionId: 'different-session',
        },
      }),
    },
    {
      name: 'log schema mismatch',
      fixture: telemetryFixture({
        log: {
          ...telemetryFixture().log,
          schemaVersion: '9.9.9',
        },
      }),
    },
    {
      name: 'version schema mismatch',
      fixture: telemetryFixture({
        version: {
          ...telemetryFixture().version,
          schemaVersion: '9.9.9',
        },
      }),
    },
    {
      name: 'arbitrary runtime model field',
      fixture: telemetryFixture({
        version: {
          ...telemetryFixture().version,
          runtimeModels: {
            ...telemetryFixture().version.runtimeModels,
            credential: secret,
          },
        },
      }),
    },
  ];

  for (const row of cases) {
    await t.test(row.name, () => {
      const result = runScript([
        '--report-fixture',
        writeFixture(`mismatch-${row.name}`, row.fixture),
        '--text-only',
      ]);
      assertStructuredFailure(result, 'fixture_load_failed');
      assert.doesNotMatch(result.stdout, new RegExp(secret));
    });
  }
});

test('provider evidence requires safe, positive, internally consistent timeline rows and matching summary totals', async (t) => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  const usageRow = (fixture) =>
    fixture.log.timeline.find((entry) => entry.name === 'provider_usage');
  const cases = [
    {
      name: 'zero provider total',
      mutate(fixture) {
        usageRow(fixture).value = 0;
        usageRow(fixture).dimensions.totalTokens = 0;
      },
    },
    {
      name: 'row value mismatch',
      mutate(fixture) {
        usageRow(fixture).value = 179;
      },
    },
    {
      name: 'row token breakdown mismatch',
      mutate(fixture) {
        usageRow(fixture).dimensions.outputAudioTokens = 54;
      },
    },
    {
      name: 'summary mismatch',
      mutate(fixture) {
        fixture.log.summary.providerUsage.totalTokens = 181;
      },
    },
    {
      name: 'unsafe duration aggregate',
      mutate(fixture) {
        fixture.log.summary.durations.ask_to_first_audio.latest = unsafe;
      },
    },
    {
      name: 'unsafe provider row',
      mutate(fixture) {
        usageRow(fixture).dimensions.inputTextTokens = unsafe;
      },
    },
    {
      name: 'provider summary addition overflow',
      mutate(fixture) {
        const row = usageRow(fixture);
        const duplicate = structuredClone(row);
        row.value = Number.MAX_SAFE_INTEGER;
        row.dimensions = {
          ...Object.fromEntries(Object.keys(row.dimensions).map((key) => [key, 0])),
          totalTokens: Number.MAX_SAFE_INTEGER,
          inputTextTokens: Number.MAX_SAFE_INTEGER,
        };
        duplicate.eventId = 6;
        duplicate.ts = 6;
        duplicate.value = 1;
        duplicate.dimensions = {
          ...Object.fromEntries(Object.keys(duplicate.dimensions).map((key) => [key, 0])),
          totalTokens: 1,
          inputTextTokens: 1,
        };
        fixture.log.timeline.push(duplicate);
      },
    },
  ];

  for (const row of cases) {
    await t.test(row.name, () => {
      const fixture = telemetryFixture();
      row.mutate(fixture);
      const result = runScript([
        '--report-fixture',
        writeFixture(`malformed-${row.name}`, fixture),
        '--text-only',
      ]);
      assertStructuredFailure(result, 'fixture_load_failed');
    });
  }
});

test('summary is reconstructed exactly from ascending lifecycle timeline rows', async (t) => {
  const cases = [
    {
      name: 'summary-only required duration',
      mutate(fixture) {
        fixture.log.timeline = fixture.log.timeline.filter(
          (entry) => entry.name !== 'ask_to_first_audio',
        );
      },
    },
    {
      name: 'lifecycle count mismatch',
      mutate(fixture) {
        fixture.log.summary.sectionSwitchCount = 2;
      },
    },
    {
      name: 'reconnect count mismatch',
      mutate(fixture) {
        fixture.log.timeline.push({
          eventId: 6,
          ts: 6,
          name: 'session_reconnect',
          unit: 'count',
          value: 1,
        });
      },
    },
    {
      name: 'disappearance count mismatch',
      mutate(fixture) {
        fixture.log.timeline.push({
          eventId: 6,
          ts: 6,
          name: 'tutor_object_disappearance',
          unit: 'count',
          value: 1,
          dimensions: { objectId: 'encoded-object', cause: 'scene_mutation' },
        });
      },
    },
    {
      name: 'unresolved barge-in correlation mismatch',
      mutate(fixture) {
        fixture.log.timeline.push(
          {
            eventId: 6,
            ts: 6,
            name: 'barge_in_gate_outcome',
            unit: 'count',
            value: 1,
            providerResponseId: 'encoded-response',
            dimensions: { outcome: 'confirmed' },
          },
          {
            eventId: 7,
            ts: 7,
            name: 'barge_in_cancel_outcome',
            unit: 'count',
            value: 1,
            providerResponseId: 'encoded-response',
            dimensions: { outcome: 'provider_completed' },
          },
        );
        fixture.log.summary.bargeIn.confirmed = 1;
        fixture.log.summary.bargeIn.providerCompleted = 1;
        fixture.log.summary.bargeIn.unresolved = 1;
      },
    },
    {
      name: 'wrong duration latest',
      mutate(fixture) {
        fixture.log.summary.durations.tutor_audio_output_duration.latest = 250;
      },
    },
    {
      name: 'wrong rounded duration mean',
      mutate(fixture) {
        fixture.log.summary.durations.tutor_audio_output_duration.mean = 274;
      },
    },
    {
      name: 'out-of-order event ids',
      mutate(fixture) {
        fixture.log.timeline[1].eventId = 3;
        fixture.log.timeline[2].eventId = 2;
      },
    },
    {
      name: 'tutor duration total overflow',
      mutate(fixture) {
        fixture.log.timeline[1].value = Number.MAX_SAFE_INTEGER;
        fixture.log.timeline[2].value = 1;
        fixture.log.summary.durations.tutor_audio_output_duration = {
          count: 2,
          min: 1,
          max: Number.MAX_SAFE_INTEGER,
          mean: 4_503_599_627_370_496,
          latest: 1,
        };
      },
    },
  ];

  for (const row of cases) {
    await t.test(row.name, () => {
      const fixture = telemetryFixture();
      row.mutate(fixture);
      const result = runScript([
        '--report-fixture',
        writeFixture(`summary-reconciliation-${row.name}`, fixture),
        '--text-only',
      ]);
      assertStructuredFailure(result, 'fixture_load_failed');
    });
  }
});

test('any telemetry gap fails the deterministic smoke gate', () => {
  const fixture = telemetryFixture();
  fixture.log.summary.telemetryGaps.client_queue_overflow = 2;
  fixture.log.timeline.push({
    eventId: 6,
    ts: 6,
    name: 'telemetry_gap',
    unit: 'count',
    value: 2,
    dimensions: { reason: 'client_queue_overflow' },
  });
  const result = runScript([
    '--report-fixture',
    writeFixture('telemetry-gap', fixture),
    '--text-only',
  ]);

  assert.equal(result.status, 1, result.stderr);
  const report = parseReport(result);
  assert.equal(report.smokeGate.passed, false);
  assert.deepEqual(report.telemetryGaps, {
    server_queue_overflow: 0,
    server_persistence_failure: 0,
    server_history_failure: 0,
    server_accounting_overflow: 0,
    client_queue_overflow: 2,
  });
  assert(report.smokeGate.missingObservationIds.includes('telemetry_gaps_present'));
});

test('an observed autoplay failure fails the deterministic smoke gate', () => {
  const fixture = telemetryFixture();
  fixture.log.timeline.push({
    eventId: 6,
    ts: 6,
    name: 'media_playback_outcome',
    unit: 'count',
    value: 1,
    dimensions: { outcome: 'autoplay_blocked' },
  });
  const result = runScript([
    '--report-fixture',
    writeFixture('media-playback-failure', fixture),
    '--text-only',
  ]);

  assert.equal(result.status, 1, result.stderr);
  const report = parseReport(result);
  assert.equal(report.smokeGate.passed, false);
  assert(report.smokeGate.missingObservationIds.includes('media_playback_failures_present'));
  assert.deepEqual(report.mediaPlaybackOutcomes, ['autoplay_blocked']);
});

test('a deliberately suppressed response can be not_played without failing the smoke gate', () => {
  const fixture = telemetryFixture();
  fixture.log.timeline.push({
    eventId: 6,
    ts: 6,
    name: 'media_playback_outcome',
    unit: 'count',
    value: 1,
    dimensions: { outcome: 'not_played' },
  });
  const result = runScript([
    '--report-fixture',
    writeFixture('media-playback-suppressed', fixture),
    '--text-only',
  ]);

  const report = parseReport(result);
  assert(!report.smokeGate.missingObservationIds.includes('media_playback_failures_present'));
  assert.deepEqual(report.mediaPlaybackOutcomes, ['not_played']);
});

test('WAV fixture fails when speech metrics and provider usage are absent', () => {
  const emptyUsage = Object.fromEntries(Object.keys(providerUsage).map((key) => [key, 0]));
  const fixture = telemetryFixture();
  fixture.log.summary.durations = {};
  fixture.log.summary.sectionSwitchCount = 0;
  fixture.log.summary.providerUsage = emptyUsage;
  fixture.log.timeline = [];
  const fixturePath = writeFixture('wav-missing-observations', fixture);
  const result = runScript(['synthetic.wav', '--report-fixture', fixturePath]);

  assert.equal(result.status, 1, result.stderr);
  const report = parseReport(result);
  const required = report.requiresAuthorizedLiveVerification.map((entry) => entry.id);
  assert(required.includes('missing_speech_end_to_response_started'));
  assert(required.includes('missing_speech_end_to_first_audio'));
  assert(required.includes('missing_tutor_audio_output_duration'));
  assert(required.includes('missing_provider_usage'));
  assert.deepEqual(report.smokeGate.requiredDurationNames, [
    'speech_end_to_response_started',
    'speech_end_to_first_audio',
    'tutor_audio_output_duration',
  ]);
  assert.equal(report.liveProviderEvidenceVerified, false);
});

test('truncated logs fail the deterministic smoke gate', () => {
  const fixture = telemetryFixture();
  fixture.log.truncated = true;
  const fixturePath = writeFixture('truncated-log', fixture);
  const result = runScript(['--report-fixture', fixturePath, '--text-only']);

  assert.equal(result.status, 1, result.stderr);
  const report = parseReport(result);
  assert.equal(report.telemetryLogTruncated, true);
  assert.equal(report.smokeGate.passed, false);
  assert(
    report.requiresAuthorizedLiveVerification.some(
      (entry) => entry.id === 'complete_session_log',
    ),
  );
});

test('retained report serializes counts and hardcoded labels without raw browser text', () => {
  const tutorSecret = 'SECRET_TUTOR_CAPTION_SENTINEL';
  const learnerSecret = 'SECRET_LEARNER_TEXT_SENTINEL';
  const consoleSecret = 'SECRET_BROWSER_CONSOLE_ERROR_SENTINEL';
  const milestoneSecret = 'SECRET_DYNAMIC_MILESTONE_SENTINEL';
  const fixture = telemetryFixture({
    browserConsoleErrors: [consoleSecret],
    browserConsoleErrorCount: 7,
    journeyState: {
      captions: [tutorSecret, learnerSecret],
      concept: tutorSecret,
      status: learnerSecret,
      tutorCaptionLineCount: 3,
      learnerLineCount: 2,
      boardItemCount: 4,
    },
    milestones: [
      { elapsedMs: 10, label: 'home_loaded' },
      { elapsedMs: 20, label: milestoneSecret },
    ],
  });
  fixture.log.timeline[4].turnId = tutorSecret;
  fixture.log.timeline[4].generationId = learnerSecret;
  fixture.log.timeline[4].providerResponseId = consoleSecret;
  fixture.log.timeline[4].semanticObjectId = milestoneSecret;
  const fixturePath = writeFixture('privacy-sentinels', fixture);
  const result = runScript(['--report-fixture', fixturePath, '--text-only']);

  assert.equal(result.status, 0, result.stdout || result.stderr);
  const report = parseReport(result);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(tutorSecret));
  assert.doesNotMatch(serialized, new RegExp(learnerSecret));
  assert.doesNotMatch(serialized, new RegExp(consoleSecret));
  assert.doesNotMatch(serialized, new RegExp(milestoneSecret));
  assert.deepEqual(report.journey, {
    milestones: [{ elapsedMs: 10, label: 'home_loaded' }],
    tutorCaptionLineCount: 3,
    learnerLineCount: 2,
    boardItemCount: 4,
    captionMutationCount: 0,
    adjacentDuplicateCaptionCount: 0,
    distinctCaptionCount: 0,
    browserConsoleErrorCount: 7,
  });
});

test('authorized WAV preparation validates the file before browser launch', () => {
  const result = runScript([
    join(fixtureDirectory, 'missing-audio.wav'),
    '--authorized-live-run',
  ]);

  assertStructuredFailure(
    result,
    'wav_file_unavailable',
    [
      'speech_end_to_response_started',
      'speech_end_to_first_audio',
      'tutor_audio_output_duration',
    ],
  );
});

test('authorized live preparation rejects an invalid Vercel protection bypass', () => {
  const result = runScript([
    join(fixtureDirectory, 'missing-audio.wav'),
    '--authorized-live-run',
  ], {
    NOURA_VERCEL_PROTECTION_BYPASS: 'A'.repeat(31),
  });

  const report = assertStructuredFailure(
    result,
    'invalid_vercel_protection_bypass',
    [
      'speech_end_to_response_started',
      'speech_end_to_first_audio',
      'tutor_audio_output_duration',
    ],
  );
  assert.equal(
    report.error.message,
    'NOURA_VERCEL_PROTECTION_BYPASS must be exactly 32 ASCII alphanumeric characters.',
  );
});

test('invalid Vercel protection bypass is never disclosed', () => {
  const secret = `${'S'.repeat(31)}!`;
  const result = runScript([
    join(fixtureDirectory, 'missing-audio.wav'),
    '--authorized-live-run',
  ], {
    NOURA_VERCEL_PROTECTION_BYPASS: secret,
  });

  const report = assertStructuredFailure(
    result,
    'invalid_vercel_protection_bypass',
    [
      'speech_end_to_response_started',
      'speech_end_to_first_audio',
      'tutor_audio_output_duration',
    ],
  );
  assert.equal(
    report.error.message,
    'NOURA_VERCEL_PROTECTION_BYPASS must be exactly 32 ASCII alphanumeric characters.',
  );
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('valid Vercel protection bypass accepts exact and subdomain vercel.app targets', async (t) => {
  const secret = `${'aB3'.repeat(10)}aB`;
  for (const baseUrl of ['https://vercel.app', 'https://preview.vercel.app']) {
    await t.test(baseUrl, () => {
      const result = runScript([
        join(fixtureDirectory, 'missing-audio.wav'),
        '--authorized-live-run',
      ], {
        NOURA_BASE_URL: baseUrl,
        NOURA_VERCEL_PROTECTION_BYPASS: secret,
      });

      assertStructuredFailure(
        result,
        'wav_file_unavailable',
        [
          'speech_end_to_response_started',
          'speech_end_to_first_audio',
          'tutor_audio_output_duration',
        ],
      );
      assert.equal(result.stdout.includes(secret), false);
      assert.equal(result.stderr.includes(secret), false);
    });
  }
});

test('33-character alphanumeric Vercel protection bypass is rejected', () => {
  const result = runScript([
    join(fixtureDirectory, 'missing-audio.wav'),
    '--authorized-live-run',
  ], {
    NOURA_VERCEL_PROTECTION_BYPASS: 'A'.repeat(33),
  });

  assertStructuredFailure(
    result,
    'invalid_vercel_protection_bypass',
    [
      'speech_end_to_response_started',
      'speech_end_to_first_audio',
      'tutor_audio_output_duration',
    ],
  );
});

test('configured bypass requires an HTTPS vercel.app target', async (t) => {
  const secret = `${'aB3'.repeat(10)}aB`;
  const targets = [
    'http://preview.vercel.app',
    'https://preview.vercel.app.evil.test',
    'https://evilvercel.app',
  ];

  for (const baseUrl of targets) {
    await t.test(baseUrl, () => {
      const result = runScript([
        join(fixtureDirectory, 'missing-audio.wav'),
        '--authorized-live-run',
      ], {
        NOURA_BASE_URL: baseUrl,
        NOURA_VERCEL_PROTECTION_BYPASS: secret,
      });
      const report = assertStructuredFailure(
        result,
        'invalid_vercel_protection_target',
        [
          'speech_end_to_response_started',
          'speech_end_to_first_audio',
          'tutor_audio_output_duration',
        ],
      );
      assert.equal(
        report.error.message,
        'NOURA_VERCEL_PROTECTION_BYPASS requires an HTTPS vercel.app deployment URL.',
      );
      assert.equal(result.stdout.includes(secret), false);
    });
  }
});

test('bypass bootstrap fetches the exact base URL and injects only the Vercel cookie', async () => {
  const context = createFakeBrowserContext();
  const baseUrl = new URL('https://preview.vercel.app');
  const secret = `${'aB3'.repeat(10)}aB`;
  const fetchImpl = createFakeFetch([
    fakeResponse(200, {
      setCookies: [
        'unrelated=value; Path=/',
        '_vercel_jwt=host-bound-token; Path=/; Secure; HttpOnly; SameSite=Lax',
      ],
    }),
  ]);

  await bootstrapBypass(context, baseUrl, secret, fetchImpl);

  assert.deepEqual(fetchImpl.calls, [{
    url: 'https://preview.vercel.app/',
    options: {
      headers: {
        'x-vercel-protection-bypass': secret,
        'x-vercel-set-bypass-cookie': 'true',
      },
      redirect: 'manual',
    },
  }]);
  assert.deepEqual(context.cookies, [{
    httpOnly: true,
    name: '_vercel_jwt',
    sameSite: 'Lax',
    secure: true,
    value: 'host-bound-token',
    url: 'https://preview.vercel.app',
  }]);
  assert.equal(context.routeCalls, 0);
});

test('bypass bootstrap accepts a cookie from a self-redirect response', async () => {
  const context = createFakeBrowserContext();
  const baseUrl = new URL('https://preview.vercel.app');
  const fetchImpl = createFakeFetch([
    fakeResponse(302, {
      location: '/',
      setCookies: ['_vercel_jwt=self-redirect-token; Path=/; Secure; HttpOnly'],
    }),
  ]);

  await bootstrapBypass(
    context,
    baseUrl,
    `${'aB3'.repeat(10)}aB`,
    fetchImpl,
  );

  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(context.cookies, [{
    httpOnly: true,
    name: '_vercel_jwt',
    sameSite: 'Lax',
    secure: true,
    value: 'self-redirect-token',
    url: 'https://preview.vercel.app',
  }]);
  assert.equal(context.routeCalls, 0);
});

test('bypass bootstrap follows only bounded same-origin redirects', async () => {
  const context = createFakeBrowserContext();
  const baseUrl = new URL('https://preview.vercel.app');
  const secret = `${'aB3'.repeat(10)}aB`;
  const fetchImpl = createFakeFetch([
    fakeResponse(307, { location: '/bootstrap-step' }),
    fakeResponse(302, {
      location: 'https://preview.vercel.app/ready',
    }),
    fakeResponse(204, {
      setCookies: ['_vercel_jwt=redirect-token; Path=/; Secure; HttpOnly'],
    }),
  ]);

  await bootstrapBypass(context, baseUrl, secret, fetchImpl);

  assert.deepEqual(
    fetchImpl.calls.map(({ url }) => url),
    [
      'https://preview.vercel.app/',
      'https://preview.vercel.app/bootstrap-step',
      'https://preview.vercel.app/ready',
    ],
  );
  assert(
    fetchImpl.calls.every(({ options }) =>
      options.redirect === 'manual'
      && options.headers['x-vercel-protection-bypass'] === secret
      && options.headers['x-vercel-set-bypass-cookie'] === 'true'
    ),
  );
  assert.deepEqual(context.cookies, [{
    httpOnly: true,
    name: '_vercel_jwt',
    sameSite: 'Lax',
    secure: true,
    value: 'redirect-token',
    url: 'https://preview.vercel.app',
  }]);
  assert.equal(context.routeCalls, 0);
});

test('bypass bootstrap never follows an off-origin redirect', async () => {
  const context = createFakeBrowserContext();
  const baseUrl = new URL('https://preview.vercel.app');
  const secret = `${'aB3'.repeat(10)}aB`;
  const fetchImpl = createFakeFetch([
    fakeResponse(302, { location: 'https://attacker.example.test/capture' }),
  ]);

  await assert.rejects(
    bootstrapBypass(context, baseUrl, secret, fetchImpl),
    (error) => {
      assert.equal(error.message, 'The Vercel protection bypass bootstrap failed.');
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(context.cookies, []);
  assert.equal(context.routeCalls, 0);
});

test('bypass bootstrap fails closed without disclosing response data', async (t) => {
  const secret = `${'aB3'.repeat(10)}aB`;
  const cases = [
    {
      name: 'network error',
      responses: [new Error(secret)],
    },
    {
      name: 'missing cookie',
      responses: [fakeResponse(200)],
    },
    {
      name: 'malformed allowlisted cookie',
      responses: [fakeResponse(200, {
        setCookies: [`_vercel_jwt=${secret} invalid; Path=/`],
      })],
    },
    {
      name: 'non-success terminal response',
      responses: [fakeResponse(403, {
        setCookies: [`unrelated=${secret}; Path=/`],
      })],
    },
    {
      name: 'self-redirect without cookie',
      responses: [fakeResponse(302, { location: '/' })],
    },
    {
      name: 'redirect bound exceeded',
      responses: [
        fakeResponse(302, { location: '/one' }),
        fakeResponse(302, { location: '/two' }),
        fakeResponse(302, { location: '/three' }),
        fakeResponse(302, { location: '/four' }),
        fakeResponse(302, { location: '/five' }),
      ],
    },
  ];

  for (const row of cases) {
    await t.test(row.name, async () => {
      const context = createFakeBrowserContext();
      const fetchImpl = createFakeFetch(row.responses);
      await assert.rejects(
        bootstrapBypass(
          context,
          new URL('https://preview.vercel.app'),
          secret,
          fetchImpl,
        ),
        (error) => {
          assert.equal(error.message, 'The Vercel protection bypass bootstrap failed.');
          assert.equal(error.message.includes(secret), false);
          return true;
        },
      );
      assert.deepEqual(context.cookies, []);
      assert.equal(context.routeCalls, 0);
    });
  }
});

test('bypass bootstrap safely does nothing when bypass is absent', async () => {
  const context = createFakeBrowserContext();
  const baseUrl = new URL('https://preview.vercel.app');
  const fetchImpl = createFakeFetch([]);

  await bootstrapBypass(context, baseUrl, undefined, fetchImpl);
  await bootstrapBypass(context, baseUrl, null, fetchImpl);

  assert.deepEqual(fetchImpl.calls, []);
  assert.deepEqual(context.cookies, []);
  assert.equal(context.routeCalls, 0);
});
