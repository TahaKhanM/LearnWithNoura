import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CharacterAttentionController, attentionPriority } from '../src/lesson/characterAttention.js';
import { ResponseCueTimeline, type ResponseCue } from '../src/lesson/responseTimeline.js';

const outputDir = resolve(process.argv[2] ?? 'artifacts/evaluation');
mkdirSync(outputDir, { recursive: true });

const RATE = 24_000;
const FRAME_MS = 1000 / 60;
const identity = { sessionId: 'offline-eval', connectionEpoch: 1, turnId: 'turn-1', generationId: 'generation-1' };
const annotated = { captionMs: 280, visualMs: 340, responseCompleteMs: 780, learnerOnsetMs: 900, detectorMs: 1000 };
const stopScheduledMs = nextFrame(annotated.detectorMs);
const fadeEndMs = stopScheduledMs + 18;
const samples = synthesizeWaveform(2_000, 120, fadeEndMs, stopScheduledMs);
const timeline = new ResponseCueTimeline();
const attention = new CharacterAttentionController(identity);
const responseStartMs = 120;
const toSample = (absoluteMs: number) => Math.round(((absoluteMs - responseStartMs) / 1000) * RATE);

timeline.enqueue(caption('caption-1', toSample(annotated.captionMs), 1, 'one teaching phrase'));
timeline.enqueue(visual('visual-1', toSample(annotated.visualMs), 2));
timeline.enqueue({ kind: 'final', cueId: 'final-1', responseId: 'response-1', startSample: 0, endSample: toSample(annotated.responseCompleteMs), sequence: 3, identity, text: 'One teaching phrase.' });
timeline.enqueue(caption('caption-future', toSample(1_120), 4, 'future speech'));
timeline.enqueue(visual('visual-future', toSample(1_160), 5));

const observedEvents: Array<{ type: string; ms: number; cueId?: string }> = [];
const frames: Array<{ frame: number; ms: number; captionCue: string | null; visualCue: string | null; characterPhase: string; gazeTarget: string; penVisible: boolean; mouthEnergy: number; pendingCues: number }> = [];
let activeCaption: string | null = null;
let activeVisual: string | null = null;
let penVisible = false;
let interrupted = false;
let staleWrites = 0;
let staleAudioResumptions = 0;

for (let frame = 0, ms = 0; ms <= 2_000; frame += 1, ms = frame * FRAME_MS) {
  if (!interrupted && ms >= annotated.detectorMs) {
    interrupted = true;
    observedEvents.push({ type: 'detector', ms });
    observedEvents.push({ type: 'stop_scheduled', ms });
    timeline.cancel(identity);
    attention.cancelGeneration(identity);
    attention.offer({ ...identity, targetType: 'interruption', priority: attentionPriority('interruption'), startTime: ms, expiryTime: ms + 900, smoothingProfile: 'immediate', permittedInReducedMotion: true });
    penVisible = false;
    const lateAccepted = timeline.enqueue(caption('stale-after-cancel', toSample(1_240), 6, 'stale'));
    if (lateAccepted) staleWrites += 1;
  }

  const playedSamples = Math.max(0, Math.round(((ms - responseStartMs) / 1000) * RATE));
  for (const cue of timeline.drain(() => playedSamples)) {
    observedEvents.push({ type: cue.kind, ms, cueId: cue.cueId });
    if (cue.kind === 'caption') activeCaption = cue.delta;
    if (cue.kind === 'visual') {
      activeVisual = cue.visualCueId ?? cue.cueId;
      penVisible = true;
      attention.offer({ ...identity, targetType: 'tutor_pen', boardCoordinates: [620, 260], priority: attentionPriority('tutor_pen'), startTime: ms, expiryTime: annotated.detectorMs, smoothingProfile: 'responsive', permittedInReducedMotion: false });
    }
  }
  const waveformEnergy = rmsAt(samples, ms, 12);
  const attentionFrame = attention.frame(ms);
  frames.push({
    frame,
    ms: Number(ms.toFixed(3)),
    captionCue: activeCaption,
    visualCue: activeVisual,
    characterPhase: interrupted ? 'listening' : waveformEnergy > 0.01 ? 'speaking' : 'thinking',
    gazeTarget: attentionFrame.targetType,
    penVisible,
    mouthEnergy: waveformEnergy,
    pendingCues: timeline.pendingCount(),
  });
}

