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
      NOURA_BASE_URL: 'https://smoke.example.test/base-path',
      NOURA_PROVIDER_REPORTED_COST_USD: '',
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
    navigatedOrigin: 'https://navigated.example.test',
    version: {
      gitSha: 'fixture-sha',
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
        providerUsage,
      },
      timeline: [
        { eventId: 1, ts: 1, name: 'tutor_audio_output_duration', unit: 'ms', value: 250 },
        { eventId: 2, ts: 2, name: 'tutor_audio_output_duration', unit: 'ms', value: 300 },
        {
          eventId: 3,
          ts: 3,
          name: 'provider_usage',
          unit: 'count',
          value: providerUsage.totalTokens,
          dimensions: providerUsage,
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

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /npm run e2e:live -- --authorized-live-run/);
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

test('non-fixture execution fails closed without explicit authorization', () => {
  const result = runScript(['--text-only'], {
    NOURA_BASE_URL: 'http://127.0.0.1:1',
  });

  const report = assertStructuredFailure(result, 'authorization_required');
  assert.equal(report.preparationStatus, 'live_smoke_not_authorized');
  assert.equal(report.liveProviderEvidenceVerified, false);
});

test('offline fixture reports telemetry without claiming live provider verification', () => {
  const fixture = telemetryFixture();
  const fixturePath = writeFixture('text-only', fixture);
  const result = runScript(['--report-fixture', fixturePath, '--text-only'], {
    NOURA_PROVIDER_REPORTED_COST_USD: '1.25',
  });

  assert.equal(result.status, 0, result.stderr);
  const report = parseReport(result);
  assert.equal(report.preparationStatus, 'offline_fixture');
  assert.equal(report.liveProviderEvidenceVerified, false);
  assert.equal(report.configuredBaseUrl, 'https://smoke.example.test/base-path');
  assert.equal(report.navigatedOrigin, 'https://navigated.example.test');
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

test('WAV fixture fails when speech metrics and provider usage are absent', () => {
  const emptyUsage = Object.fromEntries(Object.keys(providerUsage).map((key) => [key, 0]));
  const fixture = telemetryFixture();
  fixture.log.summary.durations = {};
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
  const fixturePath = writeFixture('privacy-sentinels', fixture);
  const result = runScript(['--report-fixture', fixturePath, '--text-only']);

  assert.equal(result.status, 0, result.stderr);
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
