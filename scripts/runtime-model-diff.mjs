import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Phase 1 decomposed the old proxy: the session configuration (transcription
// model, sideband Realtime endpoint) now lives in sessionConfig.ts and the
// WebRTC call bootstrap in callBootstrap.ts. Same invariants, current files.
const files = {
  config: readFileSync('server/runtimeConfig.ts', 'utf8'),
  sessionConfig: readFileSync('server/realtime/sessionConfig.ts', 'utf8'),
  callBootstrap: readFileSync('server/realtime/callBootstrap.ts', 'utf8'),
  fallback: readFileSync('server/fallbackTutor.ts', 'utf8'),
  summary: readFileSync('server/summary.ts', 'utf8'),
};

const assertions = [
  ['realtime model', files.config.includes("'gpt-realtime-2.1'")],
  ['transcription model', files.sessionConfig.includes("'gpt-4o-mini-transcribe'")],
  ['text model', files.config.includes("'gpt-5.6-terra'")],
  ['Realtime sideband endpoint', files.sessionConfig.includes("'wss://api.openai.com/v1/realtime'")],
  ['Realtime calls endpoint', files.callBootstrap.includes("'https://api.openai.com/v1/realtime/calls'")],
  ['fallback Chat Completions', files.fallback.includes('client.chat.completions.create')],
  ['summary Chat Completions', files.summary.includes('client.chat.completions.create')],
  ['no application Sol dependency', !Object.values(files).some((text) => /gpt-5\.6-sol/i.test(text))],
  ['no Responses migration', !Object.values(files).some((text) => /responses\.create/.test(text))],
];

const failed = assertions.filter(([, passed]) => !passed);
const diff = spawnSync('git', ['diff', '--unified=0', 'HEAD', '--', 'server', 'shared', 'src'], { encoding: 'utf8' }).stdout;
const changedRuntimeLines = diff.split('\n').filter((line) => /^[+-](?![+-])/.test(line) && /gpt-|chat\.completions|responses\.create|api\.openai\.com/.test(line));

console.log(JSON.stringify({
  ok: failed.length === 0,
  baseline: {
    realtime: 'gpt-realtime-2.1 via Realtime WebSocket',
    transcription: 'gpt-4o-mini-transcribe',
    text: 'gpt-5.6-terra via Chat Completions',
  },
  assertions: Object.fromEntries(assertions),
  changedRuntimeLines,
}, null, 2));

if (failed.length > 0) process.exit(1);
