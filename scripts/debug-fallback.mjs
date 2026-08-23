// Diagnoses the fallback path: samples UI state and WebSocket lifecycle.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (err) => console.log('PAGE ERROR', err));
page.on('websocket', (ws) => {
  if (!ws.url().includes('/ws/lesson')) return;
  const t = Date.now();
  console.log('WS OPEN', ws.url().slice(-30));
  ws.on('close', () => console.log(`WS CLOSE after ${Date.now() - t}ms`));
  ws.on('framereceived', (frame) => {
    const s = String(frame.payload).slice(0, 90);
    if (!s.includes('"audio"') && !s.includes('transcript_delta')) console.log('  <-', s);
  });
});

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

for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => ({
    placeholder: document.querySelector('.lesson__caption--placeholder')?.textContent ?? null,
    status: document.querySelector('.lesson__status')?.textContent ?? null,
    error: document.querySelector('.lesson__error')?.textContent ?? null,
  }));
  console.log(i, JSON.stringify(state));
}
await browser.close();
