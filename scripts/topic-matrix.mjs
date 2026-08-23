// Unseen-topic matrix: runs several teaching domains through the real
// pipeline (text mode for determinism) and screenshots the board mid-lesson.
// Usage: node scripts/topic-matrix.mjs [indexToRun]
import { chromium } from 'playwright';

const TOPICS = [
  { slug: 'graphs', goal: 'How to read a line graph, using temperatures over a week' },
  { slug: 'process', goal: 'How does the water cycle work?' },
  { slug: 'humanities', goal: 'What is a metaphor, and how is it different from a simile?' },
  { slug: 'fractions', goal: 'What does three quarters actually mean?' },
  { slug: 'nodiagram', goal: 'Why is it brave to admit a mistake?' },
];

const only = process.argv[2] !== undefined ? Number(process.argv[2]) : null;
const list = only !== null ? [TOPICS[only]] : TOPICS;
const shots = '/tmp/noura-shots';

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

for (const topic of list) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  const t0 = Date.now();
  const mark = (label) => console.log(`[${topic.slug}] ${String(Date.now() - t0).padStart(6)}ms  ${label}`);

  try {
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
    await page.fill('[data-testid=goal-input]', topic.goal);
    await page.click('[data-testid=start-session]');
    await page.waitForSelector('[data-testid=start-lesson]');
    await page.click('[data-testid=start-lesson]');
    await page.waitForSelector('.lesson__caption:not(.lesson__caption--placeholder)', { timeout: 30000 });
    mark('first caption');

    // Let it teach, then nudge it once like a curious child would.
    await page.waitForTimeout(22000);
    await page.screenshot({ path: `${shots}/topic-${topic.slug}-1.png` });
    await page.fill('.lesson__ask input', 'Can you show me an example?');
    await page.click('.lesson__ask button');
    mark('asked for an example');
    await page.waitForTimeout(24000);
    await page.screenshot({ path: `${shots}/topic-${topic.slug}-2.png` });

    const state = await page.evaluate(() => ({
      boardItems: document.querySelectorAll('.board__item').length,
      concept: document.querySelector('[data-testid=active-concept]')?.textContent ?? null,
      lastCaption: document.querySelector('.lesson__caption')?.textContent?.slice(0, 140) ?? null,
    }));
    mark(`state ${JSON.stringify(state)}`);

    await page.click('.lesson__end');
    await page.waitForURL('**/parent**', { timeout: 60000 });
    mark('ended');
  } catch (err) {
    mark(`FAILED: ${String(err).slice(0, 200)}`);
    await page.screenshot({ path: `${shots}/topic-${topic.slug}-fail.png` }).catch(() => {});
  }
  if (errors.length) console.log(`[${topic.slug}] PAGE ERRORS:\n` + errors.slice(0, 5).join('\n'));
  await page.close();
}

await browser.close();
console.log('matrix done');
