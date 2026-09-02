import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { AnchorSceneSchema } from '../shared/compiledLesson.js';
import type { BoardOp } from '../shared/boardOps.js';
const args = process.argv.slice(2);
const harnessIndex = args.indexOf('--harness-url');
const sourceIndex = args.indexOf('--source');
const outputIndex = args.indexOf('--output');
if (!args.includes('--regenerate') || harnessIndex < 0 || !args[harnessIndex + 1]) {
  throw new Error('Pass --regenerate --harness-url with the loopback board harness origin.');
}
const target = new URL('/dev/board', args[harnessIndex + 1]);
if (!['localhost', '127.0.0.1'].includes(target.hostname)) throw new Error('Only a loopback board harness is allowed.');
const sourcePath = resolve(sourceIndex >= 0 && args[sourceIndex + 1]
  ? args[sourceIndex + 1]
  : 'server/board/eval/fixtures/m2-live-smoke-directed-scene.json');
const outputPath = resolve(outputIndex >= 0 && args[outputIndex + 1]
  ? args[outputIndex + 1]
  : 'artifacts/evaluation/drawing-m2-live-smoke-corrected.jpg');
const allowedSourceRoot = resolve('server/board/eval/fixtures');
const allowedOutputRoot = resolve('artifacts/evaluation');
if (!sourcePath.startsWith(`${allowedSourceRoot}/`) || !outputPath.startsWith(`${allowedOutputRoot}/`)) {
  throw new Error('Smoke render source or output is outside the evidence roots.');
}
const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as { scene?: unknown };
const scene = AnchorSceneSchema.parse(source.scene);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let externalRequestCount = 0;
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === target.origin && url.pathname === '/api/auth/session') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ required: false, authenticated: true }) });
  } else if (url.origin === target.origin) {
    await route.continue();
  } else {
    externalRequestCount += 1;
    await route.abort();
  }
});
try {
  await page.goto(target.href, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const host = globalThis as typeof globalThis & { nouraPreflightScene?: unknown; nouraRenderScene?: unknown };
    return typeof host.nouraPreflightScene === 'function' && typeof host.nouraRenderScene === 'function';
  });
  const evidence = await page.evaluate(async (ops) => {
    const host = globalThis as typeof globalThis & {
      nouraPreflightScene?: (candidate: BoardOp[]) => Promise<{ accepted: boolean; reasons: string[] }>;
      nouraRenderScene?: (candidate: BoardOp[]) => Promise<string | null>;
    };
    return {
      preflight: await host.nouraPreflightScene?.(ops),
      raster: await host.nouraRenderScene?.(ops),
    };
  }, scene.ops);
  if (!evidence.preflight?.accepted || !evidence.raster || externalRequestCount !== 0) {
    throw new Error(`Corrected smoke scene failed offline replay: ${evidence.preflight?.reasons.join('; ')}`);
  }
  const raster = Buffer.from(evidence.raster.split(',')[1] ?? '', 'base64');
  writeFileSync(outputPath, raster);
  console.log(JSON.stringify({
    ok: true,
    providerCalls: 0,
    externalRequestCount,
    outputPath,
    screenshotSha256: createHash('sha256').update(raster).digest('hex'),
  }, null, 2));
} finally {
  await browser.close();
}
