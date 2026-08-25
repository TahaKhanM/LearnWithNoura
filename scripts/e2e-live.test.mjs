import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./e2e-live.mjs', import.meta.url));

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
  const path = join(tmpdir(), `noura-${process.pid}-${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
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
    ...overrides,
  };
}

test('help describes offline preparation without opening the live journey', () => {
  const result = runScript(['--help'], { NOURA_BASE_URL: 'http://127.0.0.1:1' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NOURA_BASE_URL/);
  assert.match(result.stdout, /authorization/i);
  assert.match(result.stdout, /does not verify live provider evidence/i);
});

test('offline fixture reports telemetry without claiming live provider verification', () => {
  const fixturePath = writeFixture('text-only', telemetryFixture());
  const result = runScript(['--report-fixture', fixturePath, '--text-only'], {
    NOURA_PROVIDER_REPORTED_COST_USD: '1.25',
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.preparationStatus, 'offline_fixture');
  assert.equal(report.liveProviderEvidenceVerified, false);
  assert.equal(report.baseUrl, 'https://smoke.example.test/base-path');
  assert.equal(report.gitSha, 'fixture-sha');
  assert.deepEqual(report.runtimeModelIds, telemetryFixture().version.runtimeModels);
  assert.equal(report.sessionId, 'session-fixture');
  assert.equal(report.elapsedSmokeDurationMs, 12_345);
  assert.equal(report.totalTutorAudioOutputDurationMs, 550);
  assert.deepEqual(report.providerTokenUsage, providerUsage);
  assert.equal(report.providerTokenUsageSource, 'offline_fixture_not_provider_evidence');
  assert.equal(report.providerReportedCostUsd, 1.25);
  assert.equal(report.providerReportedCostSource, 'optional_user_supplied_provider_billing_surface');
  assert.deepEqual(report.phase0Aggregates, telemetryFixture().log.summary);
  assert.deepEqual(
    report.requiresAuthorizedLiveVerification.map((entry) => entry.id),
    ['acoustic_onset_to_silence', 'target_hardware', 'live_provider_run'],
  );
});

test('WAV fixture exits nonzero when speech metrics and provider usage are absent', () => {
  const emptyUsage = Object.fromEntries(Object.keys(providerUsage).map((key) => [key, 0]));
  const fixture = telemetryFixture();
  fixture.log.summary.durations = {};
  fixture.log.summary.providerUsage = emptyUsage;
  fixture.log.timeline = [];
  const fixturePath = writeFixture('wav-missing', fixture);
  const result = runScript(['synthetic.wav', '--report-fixture', fixturePath]);

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  const required = report.requiresAuthorizedLiveVerification.map((entry) => entry.id);
  assert(required.includes('missing_speech_end_to_response_started'));
  assert(required.includes('missing_speech_end_to_first_audio'));
  assert(required.includes('missing_tutor_audio_output_duration'));
  assert(required.includes('missing_provider_usage'));
  assert.equal(report.liveProviderEvidenceVerified, false);
});
