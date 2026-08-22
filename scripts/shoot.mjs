// Screenshot helper for visual review during development.
// Usage: node scripts/shoot.mjs <url> <outfile> [clickSelector] [waitMs] [width] [height]
import { chromium } from 'playwright';

const [url, outfile, clickSelector, waitMs = '1200', width = '1440', height = '900'] = process.argv.slice(2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

await page.goto(url, { waitUntil: 'networkidle' });
if (clickSelector) {
  for (const sel of clickSelector.split('|')) {
    await page.click(sel);
    await page.waitForTimeout(Number(waitMs));
  }
} else {
  await page.waitForTimeout(Number(waitMs));
}
await page.screenshot({ path: outfile });
if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.join('\n'));
await browser.close();
console.log('saved', outfile);
