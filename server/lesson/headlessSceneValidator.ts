import type { Browser, Page } from 'playwright';
import type { BoardOp } from '../../shared/boardOps.js';
import type { SceneValidationResult, SceneValidator } from './compiler.js';

/**
 * Drives the board harness page (/dev/board) in headless Chromium so every
 * compiled scene is validated by the REAL client pipeline — compileScene,
 * inspection, annotation layout, quality budget — with DOM-measured KaTeX
 * bounds. A pure-Node approximation is deliberately not offered.
 *
 * The same page also rasters scenes through the real render pipeline: the
 * Board Director sees the current board and inspects its own candidates as
 * canonical JPEG snapshots (`window.nouraRenderScene`).
 */

export interface HeadlessSceneValidatorOptions {
  /** Full URL of the board harness page, e.g. http://127.0.0.1:5180/dev/board */
  harnessUrl: string;
  semanticGroupId?: string;
  launchTimeoutMs?: number;
}

/** Rasters ops through the real pipeline; null when rendering fails. */
export type SceneRenderer = (ops: BoardOp[], semanticGroupId?: string) => Promise<string | null>;

export interface HeadlessSceneValidatorHandle {
  validate: SceneValidator;
  render: SceneRenderer;
  close(): Promise<void>;
}

interface HarnessHost {
  nouraPreflightScene?: (ops: BoardOp[], semanticGroupId?: string) => Promise<{ accepted: boolean; reasons: string[] }>;
  nouraRenderScene?: (ops: BoardOp[], semanticGroupId?: string) => Promise<string | null>;
}

export function createHeadlessSceneValidator(options: HeadlessSceneValidatorOptions): HeadlessSceneValidatorHandle {
  let browser: Browser | null = null;
  let pagePromise: Promise<Page> | null = null;

  async function openPage(): Promise<Page> {
    // Playwright is loaded lazily: only the live-compiler validation path
    // needs it, and only environments that run compilation install it.
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(options.harnessUrl, { waitUntil: 'load' });
    await page.waitForFunction(
      () => typeof (globalThis as HarnessHost).nouraPreflightScene === 'function' &&
        typeof (globalThis as HarnessHost).nouraRenderScene === 'function',
      undefined,
      { timeout: options.launchTimeoutMs ?? 30_000 },
    );
    return page;
  }

  const validate: SceneValidator = async (ops: BoardOp[]): Promise<SceneValidationResult> => {
    try {
      pagePromise ??= openPage();
      const page = await pagePromise;
      const verdict = await page.evaluate(
        async (argument: { ops: BoardOp[]; groupId?: string }) => {
          const hook = (globalThis as HarnessHost).nouraPreflightScene;
          if (!hook) throw new Error('Preflight hook missing on harness page.');
          return hook(argument.ops, argument.groupId);
        },
        { ops, groupId: options.semanticGroupId },
      );
      return verdict.accepted ? { ok: true } : { ok: false, issues: verdict.reasons };
    } catch (error) {
      // Fail closed: an unreachable validator never lets a scene through.
      return { ok: false, issues: [`Headless scene validation unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`] };
    }
  };

  const render: SceneRenderer = async (ops: BoardOp[], semanticGroupId?: string): Promise<string | null> => {
    try {
      pagePromise ??= openPage();
      const page = await pagePromise;
      return await page.evaluate(
        async (argument: { ops: BoardOp[]; groupId?: string }) => {
          const hook = (globalThis as HarnessHost).nouraRenderScene;
          if (!hook) throw new Error('Render hook missing on harness page.');
          return hook(argument.ops, argument.groupId);
        },
        { ops, groupId: semanticGroupId ?? options.semanticGroupId },
      );
    } catch {
      // A missing raster is reported as null; callers decide whether the
      // step it feeds (vision check, board context image) must fail closed.
      return null;
    }
  };

  return {
    validate,
    render,
    close: async () => {
      pagePromise = null;
      await browser?.close();
      browser = null;
    },
  };
}
