import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = {
  config: readFileSync('server/runtimeConfig.ts', 'utf8'),
  proxy: readFileSync('server/realtime/proxy.ts', 'utf8'),
  fallback: readFileSync('server/fallbackTutor.ts', 'utf8'),
  summary: readFileSync('server/summary.ts', 'utf8'),
};

const assertions = [
  ['realtime model', files.config.includes("'gpt-realtime-2.1'")],
  ['transcription model', files.proxy.includes("'gpt-4o-mini-transcribe'")],
  ['text model', files.config.includes("'gpt-5.6-terra'")],
  ['Realtime endpoint', files.proxy.includes("'wss://api.openai.com/v1/realtime'")],
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
