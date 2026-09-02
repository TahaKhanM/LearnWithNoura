import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CharacterAttentionController, attentionPriority } from '../src/lesson/characterAttention.js';
import { ResponseCueTimeline, type ResponseCue } from '../src/lesson/responseTimeline.js';
import { ResponseCaptionTimeline } from '../src/lesson/captionTimeline.js';

const outputDir = resolve(process.argv[2] ?? 'artifacts/evaluation');
mkdirSync(outputDir, { recursive: true });

const RATE = 24_000;
const FRAME_MS = 1000 / 60;
const identity = { sessionId: 'offline-eval', connectionEpoch: 1, turnId: 'turn-1', generationId: 'generation-1' };
const seededContract = { responseStartMs: 120, captionMs: 280, visualMs: 340, responseCompleteMs: 780, detectorMs: 1000 };
const samples = synthesizeWaveform(2_000, 120, 1_020, seededContract.detectorMs);
const timeline = new ResponseCueTimeline();
const captions = new ResponseCaptionTimeline();
const attention = new CharacterAttentionController(identity);
captions.registerResponse('response-1', true);
timeline.enqueue(visual('visual-1', 'visual-1-boundary', 2));
timeline.enqueue(visual('visual-future', 'visual-future-boundary', 5));
const visualReleaseAt = new Map([
  ['visual-1-boundary', seededContract.visualMs],
  ['visual-future-boundary', 1_160],
]);

type ObservedEvent = { type: string; ms: number; cueId?: string };
type RuntimeFrame = { ms: number; gazeTarget: string; mouthEnergy: number; pendingCues: number };
const observedEvents: ObservedEvent[] = [];
const frames: RuntimeFrame[] = [];
let cancelled = false;
let staleCueWriteAccepted = 0;
let captionDeltaSent = false;
let responseFinalized = false;
let captionVisible = false;

for (let frame = 0, ms = 0; ms <= 2_000; frame += 1, ms = frame * FRAME_MS) {
  if (!cancelled && ms >= seededContract.detectorMs) {
    cancelled = true;
    observedEvents.push({ type: 'detector', ms });
    timeline.cancel(identity);
    captions.interrupt('response-1');
    attention.cancelGeneration(identity);
    attention.offer({ ...identity, targetType: 'interruption', priority: attentionPriority('interruption'), startTime: ms, expiryTime: ms + 900, smoothingProfile: 'immediate', permittedInReducedMotion: true });
    if (timeline.enqueue(visual('stale-after-cancel', 'stale-boundary', 6))) staleCueWriteAccepted += 1;
    observedEvents.push({ type: 'cancel_applied', ms });
  }

  if (ms >= seededContract.responseStartMs && !captionVisible) {
    captions.playbackStarted('response-1', ms);
  }
  if (ms >= seededContract.captionMs && !captionDeltaSent) {
    captionDeltaSent = true;
    captions.pushDelta('response-1', 'one teaching phrase. ', ms, true);
  }
  if (ms >= seededContract.responseCompleteMs && !responseFinalized) {
    responseFinalized = true;
    captions.finishTranscript('response-1', 'One teaching phrase.', ms, true);
    captions.playbackFinished('response-1');
    observedEvents.push({ type: 'final', ms, cueId: 'final-1' });
  }
  captions.advance(ms);
  if (!captionVisible && captions.lines().some((line) => line.responseId === 'response-1')) {
    captionVisible = true;
    observedEvents.push({ type: 'caption', ms, cueId: 'caption-1' });
  }

  for (const cue of timeline.drain((responseId) =>
    ms >= (visualReleaseAt.get(responseId) ?? Infinity) ? 'finished' : 'pending')) {
    observedEvents.push({ type: cue.kind, ms, cueId: cue.cueId });
    if (cue.kind === 'visual') attention.offer({
      ...identity, targetType: 'tutor_pen', boardCoordinates: [620, 260], priority: attentionPriority('tutor_pen'),
      startTime: ms, expiryTime: seededContract.detectorMs, smoothingProfile: 'responsive', permittedInReducedMotion: false,
    });
  }
  frames.push({
    ms: Number(ms.toFixed(3)),
    gazeTarget: attention.frame(ms).targetType,
    mouthEnergy: rmsAt(samples, ms, 12),
    pendingCues: timeline.pendingCount(),
  });
}

