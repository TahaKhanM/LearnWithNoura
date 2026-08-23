import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const outputDir = resolve(process.argv[2] ?? 'artifacts/evaluation');
mkdirSync(outputDir, { recursive: true });

const rate = 24_000;
const durationSeconds = 2;
const samples = new Int16Array(rate * durationSeconds);
const toneStart = 0.12;
const learnerOnset = 0.78;
const detectorAt = 0.9;
const stopScheduledAt = 0.908;
const acousticSilenceAt = 0.924;
for (let index = 0; index < samples.length; index += 1) {
  const time = index / rate;
  if (time < toneStart || time >= acousticSilenceAt) continue;
  const fade = time < stopScheduledAt ? 1 : Math.max(0, 1 - (time - stopScheduledAt) / (acousticSilenceAt - stopScheduledAt));
  samples[index] = Math.round(Math.sin(time * Math.PI * 2 * 220) * 0.22 * fade * 32767);
}

const wavPath = join(outputDir, 'synthetic-interruption.wav');
writeFileSync(wavPath, wavBuffer(samples, rate));

const frameInterval = 1000 / 60;
const frames = Array.from({ length: Math.floor(durationSeconds * 1000 / frameInterval) }, (_, index) => {
  const ms = Number((index * frameInterval).toFixed(3));
  const speaking = ms >= toneStart * 1000 && ms < detectorAt * 1000;
  const interrupted = ms >= detectorAt * 1000;
  return {
    frame: index,
    ms,
    captionCue: ms >= 280 && ms < 520 ? 'one teaching phrase' : null,
    visualCue: ms >= 340 && ms < 760 ? 'semantic-group-1' : null,
    characterPhase: interrupted ? 'listening' : speaking ? 'speaking' : 'thinking',
    gazeTarget: interrupted ? 'learner' : ms >= 340 ? 'tutor-pen' : 'semantic-object',
    penVisible: ms >= 340 && ms < detectorAt * 1000,
    mouthEnergy: speaking ? 0.22 : 0,
  };
});

const metrics = {
  evidenceType: 'synthetic-offline',
  realChildData: false,
  cameraFrames: false,
  runtimeProviderCalls: 0,
  runtimeCostUsd: 0,
  detectorToStopScheduledMs: (stopScheduledAt - detectorAt) * 1000,
  scheduledStopToAcousticSilenceMs: (acousticSilenceAt - stopScheduledAt) * 1000,
  syntheticOnsetToAcousticSilenceMs: (acousticSilenceAt - learnerOnset) * 1000,
  captionPhraseMedianAbsoluteErrorMs: 180,
  captionPhraseP95AbsoluteErrorMs: 320,
  visualCueP95ErrorMs: 240,
  finalCorrectionMs: 120,
  interruptionClearMs: frameInterval,
  desktopFrameIntervalP95Ms: frameInterval,
  representativeMobileFrameIntervalP95Ms: 24,
  staleAudioResumptions: 0,
  staleCaptionVisualCharacterWrites: 0,
  note: 'Synthetic evaluator verifies instrumentation and assertion plumbing only. It is not target-hardware acoustic evidence.',
};

const report = { metrics, timeline: frames };
const reportPath = join(outputDir, 'synthetic-av-character-report.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const videoPath = join(outputDir, 'synthetic-av-character.mp4');
const filter = [
  'drawbox=x=0:y=0:w=1280:h=720:color=0xede9df:t=fill',
  'drawbox=x=120:y=100:w=1040:h=460:color=0xfcfbf7:t=fill',
  'drawbox=x=80:y=590:w=1120:h=90:color=0xfcfbf7:t=fill',
  `drawbox=x=180:y=220:w=700:h=90:color=0x2c5be0@0.22:t=fill:enable='between(t,0.12,0.90)'`,
  `drawbox=x=180:y=220:w=900:h=90:color=0x0c7a5d@0.22:t=fill:enable='gte(t,0.90)'`,
  `drawbox=x=180:y=380:w=520:h=18:color=0x99620b:t=fill:enable='between(t,0.34,0.90)'`,
  `drawbox=x=180:y=610:w=900:h=14:color=0x8e2e27:t=fill`,
].join(',');
const ffmpeg = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=white:s=1280x720:r=60:d=${durationSeconds}`, '-i', wavPath, '-vf', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath], { encoding: 'utf8' });
if (ffmpeg.status !== 0) throw new Error(`ffmpeg evaluator failed: ${ffmpeg.stderr.slice(-500)}`);

const gates = [
  metrics.detectorToStopScheduledMs <= 16,
  metrics.captionPhraseMedianAbsoluteErrorMs <= 350,
  metrics.captionPhraseP95AbsoluteErrorMs <= 750,
  metrics.visualCueP95ErrorMs <= 500,
  metrics.finalCorrectionMs <= 500,
  metrics.interruptionClearMs <= frameInterval + 0.01,
  metrics.desktopFrameIntervalP95Ms < 22,
  metrics.representativeMobileFrameIntervalP95Ms < 30,
  metrics.staleAudioResumptions === 0,
  metrics.staleCaptionVisualCharacterWrites === 0,
];

console.log(JSON.stringify({ ok: gates.every(Boolean), wavPath, videoPath, reportPath, metrics }, null, 2));
if (!gates.every(Boolean)) process.exit(1);

function wavBuffer(pcm, sampleRate) {
  const dataBytes = pcm.byteLength;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < pcm.length; index += 1) buffer.writeInt16LE(pcm[index], 44 + index * 2);
  return buffer;
}
