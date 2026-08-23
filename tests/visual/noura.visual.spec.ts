import { expect, test } from '@playwright/test';

const KEY_EDUCATIONAL_TEXT: Record<string, string> = {
  pythagorean: 'c^2=a^2+b^2',
  'triangle-angles': 'A+B+C=180^\\circ',
  'unit-circle': '(1/2, √3/2)',
  slopes: 'y = 1x',
  fractions: '2/3',
  'water-cycle': 'Evaporation',
  argument: 'Claim',
  history: 'New trade route',
  grammar: 'The curious fox',
  'relationship-map': 'Claim',
  'worked-steps': 'Collect like terms',
  comparison: 'Solid',
  'part-whole': '3+2=5',
};

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
]) {
  test(`Noura Home ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Noura' })).toBeVisible();
    await expect(page).toHaveScreenshot(`noura-home-${viewport.name}.png`, { fullPage: true, animations: 'disabled' });
  });
}

for (const scene of ['pythagorean', 'triangle-angles', 'unit-circle', 'slopes', 'fractions', 'water-cycle', 'argument', 'history', 'grammar', 'relationship-map', 'worked-steps', 'comparison', 'part-whole', 'no-board']) {
  test(`canonical ${scene} scene`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const hiddenScene = ['triangle-angles', 'relationship-map', 'worked-steps', 'comparison', 'part-whole'].includes(scene);
    await page.goto(hiddenScene ? `/dev/board?scene=${scene}` : '/dev/board');
    if (!hiddenScene) await page.getByRole('button', { name: scene, exact: true }).click();
    await expect(page.locator('[data-active-scene]')).toContainText(scene);
    await expect(page).toHaveScreenshot(`scene-${scene}.png`, { animations: 'disabled' });
  });

  for (const viewport of [
    { name: 'tablet', width: 834, height: 1112 },
    { name: 'mobile-focus', width: 390, height: 844 },
  ]) {
    test(`canonical ${scene} scene ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const hiddenScene = ['triangle-angles', 'relationship-map', 'worked-steps', 'comparison', 'part-whole'].includes(scene);
      await page.goto(hiddenScene ? `/dev/board?scene=${scene}` : '/dev/board');
      if (!hiddenScene) await page.getByRole('button', { name: scene, exact: true }).click();
      await expect(page.locator('[data-active-scene]')).toContainText(scene);
      if (viewport.name === 'mobile-focus' && scene !== 'no-board') {
        const requiredKeys = await page.locator('[data-required-text-key]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-required-text-key')));
        const reached = new Set<string>();
        let first = true;
        for (;;) {
          const geometry = await focusedTextGeometry(page);
          expect(geometry.viewBoxWidth).toBeLessThanOrEqual(350);
          if (geometry.visibleTextCount > 0) expect(geometry.minimumVisibleTextPx).toBeGreaterThanOrEqual(16);
          expect(geometry.partiallyClipped).toEqual([]);
          geometry.visibleKeys.forEach((key) => reached.add(key));
          if (first) {
            expect(geometry.visibleTextCount).toBeGreaterThan(0);
            expect(geometry.visibleText).toContain(KEY_EDUCATIONAL_TEXT[scene]);
            first = false;
          }
          const next = page.getByRole('button', { name: 'Next part of this board section' });
          if (await next.isDisabled()) break;
          await next.click();
        }
        expect([...reached].sort()).toEqual([...requiredKeys].filter((key): key is string => Boolean(key)).sort());
        const controls = await page.locator('.board-harness__focus-controls button, .board-harness__focus-controls select').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
        expect(controls.every((height) => height >= 44)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
        while (!(await page.getByRole('button', { name: 'Previous part of this board section' }).isDisabled())) await page.getByRole('button', { name: 'Previous part of this board section' }).click();
      }
      await expect(page).toHaveScreenshot(`scene-${scene}-${viewport.name}.png`, { animations: 'disabled' });
    });
  }
}

async function focusedTextGeometry(page: import('@playwright/test').Page) {
  return page.locator('.board__svg').evaluate((svg) => {
    const viewBox = svg.getAttribute('viewBox')?.split(/\s+/).map(Number) ?? [];
    const svgRect = svg.getBoundingClientRect();
    const visible = [...svg.querySelectorAll<SVGGraphicsElement>('[data-required-text-key]')]
      .filter((node) => getComputedStyle(node).visibility !== 'hidden')
      .map((node) => ({
        key: node.getAttribute('data-required-text-key') ?? '',
        text: node.getAttribute('data-required-text') ?? '',
        rect: node.getBoundingClientRect(),
      }));
    const partiallyClipped = visible.filter(({ rect }) =>
      rect.left < svgRect.left - 0.5 || rect.right > svgRect.right + 0.5 || rect.top < svgRect.top - 0.5 || rect.bottom > svgRect.bottom + 0.5,
    ).map(({ key, text }) => `${key}:${text}`);
    return {
      viewBoxWidth: viewBox[2],
      minimumVisibleTextPx: Math.min(...visible.map(({ rect }) => rect.height)),
      visibleTextCount: visible.length,
      visibleKeys: visible.map(({ key }) => key),
      visibleText: visible.map(({ text }) => text),
      partiallyClipped,
    };
  });
}