const sourceTrace = { observedEvents, frames, staleCueWriteAccepted };
const metrics = deriveMetrics(sourceTrace, samples);
const gateResults = evaluateGates(metrics);
const negativeControls = verifyNegativeControls(sourceTrace, samples);

const wavPath = join(outputDir, 'synthetic-interruption.wav');
writeFileSync(wavPath, wavBuffer(samples, RATE));
const reportPath = join(outputDir, 'synthetic-av-character-report.json');
writeFileSync(reportPath, `${JSON.stringify({
  evidenceType: 'deterministic-offline-production-module-trace',
  evidenceBoundary: 'ResponseCueTimeline, CharacterAttentionController, and seeded PCM only; no browser-render or device-performance claim.',
  realChildData: false,
  runtimeProviderCalls: 0,
  runtimeCostUsd: 0,
  targetHardwareAcoustics: 'UNVERIFIED',
  liveProviderBehavior: 'UNVERIFIED',
  browserFramePerformance: 'NOT_CLAIMED',
  renderedCharacterPenMouthPhase: 'NOT_CLAIMED',
  metrics,
  gateResults,
  negativeControls,
  sourceTrace,
}, null, 2)}\n`);

const ok = Object.values(gateResults).every(Boolean) && negativeControls.allIsolated;
console.log(JSON.stringify({ ok, wavPath, reportPath, metrics, gateResults, negativeControls }, null, 2));
if (!ok) process.exit(1);

function visual(cueId: string, responseId: string, sequence: number): ResponseCue {
  return { kind: 'visual', cueId, responseId, sequence, identity, ops: [], eventId: sequence, visualCueId: 'semantic-group-1', semanticObjectId: 'semantic-group-1', awaitNarration: true };
}

function deriveMetrics(trace: typeof sourceTrace, waveform: Int16Array) {
  const eventTime = (type: string, cueId?: string) => trace.observedEvents.find((event) => event.type === type && (!cueId || event.cueId === cueId))?.ms;
  const detectorAt = eventTime('detector') ?? Infinity;
  const cancelAt = eventTime('cancel_applied') ?? Infinity;
  const afterCancel = trace.frames.find((frame) => frame.ms + 0.1 >= cancelAt);
  return {
    captionCueAbsoluteErrorMs: Math.abs((eventTime('caption', 'caption-1') ?? Infinity) - seededContract.captionMs),
    visualCueAbsoluteErrorMs: Math.abs((eventTime('visual', 'visual-1') ?? Infinity) - seededContract.visualMs),
    finalCorrectionMs: (eventTime('final', 'final-1') ?? Infinity) - seededContract.responseCompleteMs,
    pendingCuesImmediatelyAfterCancel: afterCancel?.pendingCues ?? Infinity,
    staleCueWritesAcceptedAfterCancel: trace.staleCueWriteAccepted,
    postCancelAudioResumptions: countAudioResumptions(waveform, detectorAt),
    attentionTargetImmediatelyAfterCancel: afterCancel?.gazeTarget ?? 'missing',
    syntheticWaveformSilenceMs: detectSilenceMs(waveform, detectorAt),
    targetHardwareAcoustics: 'UNVERIFIED' as const,
  };
}

function evaluateGates(metrics: ReturnType<typeof deriveMetrics>) {
  return {
    captionTiming: metrics.captionCueAbsoluteErrorMs <= 350,
    visualTiming: metrics.visualCueAbsoluteErrorMs <= 500,
    finalCorrection: metrics.finalCorrectionMs <= 500,
    cancellationClearsPendingCues: metrics.pendingCuesImmediatelyAfterCancel === 0,
    staleCueWrites: metrics.staleCueWritesAcceptedAfterCancel === 0,
    postCancelAudio: metrics.postCancelAudioResumptions === 0,
    interruptionAttention: metrics.attentionTargetImmediatelyAfterCancel === 'interruption',
  };
}

type GateResults = ReturnType<typeof evaluateGates>;
type GateName = keyof GateResults;

