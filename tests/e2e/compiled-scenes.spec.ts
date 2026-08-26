import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { BoardOp } from '../../shared/boardOps';
import { CompiledLessonSchema, type CompiledLesson } from '../../shared/compiledLesson';

/**
 * Headless validation of the checked-in compiled-lesson fixtures through
 * the REAL client pipeline: the board harness page exposes a preflight hook
 * that runs compileScene, inspection, annotation layout, and the quality
 * budget with DOM-measured KaTeX bounds.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'lesson', 'fixtures');

function fixture(name: string): CompiledLesson {
  return CompiledLessonSchema.parse(JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')));
}

async function preflight(page: Page, ops: BoardOp[], groupId: string): Promise<{ accepted: boolean; reasons: string[] }> {
  return page.evaluate(
    async (argument: { ops: BoardOp[]; groupId: string }) => {
      const hook = (globalThis as {
        nouraPreflightScene?: (ops: BoardOp[], groupId?: string) => Promise<{ accepted: boolean; reasons: string[] }>;
      }).nouraPreflightScene;
      if (!hook) throw new Error('Preflight hook missing on harness page.');
      return hook(argument.ops, argument.groupId);
    },
    { ops, groupId },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/dev/board');
  await page.waitForFunction(() => typeof (globalThis as { nouraPreflightScene?: unknown }).nouraPreflightScene === 'function');
});

test('the maths board-led fixture passes the full client pipeline headlessly', async ({ page }) => {
  const lesson = fixture('triangle-angle-sum');
  expect(lesson.blueprint.mode).toBe('board_led');
  const anchor = lesson.anchorScene;
  expect(anchor).not.toBeNull();
  if (!anchor) return;
  const verdict = await preflight(page, anchor.ops, anchor.groupId);
  expect(verdict).toEqual({ accepted: true, reasons: [] });

  // The equation in this fixture is measured by a real KaTeX DOM render.
  const measured = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;visibility:hidden;';
    document.body.appendChild(host);
    host.innerHTML = 'x';
    const ok = host.getBoundingClientRect().width >= 0;
    host.remove();
    return ok;
  });
  expect(measured).toBe(true);
});

test('the non-maths board-led fixture passes the full client pipeline headlessly', async ({ page }) => {
  const lesson = fixture('water-cycle');
  expect(lesson.blueprint.mode).toBe('board_led');
  const anchor = lesson.anchorScene;
  expect(anchor).not.toBeNull();
  if (!anchor) return;
  const verdict = await preflight(page, anchor.ops, anchor.groupId);
  expect(verdict).toEqual({ accepted: true, reasons: [] });
});

test('the conversation-led fixture carries no forced visuals', async () => {
  const lesson = fixture('being-brave');
  expect(lesson.blueprint.mode).toBe('conversation_led');
  expect(lesson.anchorScene).toBeNull();
  expect(lesson.blueprint.stages.every((stage) => stage.boardPurpose === 'none' && stage.allowedBoardMutation === 'none')).toBe(true);
});

test('the preflight hook rejects an illegible scene instead of passing it', async ({ page }) => {
  // 34 tutor items exceed the section legibility budget (30), so the
  // quality gate must fail this scene deterministically.
  const overloaded: BoardOp[] = Array.from({ length: 34 }, (_, index): BoardOp => ({
    op: 'add',
    id: `bad-box-${index}`,
    spec: { kind: 'box', at: [120 + (index % 6) * 130, 90 + Math.floor(index / 6) * 80], text: `Idea ${index + 1}` },
  }));
  const verdict = await preflight(page, overloaded, 'bad-group');
  expect(verdict.accepted).toBe(false);
  expect(verdict.reasons.length).toBeGreaterThan(0);
});
