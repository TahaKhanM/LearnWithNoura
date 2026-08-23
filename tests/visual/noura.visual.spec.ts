import { expect, test } from '@playwright/test';

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

for (const scene of ['pythagorean', 'unit-circle', 'slopes', 'fractions', 'water-cycle', 'argument', 'history', 'grammar', 'no-board']) {
  test(`canonical ${scene} scene`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dev/board');
    await page.getByRole('button', { name: scene, exact: true }).click();
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
      await page.goto('/dev/board');
      await page.getByRole('button', { name: scene, exact: true }).click();
      await expect(page.locator('[data-active-scene]')).toContainText(scene);
      if (viewport.name === 'mobile-focus' && scene !== 'no-board') {
        const geometry = await page.locator('.board__svg').evaluate((svg) => {
          const viewBox = svg.getAttribute('viewBox')?.split(/\s+/).map(Number) ?? [];
          const svgRect = svg.getBoundingClientRect();
          const visibleText = [...svg.querySelectorAll<SVGTextElement>('.board__text')]
            .map((node) => node.getBoundingClientRect())
            .filter((rect) => rect.right > svgRect.left && rect.left < svgRect.right && rect.bottom > svgRect.top && rect.top < svgRect.bottom);
          return { viewBoxWidth: viewBox[2], minimumVisibleTextPx: Math.min(...visibleText.map((rect) => rect.height)), visibleTextCount: visibleText.length };
        });
        expect(geometry.viewBoxWidth).toBeLessThanOrEqual(350);
        expect(geometry.visibleTextCount).toBeGreaterThan(0);
        expect(geometry.minimumVisibleTextPx).toBeGreaterThanOrEqual(16);
      }
      await expect(page).toHaveScreenshot(`scene-${scene}-${viewport.name}.png`, { animations: 'disabled' });
    });
  }
}
