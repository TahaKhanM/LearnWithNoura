// Prepared synthetic journey: home -> learner -> lesson -> parent telemetry.
// Normal execution can reach the configured provider and requires authorization.
// --help and --report-fixture are offline-only and make no live evidence claim.
import { mkdir, readFile } from 'node:fs/promises';

const HELP = `Prepared Noura synthetic live smoke reporter

Usage:
  NOURA_BASE_URL=https://example.test node scripts/e2e-live.mjs --text-only
  NOURA_BASE_URL=https://example.test node scripts/e2e-live.mjs synthetic.wav
  node scripts/e2e-live.mjs --report-fixture fixture.json --text-only

Options:
  --text-only                 Type the synthetic learner interruption; no microphone.
  --report-fixture <path>     Build the report from an offline deterministic fixture.
  --help                      Show this offline help without opening a browser.

Environment:
  NOURA_BASE_URL                       Application origin (default: http://localhost:5173)
  NOURA_PROVIDER_REPORTED_COST_USD     Optional user-supplied USD amount copied from
                                       the provider billing surface

Showing this help or using --report-fixture is offline preparation and does not verify live provider evidence.
Normal journey execution opens the application, may call its configured provider, and must not run without
explicit authorization.`;

if (process.argv.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}

const baseUrl = new URL(process.env.NOURA_BASE_URL ?? 'http://localhost:5173');
const providerReportedCostUsd = process.env.NOURA_PROVIDER_REPORTED_COST_USD
  ? Number(process.env.NOURA_PROVIDER_REPORTED_COST_USD)
  : null;

const options = parseArguments(process.argv.slice(2));
validateConfiguration(baseUrl, providerReportedCostUsd);

try {
  const observation = options.reportFixturePath
    ? await loadReportFixture(options.reportFixturePath)
    : await runLiveJourney(baseUrl, options);
  const report = buildReport({
    baseUrl,
    providerReportedCostUsd,
    scenario: options.wavPath ? 'wav' : 'text_only',
    observation,
    offlineFixture: Boolean(options.reportFixturePath),
  });

  console.log(JSON.stringify(report, null, 2));
  if (!report.smokeGate.passed) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify(buildFailureReport({
    baseUrl,
    providerReportedCostUsd,
    scenario: options.wavPath ? 'wav' : 'text_only',
    offlineFixture: Boolean(options.reportFixturePath),
    error,
  }), null, 2));
  process.exitCode = 1;
}

function parseArguments(argv) {
  let wavPath = null;
  let reportFixturePath = null;
  let textOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--text-only') {
      textOnly = true;
      continue;
    }
    if (argument === '--report-fixture') {
      const path = argv[index + 1];
      if (!path || path.startsWith('--')) {
        throw new Error('--report-fixture requires a JSON file path.');
      }
      reportFixturePath = path;
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (wavPath) {
      throw new Error('Only one WAV path may be supplied.');
    }
    wavPath = argument;
  }

  if (wavPath && textOnly) {
    throw new Error('Choose either a WAV scenario or --text-only, not both.');
  }

  return {
    reportFixturePath,
    textOnly: textOnly || !wavPath,
    wavPath,
  };
}

function validateConfiguration(url, costUsd) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('NOURA_BASE_URL must use http or https.');
  }
  if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) {
    throw new Error(
      'NOURA_PROVIDER_REPORTED_COST_USD must be a finite, non-negative user-supplied amount.',
    );
  }
}

async function loadReportFixture(path) {
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(fixture)) throw new Error('Report fixture must be a JSON object.');
  if (!isRecord(fixture.version)) throw new Error('Report fixture must include version.');
  if (!isRecord(fixture.log)) throw new Error('Report fixture must include log.');
  if (typeof fixture.sessionId !== 'string' || fixture.sessionId.length === 0) {
    throw new Error('Report fixture must include sessionId.');
  }
  if (
    typeof fixture.elapsedSmokeDurationMs !== 'number'
    || !Number.isFinite(fixture.elapsedSmokeDurationMs)
    || fixture.elapsedSmokeDurationMs < 0
  ) {
    throw new Error('Report fixture must include a non-negative elapsedSmokeDurationMs.');
  }
  return fixture;
}