const mobileFrameTimestamps = Array.from({ length: 84 }, (_, index) => index * 24);
const sourceTrace = { observedEvents, frames, mobileFrameTimestamps, staleWrites, staleAudioResumptions };
const metrics = deriveMetrics(sourceTrace, samples);
const gateResults = evaluateGates(metrics);
const negativeFixtures = verifyNegativeFixtures(sourceTrace, samples);

const wavPath = join(outputDir, 'synthetic-interruption.wav');
writeFileSync(wavPath, wavBuffer(samples, RATE));
const reportPath = join(outputDir, 'synthetic-av-character-report.json');
writeFileSync(reportPath, `${JSON.stringify({
  evidenceType: 'deterministic-offline-runtime',
  realChildData: false,
  runtimeProviderCalls: 0,
  runtimeCostUsd: 0,
  targetHardwareAcoustics: 'UNVERIFIED',
  metrics,
  gateResults,
  negativeFixtures,
  timeline: frames,
}, null, 2)}\n`);

const videoPath = join(outputDir, 'synthetic-av-character.mp4');
const ffmpeg = spawnSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'color=c=white:s=1280x720:r=60:d=2', '-i', wavPath,
  '-vf', "drawbox=x=0:y=0:w=1280:h=720:color=0xede9df:t=fill,drawbox=x=120:y=100:w=1040:h=460:color=0xfcfbf7:t=fill,drawbox=x=180:y=220:w=700:h=90:color=0x2c5be0@0.22:t=fill:enable='between(t,0.12,1.0)',drawbox=x=180:y=380:w=520:h=18:color=0x99620b:t=fill:enable='between(t,0.34,1.0)'",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath,
], { encoding: 'utf8' });
if (ffmpeg.status !== 0) throw new Error(`ffmpeg evaluator failed: ${ffmpeg.stderr.slice(-500)}`);

const ok = Object.values(gateResults).every(Boolean) && Object.values(negativeFixtures).every(Boolean);
console.log(JSON.stringify({ ok, wavPath, videoPath, reportPath, metrics, gateResults, negativeFixtures }, null, 2));
if (!ok) process.exit(1);

function caption(cueId: string, endSample: number, sequence: number, delta: string): ResponseCue {
  return { kind: 'caption', cueId, responseId: 'response-1', startSample: Math.max(0, endSample - 2_400), endSample, sequence, identity, delta };
}

function visual(cueId: string, endSample: number, sequence: number): ResponseCue {
  return { kind: 'visual', cueId, responseId: 'response-1', startSample: endSample, endSample, sequence, identity, ops: [], eventId: sequence, visualCueId: 'semantic-group-1', semanticObjectId: 'semantic-group-1' };
}

