// Degraded-mode check: realtime is unreachable (run the server with
// OPENAI_REALTIME_MODEL=gpt-bogus-model), so the lesson should fall back
// to captions-only text mode and keep teaching on the board.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (err) => console.log('PAGE ERROR', err));
const t0 = Date.now();
const mark = (label) => console.log(`${String(Date.now() - t0).padStart(6)}ms  ${label}`);

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
if ((await page.locator('.home__child').count()) === 0) {
  await page.fill('input[aria-label="New learner name"]', 'Maya');
  await page.fill('input[aria-label="Age"]', '10');
  await page.click('.home__add button');
  await page.waitForSelector('.home__child');
}
await page.fill('[data-testid=goal-input]', 'What is an ecosystem?');
await page.click('[data-testid=start-session]');
await page.waitForSelector('[data-testid=start-lesson]');
await page.click('[data-testid=start-lesson]');
mark('started');

await page.waitForFunction(
  () =>
    [...document.querySelectorAll('.lesson__status, .lesson__caption--placeholder')].some((el) =>
      el.textContent?.includes('Text mode'),
    ),
  { timeout: 30000 },
);
mark('entered text mode');

await page.fill('.lesson__ask input', 'What is an ecosystem?');
await page.click('.lesson__ask button');
await page.waitForFunction(
  () => document.querySelectorAll('.board__item').length > 0,
  { timeout: 60000 },
);
mark('board marks in fallback mode');
await page.waitForTimeout(1500);
const state = await page.evaluate(() => ({
  status: document.querySelector('.lesson__status')?.textContent,
  boardItems: document.querySelectorAll('.board__item').length,
  lastCaption: document.querySelector('.lesson__caption')?.textContent?.slice(0, 140),
}));
mark('state ' + JSON.stringify(state));
await page.screenshot({ path: '/tmp/seneca-shots/fallback-mode.png' });
await browser.close();
console.log('fallback test done');