async function runLiveJourney(url, { textOnly, wavPath }) {
  const startedAt = Date.now();
  const milestones = [];
  const browserConsoleErrors = [];
  const mark = (label) => milestones.push({ elapsedMs: Date.now() - startedAt, label });
  const shots = '/tmp/noura-shots';
  await mkdir(shots, { recursive: true });

  const browserArgs = ['--autoplay-policy=no-user-gesture-required'];
  if (!textOnly) {
    browserArgs.push(
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
    );
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: browserArgs });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: textOnly ? [] : ['microphone'],
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') browserConsoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => browserConsoleErrors.push(String(error)));

    await page.goto(new URL('/', url).href, { waitUntil: 'networkidle' });
    mark('home_loaded');
    await page.screenshot({ path: `${shots}/e2e-home.png` });

    const hasChild = await page.locator('.home__child').count();
    if (hasChild === 0) {
      await page.fill('input[aria-label="New learner name"]', 'Maya');
      await page.fill('input[aria-label="Age"]', '10');
      await page.click('.home__add button');
      await page.waitForSelector('.home__child');
      mark('synthetic_learner_created');
    }

    await page.fill(
      '[data-testid=goal-input]',
      'Why do the angles of a triangle add up to 180 degrees?',
    );
    await page.click('[data-testid=start-session]');
    await page.waitForURL(
      (lessonUrl) => /^\/lesson\/[^/]+\/?$/.test(lessonUrl.pathname),
      { timeout: 10_000 },
    );
    await page.waitForSelector('[data-testid=start-lesson]', { timeout: 10_000 });
    const sessionId = sessionIdFromLessonUrl(page.url());
    mark('lesson_page_loaded');
    await page.screenshot({ path: `${shots}/e2e-prestart.png` });

    await page.click('[data-testid=start-lesson]');
    mark('lesson_started');
    await page.waitForSelector('.lesson__caption:not(.lesson__caption--placeholder)', {
      timeout: 30_000,
    });
    mark('first_caption_observed');

    try {
      await page.waitForSelector('.board__item', { timeout: 40_000 });
      mark('first_board_mark_observed');
    } catch {
      mark('first_board_mark_absent_after_40s');
    }

    await page.waitForTimeout(6_000);
    await page.screenshot({ path: `${shots}/e2e-teaching-1.png` });

    if (wavPath) {
      try {
        await page.waitForSelector('.lesson__child-line', { timeout: 45_000 });
        mark('synthetic_speech_transcript_observed');
      } catch {
        mark('synthetic_speech_transcript_absent_after_45s');
      }
    } else {
      await page.fill(
        '.lesson__ask input',
        'Wait — what does a straight line have to do with it?',
      );
      await page.click('.lesson__ask button');
      mark('synthetic_text_interruption_sent');
    }

    await page.waitForTimeout(9_000);
    await page.screenshot({ path: `${shots}/e2e-teaching-2.png` });
    const journeyState = await page.evaluate(() => ({
      captions: [...document.querySelectorAll('.lesson__caption, .lesson__child-line')]
        .map((element) => element.textContent),
      boardItems: document.querySelectorAll('.board__item').length,
      concept: document.querySelector('[data-testid=active-concept]')?.textContent ?? null,
      status: document.querySelector('.lesson__status')?.textContent ?? null,
    }));

    await page.waitForTimeout(8_000);
    await page.screenshot({ path: `${shots}/e2e-teaching-3.png` });
    await page.click('.lesson__end');
    await page.waitForURL('**/parent**', { timeout: 40_000 });
    await page.waitForSelector('.parent__card, .parent--empty', { timeout: 15_000 });
    mark('parent_dashboard_loaded');
    await page.waitForTimeout(1_200);
    await page.screenshot({ path: `${shots}/e2e-parent.png`, fullPage: true });

    // Both reads use the still-open, authenticated browser context. The
    // parent-scoped session log is the only server-side telemetry source.
    const { version, log } = await page.evaluate(async (activeSessionId) => {
      const fetchJson = async (path) => {
        const response = await fetch(path, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
        return response.json();
      };
      return {
        version: await fetchJson('/api/version'),
        log: await fetchJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/log`),
      };
    }, sessionId);
    mark('telemetry_log_retrieved');

    return {
      browserConsoleErrors: browserConsoleErrors.slice(0, 20),
      elapsedSmokeDurationMs: Date.now() - startedAt,
      journeyState,
      log,
      milestones,
      sessionId,
      version,
    };
  } finally {
    await browser.close();
  }
}

function sessionIdFromLessonUrl(value) {
  const lessonUrl = new URL(value);
  const match = /^\/lesson\/([^/]+)\/?$/.exec(lessonUrl.pathname);
  if (!match) throw new Error(`Could not capture session ID from lesson URL: ${lessonUrl.href}`);
  return decodeURIComponent(match[1]);
}

function buildReport({
  baseUrl: url,
  providerReportedCostUsd: costUsd,
  scenario,
  observation,
  offlineFixture,
}) {
  const version = requireRecord(observation.version, 'version');
  const log = requireRecord(observation.log, 'log');
  const summary = requireRecord(log.summary, 'log.summary');
  const durations = requireRecord(summary.durations, 'log.summary.durations');
  const timeline = Array.isArray(log.timeline) ? log.timeline.filter(isRecord) : [];
  const providerUsageRows = timeline.filter((entry) => entry.name === 'provider_usage');
  const audioRows = timeline.filter(
    (entry) => entry.name === 'tutor_audio_output_duration'
      && typeof entry.value === 'number'
      && Number.isFinite(entry.value),
  );
  const hasProviderUsage = providerUsageRows.length > 0;
  const providerTokenUsage = hasProviderUsage && isRecord(summary.providerUsage)
    ? summary.providerUsage
    : null;
  const requiredDurationNames = scenario === 'wav'
    ? [
        'speech_end_to_response_started',
        'speech_end_to_first_audio',
        'tutor_audio_output_duration',
      ]
    : ['ask_to_first_audio', 'tutor_audio_output_duration'];
  const missingDurationNames = requiredDurationNames.filter(
    (name) => !hasDurationAggregate(durations[name]),
  );
  const missingObservationIds = [
    ...missingDurationNames.map((name) => `missing_${name}`),
    ...(!hasProviderUsage ? ['missing_provider_usage'] : []),
  ];
  const requiresAuthorizedLiveVerification = [
    verificationEntry(
      'acoustic_onset_to_silence',
      'Synthetic browser timing cannot establish physical acoustic onset or silence.',
    ),
    verificationEntry(
      'target_hardware',
      'Device, room, microphone, speaker, and browser behavior require target-hardware evidence.',
    ),
    ...(offlineFixture
      ? [verificationEntry(
          'live_provider_run',
          'Fixture values are deterministic offline inputs, not provider-observed evidence.',
        )]
      : []),
    ...missingObservationIds.map((id) => verificationEntry(
      id,
      `The selected ${scenario} scenario did not produce this required observation.`,
    )),
    ...(log.truncated === true
      ? [verificationEntry(
          'complete_session_log',
          'The parent-scoped session log reached its bound and may be incomplete.',
        )]
      : []),
  ];

  return {
    reportSchemaVersion: '1.0.0',
    preparationStatus: offlineFixture ? 'offline_fixture' : 'authorized_live_smoke_completed',
    evidenceMode: offlineFixture
      ? 'offline_fixture_only'
      : 'authenticated_browser_and_parent_scoped_session_log',
    liveProviderEvidenceVerified: !offlineFixture && hasProviderUsage,
    liveProviderEvidenceScope: !offlineFixture && hasProviderUsage
      ? 'provider_token_usage_from_response_done_only'
      : null,
    liveLatencyClaim: null,
    baseUrl: url.href,
    gitSha: typeof version.gitSha === 'string' ? version.gitSha : null,
    runtimeModelIds: isRecord(version.runtimeModels) ? version.runtimeModels : null,
    scenario,
    sessionId: observation.sessionId,
    elapsedSmokeDurationMs: observation.elapsedSmokeDurationMs,
    totalTutorAudioOutputDurationMs: audioRows.length > 0
      ? audioRows.reduce((total, entry) => total + entry.value, 0)
      : null,
    providerTokenUsage,
    providerTokenUsageSource: hasProviderUsage
      ? offlineFixture
        ? 'offline_fixture_not_provider_evidence'
        : 'provider_response_done_session_log_projection'
      : null,
    providerReportedCostUsd: costUsd,
    providerReportedCostSource: costUsd === null
      ? null
      : 'optional_user_supplied_provider_billing_surface',
    phase0Aggregates: summary,
    telemetryLogTruncated: log.truncated === true,
    smokeGate: {
      passed: missingObservationIds.length === 0 && log.truncated !== true,
      requiredDurationNames,
      missingObservationIds,
    },
    requiresAuthorizedLiveVerification,
    journey: {
      milestones: Array.isArray(observation.milestones) ? observation.milestones : [],
      state: isRecord(observation.journeyState) ? observation.journeyState : null,
      browserConsoleErrors: Array.isArray(observation.browserConsoleErrors)
        ? observation.browserConsoleErrors
        : [],
    },
  };
}

function buildFailureReport({
  baseUrl: url,
  providerReportedCostUsd: costUsd,
  scenario,
  offlineFixture,
  error,
}) {
  return {
    reportSchemaVersion: '1.0.0',
    preparationStatus: offlineFixture ? 'offline_fixture_failed' : 'authorized_live_smoke_failed',
    evidenceMode: offlineFixture ? 'offline_fixture_only' : 'live_journey_incomplete',
    liveProviderEvidenceVerified: false,
    liveProviderEvidenceScope: null,
    liveLatencyClaim: null,
    baseUrl: url.href,
    scenario,
    providerReportedCostUsd: costUsd,
    providerReportedCostSource: costUsd === null
      ? null
      : 'optional_user_supplied_provider_billing_surface',
    smokeGate: {
      passed: false,
      missingObservationIds: ['complete_smoke_report'],
    },
    requiresAuthorizedLiveVerification: [
      verificationEntry(
        'acoustic_onset_to_silence',
        'No target-hardware acoustic observation was completed.',
      ),
      verificationEntry('target_hardware', 'No target-hardware observation was completed.'),
      verificationEntry(
        offlineFixture ? 'valid_offline_fixture' : 'complete_authorized_live_run',
        error instanceof Error ? error.message : String(error),
      ),
    ],
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function hasDurationAggregate(value) {
  return isRecord(value)
    && typeof value.count === 'number'
    && Number.isInteger(value.count)
    && value.count > 0;
}

function verificationEntry(id, reason) {
  return { id, status: 'unverified', reason };
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
