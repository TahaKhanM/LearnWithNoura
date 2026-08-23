// Stress and resilience checks:
// 1. rapid repeated typed interruptions — no stale audio/marks, no crash
// 2. page refresh mid-lesson — board replays, conversation resumes
// 3. learner drawing — the tutor is told and can refer to it
import { chromium } from 'playwright';

const shots = '/tmp/noura-shots';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
const t0 = Date.now();
const mark = (label) => console.log(`${String(Date.now() - t0).padStart(6)}ms  ${label}`);

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.fill('[data-testid=goal-input]', 'How do plants make their own food?');
await page.click('[data-testid=start-session]');
await page.waitForSelector('[data-testid=start-lesson]');
const lessonUrl = page.url();
await page.click('[data-testid=start-lesson]');
await page.waitForSelector('.lesson__caption:not(.lesson__caption--placeholder)', { timeout: 30000 });
mark('lesson started');

// --- 1. rapid repeated interruptions --------------------------------------
const questions = [
  'Wait, what is a leaf made of?',
  'No hold on, what is energy?',
  'Actually can you start over more simply?',
];
for (const q of questions) {
  await page.waitForTimeout(2500);
  await page.fill('.lesson__ask input', q);
  await page.click('.lesson__ask button');
  mark(`interrupted with: ${q}`);
}
await page.waitForTimeout(12000);
const afterStorm = await page.evaluate(() => ({
  phase: document.querySelector('.lesson__status')?.textContent,
  boardItems: document.querySelectorAll('.board__item').length,
  lastCaption: document.querySelector('.lesson__caption')?.textContent?.slice(0, 120),
  error: document.querySelector('.lesson__error')?.textContent ?? null,
}));
mark('after interruption storm: ' + JSON.stringify(afterStorm));
await page.screenshot({ path: `${shots}/stress-storm.png` });

// --- 2. refresh mid-lesson --------------------------------------------------
const itemsBefore = await page.evaluate(() => document.querySelectorAll('.board__item').length);
await page.reload({ waitUntil: 'networkidle' });
mark('page reloaded');
await page.waitForSelector('[data-testid=start-lesson]', { timeout: 10000 });
await page.click('[data-testid=start-lesson]');
await page.waitForFunction(
  () => document.querySelectorAll('.board__item').length > 0,
  { timeout: 20000 },
);
const itemsAfter = await page.evaluate(() => document.querySelectorAll('.board__item').length);
mark(`board replayed: ${itemsAfter} items (was ${itemsBefore})`);
await page.screenshot({ path: `${shots}/stress-replayed.png` });

// Wait for the resumed tutor to speak again.
try {
  await page.waitForSelector('.lesson__caption:not(.lesson__caption--placeholder)', { timeout: 30000 });
  mark('resumed speaking: ' + (await page.textContent('.lesson__caption'))?.slice(0, 110));
} catch {
  mark('NO resumed captions in 30s');
}

// --- 3. learner draws -------------------------------------------------------
await page.click('.lesson__tool[title="Draw on the board"]');
const box = await (await page.$('.board__svg')).boundingBox();
const cx = box.x + box.width * 0.72;
const cy = box.y + box.height * 0.62;
await page.mouse.move(cx, cy);
await page.mouse.down();
// A rough circle sketch.
for (let a = 0; a <= Math.PI * 2 + 0.2; a += 0.25) {
  await page.mouse.move(cx + Math.cos(a) * 60, cy + Math.sin(a) * 60, { steps: 2 });
}
await page.mouse.up();
mark('drew a learner circle');
await page.waitForTimeout(2500);
await page.fill('.lesson__ask input', 'I drew something on the board — what do you think it could be in your diagram?');
await page.click('.lesson__ask button');
await page.waitForTimeout(14000);
const reaction = await page.evaluate(
  () => document.querySelector('.lesson__caption')?.textContent?.slice(0, 220) ?? null,
);
mark('tutor reaction: ' + reaction);
await page.screenshot({ path: `${shots}/stress-learner-draw.png` });

await page.click('.lesson__end');
await page.waitForURL('**/parent**', { timeout: 60000 });
mark('ended cleanly');

if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
else console.log('no page errors');
await browser.close();
console.log('lesson url was', lessonUrl);
