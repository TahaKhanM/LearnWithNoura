// End-to-end journey: home -> create learner -> start lesson -> live loop.
// Uses a synthesized speech WAV as the fake microphone so the real VAD,
// transcription, barge-in and drawing pipeline all run.
// Usage: node scripts/e2e-live.mjs [wavPath] [--text-only]
import { chromium } from 'playwright';

const wav = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const textOnly = process.argv.includes('--text-only');
const shots = '/tmp/noura-shots';

const args = ['--autoplay-policy=no-user-gesture-required'];
if (!textOnly) {
  args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream');
  if (wav) args.push(`--use-file-for-fake-audio-capture=${wav}`);
}

const browser = await chromium.launch({ args });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: textOnly ? [] : ['microphone'],
});
const page = await context.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

const t0 = Date.now();
const mark = (label) => console.log(`${String(Date.now() - t0).padStart(6)}ms  ${label}`);

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
mark('home loaded');
await page.screenshot({ path: `${shots}/e2e-home.png` });

// Create a learner if none is selected yet.
const hasChild = await page.locator('.home__child').count();
if (hasChild === 0) {
  await page.fill('input[aria-label="New learner name"]', 'Maya');
  await page.fill('input[aria-label="Age"]', '10');
  await page.click('.home__add button');
  await page.waitForSelector('.home__child');
  mark('learner created');
}

await page.fill('[data-testid=goal-input]', 'Why do the angles of a triangle add up to 180 degrees?');
await page.click('[data-testid=start-session]');
await page.waitForSelector('[data-testid=start-lesson]', { timeout: 10000 });
mark('lesson page');
await page.screenshot({ path: `${shots}/e2e-prestart.png` });

await page.click('[data-testid=start-lesson]');
mark('start clicked');

// Wait for the tutor to begin: a caption appears.
await page.waitForSelector('.lesson__caption:not(.lesson__caption--placeholder)', {
  timeout: 30000,
});
mark('first caption');

// Watch for board marks.
try {
  await page.waitForSelector('.board__item', { timeout: 40000 });
  mark('first board mark');
} catch {
  mark('NO BOARD MARKS within 40s');
}

await page.waitForTimeout(6000);
await page.screenshot({ path: `${shots}/e2e-teaching-1.png` });
mark('screenshot teaching-1');

if (wav) {
  // The fake mic speaks the interruption on its own schedule; watch for
  // the child's transcribed words to appear.
  try {
    await page.waitForSelector('.lesson__child-line', { timeout: 45000 });
    mark('child speech transcribed: ' + (await page.textContent('.lesson__child-line')));
  } catch {
    mark('NO child transcript within 45s');
  }
} else {
  // Type an interrupting question mid-speech (works with or without mic).
  await page.fill('.lesson__ask input', 'Wait — what does a straight line have to do with it?');
  await page.click('.lesson__ask button');
  mark('typed interruption sent');
}

await page.waitForTimeout(9000);
await page.screenshot({ path: `${shots}/e2e-teaching-2.png` });
mark('screenshot teaching-2');

const state = await page.evaluate(() => ({
  captions: [...document.querySelectorAll('.lesson__caption, .lesson__child-line')].map(
    (el) => el.textContent,
  ),
  boardItems: document.querySelectorAll('.board__item').length,
  concept: document.querySelector('[data-testid=active-concept]')?.textContent ?? null,
  status: document.querySelector('.lesson__status')?.textContent ?? null,
}));
console.log('STATE', JSON.stringify(state, null, 2));

await page.waitForTimeout(8000);
await page.screenshot({ path: `${shots}/e2e-teaching-3.png` });
mark('screenshot teaching-3');

// End the lesson and land on the parent dashboard.
await page.click('.lesson__end');
await page.waitForURL('**/parent**', { timeout: 40000 });
await page.waitForSelector('.parent__card, .parent--empty', { timeout: 15000 });
mark('parent dashboard');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${shots}/e2e-parent.png`, fullPage: true });

if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 20).join('\n---\n'));
else console.log('no console errors');
await browser.close();

// Server-side truth: what did the session record?
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('data/noura.db', { readOnly: true });
  const rows = db
    .prepare(
      `SELECT type, payload FROM events WHERE session_id = (
         SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1
       ) AND type IN ('learner_said','interrupted','metric','evidence','lesson_state') ORDER BY id`,
    )
    .all();
  console.log('SESSION EVENTS:');
  for (const row of rows) console.log(` ${row.type} ${row.payload}`);
} catch (err) {
  console.log('could not read event log:', err.message);
}