function verifyNegativeControls(trace: typeof sourceTrace, waveform: Int16Array) {
  const cases: Record<GateName, (copy: typeof sourceTrace, pcm: Int16Array) => void> = {
    captionTiming: (copy) => { copy.observedEvents.find((event) => event.cueId === 'caption-1')!.ms += 800; },
    visualTiming: (copy) => { copy.observedEvents.find((event) => event.cueId === 'visual-1')!.ms += 800; },
    finalCorrection: (copy) => { copy.observedEvents.find((event) => event.type === 'final')!.ms += 800; },
    cancellationClearsPendingCues: (copy) => { copy.frames.find((frame) => frame.ms + 0.1 >= seededContract.detectorMs)!.pendingCues = 1; },
    staleCueWrites: (copy) => { copy.staleCueWriteAccepted = 1; },
    postCancelAudio: (_copy, pcm) => seedAudioResumption(pcm, 1_200, 80),
    interruptionAttention: (copy) => { copy.frames.find((frame) => frame.ms + 0.1 >= seededContract.detectorMs)!.gazeTarget = 'tutor_pen'; },
  };
  const baseline = evaluateGates(deriveMetrics(trace, waveform));
  const matrix = {} as Record<GateName, GateResults>;
  const isolated = {} as Record<GateName, boolean>;
  for (const gate of Object.keys(cases) as GateName[]) {
    const copy = structuredClone(trace);
    const pcm = new Int16Array(waveform);
    cases[gate](copy, pcm);
    const result = evaluateGates(deriveMetrics(copy, pcm));
    matrix[gate] = result;
    isolated[gate] = result[gate] === false && (Object.keys(baseline) as GateName[])
      .every((candidate) => candidate === gate || (baseline[candidate] === true && result[candidate] === true));
  }
  return {
    contract: 'Each row mutates captured trace/PCM input; its named gate must be false and every unrelated retained gate must remain baseline true.',
    baseline,
    matrix,
    isolated,
    allIsolated: Object.values(isolated).every(Boolean),
  };
}

function synthesizeWaveform(durationMs: number, startMs: number, silenceMs: number, fadeStartMs: number): Int16Array {
  const pcm = new Int16Array(Math.round((durationMs / 1000) * RATE));
  for (let index = 0; index < pcm.length; index += 1) {
    const ms = (index / RATE) * 1000;
    if (ms < startMs || ms >= silenceMs) continue;
    const fade = ms < fadeStartMs ? 1 : Math.max(0, 1 - (ms - fadeStartMs) / (silenceMs - fadeStartMs));
    pcm[index] = Math.round(Math.sin((ms / 1000) * Math.PI * 2 * 220) * 0.22 * fade * 32767);
  }
  return pcm;
}

function seedAudioResumption(pcm: Int16Array, startMs: number, durationMs: number): void {
  const start = Math.round((startMs / 1000) * RATE);
  const end = Math.min(pcm.length, start + Math.round((durationMs / 1000) * RATE));
  for (let index = start; index < end; index += 1) pcm[index] = Math.round(Math.sin((index / RATE) * Math.PI * 2 * 330) * 0.2 * 32767);
}

function countAudioResumptions(pcm: Int16Array, afterMs: number): number {
  const windowSamples = Math.round(RATE * 0.01);
  let observedSilence = false;
  let resumed = false;
  let resumptions = 0;
  for (let start = Math.round((afterMs / 1000) * RATE); start < pcm.length - windowSamples; start += windowSamples) {
    let sum = 0;
    for (let index = start; index < start + windowSamples; index += 1) sum += (pcm[index] / 32768) ** 2;
    const silent = Math.sqrt(sum / windowSamples) < 0.002;
    if (silent) { observedSilence = true; resumed = false; }
    else if (observedSilence && !resumed) { resumptions += 1; resumed = true; }
  }
  return resumptions;
}

function detectSilenceMs(pcm: Int16Array, afterMs: number): number {
  const windowSamples = Math.round(RATE * 0.01);
  for (let start = Math.round((afterMs / 1000) * RATE); start < pcm.length - windowSamples; start += windowSamples) {
    let sum = 0;
    for (let index = start; index < start + windowSamples; index += 1) sum += (pcm[index] / 32768) ** 2;
    if (Math.sqrt(sum / windowSamples) < 0.002) return (start / RATE) * 1000;
  }
  return Infinity;
}

function rmsAt(pcm: Int16Array, ms: number, windowMs: number): number {
  const start = Math.max(0, Math.round(((ms - windowMs / 2) / 1000) * RATE));
  const end = Math.min(pcm.length, Math.round(((ms + windowMs / 2) / 1000) * RATE));
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += (pcm[index] / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, end - start));
}

function wavBuffer(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.byteLength;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < pcm.length; index += 1) buffer.writeInt16LE(pcm[index], 44 + index * 2);
  return buffer;
}
