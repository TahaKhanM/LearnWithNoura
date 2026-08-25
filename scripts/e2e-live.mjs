// Prepared synthetic journey: home -> learner -> lesson -> parent telemetry.
// Normal execution can reach the configured provider and requires authorization.
// --help and --report-fixture are offline-only and make no live evidence claim.
import { mkdir, readFile, stat } from 'node:fs/promises';
import { projectObservation } from './e2e-live-schema.mjs';

const MAX_RETAINED_COUNT = 10_000;
const MAX_RETAINED_MILESTONES = 32;
const MAX_RETAINED_ELAPSED_MS = 86_400_000;
const MILESTONE_LABELS = new Set([
  'home_loaded',
  'synthetic_learner_created',
  'lesson_page_loaded',
  'lesson_started',
  'first_caption_observed',
  'first_board_mark_observed',
  'first_board_mark_absent_after_40s',
  'synthetic_speech_transcript_observed',
  'synthetic_speech_transcript_absent_after_45s',
  'synthetic_text_interruption_sent',
  'parent_dashboard_loaded',
  'telemetry_log_retrieved',
]);
const HELP = `Prepared Noura synthetic live smoke reporter

Usage:
  NOURA_BASE_URL=https://example.test npm run e2e:live -- --authorized-live-run --text-only
  NOURA_BASE_URL=https://example.test npm run e2e:live -- --authorized-live-run synthetic.wav
  npm run e2e:live -- --report-fixture fixture.json --text-only

Options:
  --authorized-live-run       Explicitly authorize a non-fixture browser/provider journey.
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

class SmokeReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SmokeReportError';
    this.code = code;
  }
}

await main(process.argv.slice(2));

async function main(argv) {
  const context = {
    authorizedLiveRun: argv.includes('--authorized-live-run'),
    baseUrl: null,
    offlineFixture: argv.includes('--report-fixture'),
    providerReportedCostUsd: null,
    scenario: inferScenario(argv),
  };

  try {
    const options = parseArguments(argv);
    context.authorizedLiveRun = options.authorizedLiveRun;
    context.offlineFixture = Boolean(options.reportFixturePath);
    context.scenario = options.wavPath ? 'wav' : 'text_only';

    const baseUrl = parseBaseUrl(process.env.NOURA_BASE_URL);
    context.baseUrl = baseUrl;
    const providerReportedCostUsd = parseProviderReportedCost(
      process.env.NOURA_PROVIDER_REPORTED_COST_USD,
    );
    context.providerReportedCostUsd = providerReportedCostUsd;
    if (!options.reportFixturePath && !options.authorizedLiveRun) {
      throw new SmokeReportError(
        'authorization_required',
        'A non-fixture journey requires the explicit --authorized-live-run argument.',
      );
    }

    if (options.wavPath && !options.reportFixturePath) {
      await validateWavFile(options.wavPath);
    }

    const observation = options.reportFixturePath
      ? await loadReportFixture(options.reportFixturePath)
      : await runLiveJourney(baseUrl, options);
    const report = buildReport({
      baseUrl,
      providerReportedCostUsd,
      scenario: context.scenario,
      observation,
      offlineFixture: context.offlineFixture,
    });

    console.log(JSON.stringify(report, null, 2));
    if (!report.smokeGate.passed) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify(buildFailureReport({ ...context, error }), null, 2));
    process.exitCode = 1;
  }
}

function parseArguments(argv) {
  let authorizedLiveRun = false;
  let wavPath = null;
  let reportFixturePath = null;
  let textOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--authorized-live-run') {
      authorizedLiveRun = true;
      continue;
    }
    if (argument === '--text-only') {
      textOnly = true;
      continue;
    }
    if (argument === '--report-fixture') {
      const path = argv[index + 1];
      if (!path || path.startsWith('--')) {
        throw new SmokeReportError(
          'invalid_arguments',
          '--report-fixture requires a JSON file path.',
        );
      }
      reportFixturePath = path;
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) {
      throw new SmokeReportError('invalid_arguments', 'An unknown option was supplied.');
    }
    if (wavPath) {
      throw new SmokeReportError('invalid_arguments', 'Only one WAV path may be supplied.');
    }
    wavPath = argument;
  }

  if (wavPath && textOnly) {
    throw new SmokeReportError(
      'invalid_arguments',
      'Choose either a WAV scenario or --text-only, not both.',
    );
  }

  return {
    authorizedLiveRun,
    reportFixturePath,
    textOnly: textOnly || !wavPath,
    wavPath,
  };
}

function parseBaseUrl(value) {
  try {
    const url = new URL(value ?? 'http://localhost:5173');
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      throw new Error();
    }
    return new URL(url.origin);
  } catch {
    throw new SmokeReportError(
      'invalid_base_url',
      'NOURA_BASE_URL must be a valid absolute HTTP or HTTPS URL.',
    );
  }
}

function parseProviderReportedCost(value) {
  if (value === undefined || value.trim() === '') return null;
  const costUsd = Number(value);
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new SmokeReportError(
      'invalid_provider_reported_cost',
      'NOURA_PROVIDER_REPORTED_COST_USD must be a finite, non-negative amount.',
    );
  }
  return costUsd;
}

async function loadReportFixture(path) {
  try {
    const fixture = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(fixture)) throw new Error();
    if (!isRecord(fixture.version)) throw new Error();
    if (!isRecord(fixture.log)) throw new Error();
    if (typeof fixture.sessionId !== 'string' || fixture.sessionId.length === 0) {
      throw new Error();
    }
    if (
      typeof fixture.elapsedSmokeDurationMs !== 'number'
      || !Number.isFinite(fixture.elapsedSmokeDurationMs)
      || fixture.elapsedSmokeDurationMs < 0
    ) {
      throw new Error();
    }
    return fixture;
  } catch {
    throw new SmokeReportError(
      'fixture_load_failed',
      'The report fixture could not be loaded as a valid fixture.',
    );
  }
}

async function validateWavFile(path) {
  try {
    const wav = await stat(path);
    if (!wav.isFile()) throw new Error();
  } catch {
    throw new SmokeReportError(
      'wav_file_unavailable',
      'The WAV scenario requires an existing readable file.',
    );
  }
}

async function runLiveJourney(url, { textOnly, wavPath }) {
  const startedAt = Date.now();
  const milestones = [];
  let browserConsoleErrorCount = 0;
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
      if (message.type() === 'error') browserConsoleErrorCount += 1;
    });
    page.on('pageerror', () => {
      browserConsoleErrorCount += 1;
    });

    await page.goto(new URL('/', url).href, { waitUntil: 'networkidle' });
    const navigatedOrigin = new URL(page.url()).origin;
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
      tutorCaptionLineCount: document.querySelectorAll(
        '.lesson__caption:not(.lesson__caption--placeholder)',
      ).length,
      learnerLineCount: document.querySelectorAll('.lesson__child-line').length,
      boardItemCount: document.querySelectorAll('.board__item').length,
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
      browserConsoleErrorCount,
      elapsedSmokeDurationMs: Date.now() - startedAt,
      journeyState,
      log,
      milestones,
      navigatedOrigin,
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
  const projected = projectObservation(observation);
  if (projected.navigatedOrigin !== url.origin) {
    throw new Error('The browser reached an unexpected origin.');
  }
  const { log, version } = projected;
  if (log.sessionId !== projected.sessionId) {
    throw new Error('The session log does not match the created session.');
  }
  const providerUsageRows = log.timeline.filter((entry) => entry.name === 'provider_usage');
  const audioRows = log.timeline.filter(
    (entry) => entry.name === 'tutor_audio_output_duration',
  );
  const hasProviderUsage = providerUsageRows.length > 0
    && log.summary.providerUsage.totalTokens > 0;
  const providerTokenUsage = hasProviderUsage
    ? { ...log.summary.providerUsage }
    : null;
  const requiredDurationNames = requiredDurationNamesForScenario(scenario);
  const missingDurationNames = requiredDurationNames.filter(
    (name) => !log.summary.durations[name],
  );
  const hasTelemetryGaps = Object.values(log.summary.telemetryGaps)
    .some((value) => value > 0);
  const missingObservationIds = [
    ...missingDurationNames.map((name) => `missing_${name}`),
    ...(!hasProviderUsage ? ['missing_provider_usage'] : []),
    ...(hasTelemetryGaps ? ['telemetry_gaps_present'] : []),
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
    ...(hasTelemetryGaps
      ? [verificationEntry(
          'complete_telemetry',
          'The session log contains explicit telemetry transport or persistence gaps.',
        )]
      : []),
    ...(log.truncated
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
    configuredBaseUrl: url.origin,
    navigatedOrigin: projected.navigatedOrigin,
    gitSha: version.gitSha,
    runtimeModelIds: {
      realtime: version.runtimeModels.realtime,
      transcription: version.runtimeModels.transcription,
      text: version.runtimeModels.text,
    },
    scenario,
    sessionId: projected.sessionId,
    elapsedSmokeDurationMs: projected.elapsedSmokeDurationMs,
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
    phase0Aggregates: log.summary,
    telemetryGaps: { ...log.summary.telemetryGaps },
    telemetryLogTruncated: log.truncated,
    smokeGate: {
      passed: missingObservationIds.length === 0 && !log.truncated,
      requiredDurationNames,
      missingObservationIds,
    },
    requiresAuthorizedLiveVerification,
    journey: buildJourneyReport(projected),
  };
}

function buildFailureReport({
  authorizedLiveRun,
  baseUrl: url,
  providerReportedCostUsd: costUsd,
  scenario,
  offlineFixture,
  error,
}) {
  const normalizedError = normalizeReportError(error, offlineFixture);
  const requiredDurationNames = requiredDurationNamesForScenario(scenario);
  const preparationStatus = offlineFixture
    ? 'offline_fixture_failed'
    : normalizedError.code === 'authorization_required'
      ? 'live_smoke_not_authorized'
      : authorizedLiveRun
        ? 'authorized_live_smoke_failed'
        : 'live_smoke_preparation_failed';
  return {
    reportSchemaVersion: '1.0.0',
    preparationStatus,
    evidenceMode: offlineFixture
      ? 'offline_fixture_only'
      : authorizedLiveRun
        ? 'authorized_live_journey_incomplete'
        : 'live_journey_not_started',
    liveProviderEvidenceVerified: false,
    liveProviderEvidenceScope: null,
    liveLatencyClaim: null,
    configuredBaseUrl: url instanceof URL ? url.origin : null,
    navigatedOrigin: null,
    scenario,
    providerReportedCostUsd: costUsd,
    providerReportedCostSource: costUsd === null
      ? null
      : 'optional_user_supplied_provider_billing_surface',
    smokeGate: {
      passed: false,
      requiredDurationNames,
      missingObservationIds: ['complete_smoke_report'],
    },
    requiresAuthorizedLiveVerification: [
      verificationEntry(
        'acoustic_onset_to_silence',
        'No target-hardware acoustic observation was completed.',
      ),
      verificationEntry('target_hardware', 'No target-hardware observation was completed.'),
      verificationEntry(
        offlineFixture
          ? 'valid_offline_fixture'
          : authorizedLiveRun
            ? 'complete_authorized_live_run'
            : 'explicit_live_authorization',
        normalizedError.message,
      ),
    ],
    error: {
      code: normalizedError.code,
      name: normalizedError.name,
      message: normalizedError.message,
    },
  };
}

function inferScenario(argv) {
  let skipNext = false;
  for (const argument of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (argument === '--report-fixture') {
      skipNext = true;
      continue;
    }
    if (!argument.startsWith('--')) return 'wav';
  }
  return 'text_only';
}

function requiredDurationNamesForScenario(scenario) {
  return scenario === 'wav'
    ? [
        'speech_end_to_response_started',
        'speech_end_to_first_audio',
        'tutor_audio_output_duration',
      ]
    : ['ask_to_first_audio', 'tutor_audio_output_duration'];
}

function buildJourneyReport(observation) {
  const state = isRecord(observation.journeyState) ? observation.journeyState : {};
  return {
    milestones: sanitizeMilestones(observation.milestones),
    tutorCaptionLineCount: boundedCount(state.tutorCaptionLineCount),
    learnerLineCount: boundedCount(state.learnerLineCount),
    boardItemCount: boundedCount(state.boardItemCount),
    browserConsoleErrorCount: boundedCount(observation.browserConsoleErrorCount),
  };
}

function sanitizeMilestones(value) {
  if (!Array.isArray(value)) return [];
  const milestones = [];
  for (const candidate of value) {
    if (milestones.length >= MAX_RETAINED_MILESTONES) break;
    if (
      !isRecord(candidate)
      || typeof candidate.label !== 'string'
      || !MILESTONE_LABELS.has(candidate.label)
      || typeof candidate.elapsedMs !== 'number'
      || !Number.isFinite(candidate.elapsedMs)
      || candidate.elapsedMs < 0
    ) {
      continue;
    }
    milestones.push({
      elapsedMs: Math.min(Math.round(candidate.elapsedMs), MAX_RETAINED_ELAPSED_MS),
      label: candidate.label,
    });
  }
  return milestones;
}

function boundedCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), MAX_RETAINED_COUNT);
}

function normalizeReportError(error, offlineFixture) {
  if (error instanceof SmokeReportError) {
    return error;
  }
  if (offlineFixture && error instanceof Error) {
    return new SmokeReportError('fixture_load_failed', error.message);
  }
  return new SmokeReportError(
    offlineFixture ? 'fixture_load_failed' : 'live_journey_failed',
    offlineFixture
      ? 'The report fixture could not be loaded as a valid fixture.'
      : 'The authorized live journey did not complete.',
  );
}

function verificationEntry(id, reason) {
  return { id, status: 'unverified', reason };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