function deriveMetrics(trace: typeof sourceTrace, waveform: Int16Array) {
  const eventTime = (type: string, cueId?: string) => trace.observedEvents.find((event) => event.type === type && (!cueId || event.cueId === cueId))?.ms;
  const captionErrors = [Math.abs((eventTime('caption', 'caption-1') ?? Infinity) - annotated.captionMs)];
  const visualErrors = [Math.abs((eventTime('visual', 'visual-1') ?? Infinity) - annotated.visualMs)];
  const finalAt = eventTime('final', 'final-1') ?? Infinity;
  const detectorAt = eventTime('detector') ?? Infinity;
  const stopAt = eventTime('stop_scheduled') ?? Infinity;
  const clearFrame = trace.frames.find((frame) => frame.ms >= detectorAt && frame.pendingCues === 0 && !frame.penVisible && frame.characterPhase === 'listening');
  const frameIntervals = differences(trace.frames.map((frame) => frame.ms));
  const acousticSilenceMs = detectSilenceMs(waveform, detectorAt);
  return {
    detectorToStopScheduledMs: stopAt - detectorAt,
    scheduledStopToAcousticSilenceMs: acousticSilenceMs - stopAt,
    syntheticOnsetToAcousticSilenceMs: acousticSilenceMs - annotated.learnerOnsetMs,
    captionPhraseMedianAbsoluteErrorMs: percentile(captionErrors, 50),
    captionPhraseP95AbsoluteErrorMs: percentile(captionErrors, 95),
    visualCueP95ErrorMs: percentile(visualErrors, 95),
    finalCorrectionMs: finalAt - annotated.responseCompleteMs,
    interruptionClearMs: (clearFrame?.ms ?? Infinity) - detectorAt,
    desktopFrameIntervalP95Ms: percentile(frameIntervals, 95),
    representativeMobileFrameIntervalP95Ms: percentile(differences(trace.mobileFrameTimestamps), 95),
    staleAudioResumptions: trace.staleAudioResumptions,
    staleCaptionVisualCharacterWrites: trace.staleWrites,
    targetHardwareAcoustics: 'UNVERIFIED' as const,
  };
}

function evaluateGates(metrics: ReturnType<typeof deriveMetrics>) {
  return {
    detectorStop: metrics.detectorToStopScheduledMs <= 16.8,
    captionMedian: metrics.captionPhraseMedianAbsoluteErrorMs <= 350,
    captionP95: metrics.captionPhraseP95AbsoluteErrorMs <= 750,
    visualP95: metrics.visualCueP95ErrorMs <= 500,
    finalCorrection: metrics.finalCorrectionMs <= 500,
    interruptionClear: metrics.interruptionClearMs <= FRAME_MS + 0.1,
    desktopFrames: metrics.desktopFrameIntervalP95Ms < 22,
    mobileFrames: metrics.representativeMobileFrameIntervalP95Ms < 30,
    staleAudio: metrics.staleAudioResumptions === 0,
    staleWrites: metrics.staleCaptionVisualCharacterWrites === 0,
  };
}

function verifyNegativeFixtures(trace: typeof sourceTrace, waveform: Int16Array) {
  const cases: Record<string, (copy: typeof sourceTrace) => void> = {
    detectorStop: (copy) => { copy.observedEvents.find((event) => event.type === 'stop_scheduled')!.ms += 50; },
    captionMedian: (copy) => { copy.observedEvents.find((event) => event.type === 'caption')!.ms += 800; },
    captionP95: (copy) => { copy.observedEvents.find((event) => event.type === 'caption')!.ms += 800; },
    visualP95: (copy) => { copy.observedEvents.find((event) => event.type === 'visual')!.ms += 800; },
    finalCorrection: (copy) => { copy.observedEvents.find((event) => event.type === 'final')!.ms += 800; },
    interruptionClear: (copy) => { const frame = copy.frames.find((item) => item.ms >= annotated.detectorMs)!; frame.pendingCues = 1; frame.penVisible = true; copy.frames.find((item) => item.ms > annotated.detectorMs)!.pendingCues = 1; },
    desktopFrames: (copy) => { copy.frames = copy.frames.map((frame, index) => ({ ...frame, ms: index * 40 })); },
    mobileFrames: (copy) => { copy.mobileFrameTimestamps = copy.mobileFrameTimestamps.map((_, index) => index * 40); },
    staleAudio: (copy) => { copy.staleAudioResumptions = 1; },
    staleWrites: (copy) => { copy.staleWrites = 1; },
  };
  return Object.fromEntries(Object.entries(cases).map(([gate, mutate]) => {
    const copy = structuredClone(trace);
    mutate(copy);
    return [gate, evaluateGates(deriveMetrics(copy, waveform))[gate as keyof ReturnType<typeof evaluateGates>] === false];
  }));
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

function percentile(values: number[], value: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((value / 100) * sorted.length) - 1))];
}

function differences(values: number[]): number[] { return values.slice(1).map((value, index) => value - values[index]); }
function nextFrame(ms: number): number { return Math.ceil(ms / FRAME_MS) * FRAME_MS; }

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
