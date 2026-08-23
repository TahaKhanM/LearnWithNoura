// Mobile-viewport lesson screenshots (pre-start and mid-teaching).
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', (err) => console.log('PAGE ERROR', err));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.fill('[data-testid=goal-input]', 'What do the hands of a clock tell us?');
await page.click('[data-testid=start-session]');
await page.waitForSelector('[data-testid=start-lesson]');
await page.screenshot({ path: '/tmp/noura-shots/lesson-mobile-prestart.png' });
await page.click('[data-testid=start-lesson]');
await page.waitForSelector('.lesson__caption:not(.lesson__caption--placeholder)', { timeout: 30000 });
await page.waitForTimeout(18000);
await page.screenshot({ path: '/tmp/noura-shots/lesson-mobile-teaching.png' });
await page.click('.lesson__end');
await page.waitForURL('**/parent**', { timeout: 60000 }).catch(() => {});
await browser.close();
console.log('done');
