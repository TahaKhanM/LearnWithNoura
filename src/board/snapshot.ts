import { BOARD_H, BOARD_W } from '../../shared/boardOps';
import { compileScene, type BBox, type RenderNode } from './compile';
import { FONT_HAND } from './measure';
import { layoutRegions, REGION_GUTTER } from './regionLayout';
import type { SceneState } from './scene';

/**
 * Canonical, revision-bound board capture.
 *
 * The image is rendered from immutable scene data — never by cloning the
 * mounted responsive SVG — so the same scene produces the same snapshot on
 * desktop and mobile regardless of the current focus viewport, compact-mode
 * text hiding, highlights, pen position, or in-flight animations.
 */

export interface SceneSnapshotOptions {
  /** A detail crop (board coordinates) composed beside the full board. */
  focusBox?: BBox;
}

const SNAPSHOT_BACKGROUND = '#fcfbf7';

/** Deterministic markup for one scene. A single region stays 1000×600;
 * multiple regions tile horizontally with the same gutter as the live camera. */
export function sceneToCanonicalSvg(scene: SceneState): string {
  const layout = layoutRegions(scene);
  const compiled = compileScene(scene.items);
  const width = layout.ids.length <= 1
    ? BOARD_W
    : layout.ids.length * BOARD_W + (layout.ids.length - 1) * REGION_GUTTER;
  const body = compiled
    .map((item) => {
      const origin = layout.offset(scene.items.find((candidate) => candidate.id === item.id)?.semanticGroupId);
      const transform = origin.x === 0 && origin.y === 0 ? '' : ` transform="translate(${origin.x} ${origin.y})"`;
      return `<g data-item="${escapeXml(item.id)}"${transform}>${item.nodes.map(nodeMarkup).join('')}</g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BOARD_H}" viewBox="0 0 ${width} ${BOARD_H}">` +
    `<rect x="0" y="0" width="${width}" height="${BOARD_H}" fill="${SNAPSHOT_BACKGROUND}"/>${body}</svg>`;
}

function nodeMarkup(node: RenderNode): string {
  if (node.type === 'path') {
    return `<path d="${escapeXml(node.d)}" stroke="${escapeXml(node.color)}" stroke-width="${node.width}"` +
      ` stroke-linecap="round" stroke-linejoin="round" fill="${escapeXml(node.fill ?? 'none')}"` +
      `${node.dash ? ' stroke-dasharray="7 7"' : ''}` +
      `${node.transform ? ` transform="${escapeXml(node.transform)}"` : ''}/>`;
  }
  if (node.type === 'text') {
    const handwritten = node.style === 'handwritten';
    return `<text x="${node.x}" y="${node.y}" font-size="${node.size}" fill="${escapeXml(node.color)}"` +
      ` text-anchor="${node.anchor}" font-family="${escapeXml(FONT_HAND)}" font-weight="${handwritten ? 500 : 600}"` +
      `${handwritten ? ' data-style="handwritten"' : ''}>${escapeXml(node.text)}</text>`;
  }
  if (node.type === 'image') {
    const href = escapeXml(node.href);
    const alt = escapeXml(node.alt);
    const crop = node.crop
      ? ` clip-path="inset(${Math.max(0, node.crop.y - node.y)} ${Math.max(0, node.x + node.w - (node.crop.x + node.crop.w))} ${Math.max(0, node.y + node.h - (node.crop.y + node.crop.h))} ${Math.max(0, node.crop.x - node.x)})"`
      : '';
    return `<image href="${href}" x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}"` +
      ` preserveAspectRatio="xMidYMid meet" aria-label="${alt}"${crop}/>`;
  }
  // Equations render as deterministic plain math text. KaTeX HTML needs its
  // external stylesheet, which a serialized snapshot cannot rely on; readable
  // math text keeps the equation legible for vision instead of dropping it.
  return `<text x="${node.x}" y="${node.y + node.h}" font-size="${node.fontSize}" fill="${escapeXml(node.color)}"` +
    ` font-family="${escapeXml(FONT_HAND)}" font-weight="600">${escapeXml(latexToPlainText(node.latex))}</text>`;
}

/** Best-effort readable text for LaTeX in snapshots. Deterministic. */
export function latexToPlainText(latex: string): string {
  return latex
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
    .replace(/\^\s*\{?\\circ\}?/g, '°')
    .replace(/\\circ/g, '°')
    .replace(/\\degree/g, '°')
    .replace(/\\times/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/\\cdot/g, '·')
    .replace(/\\pi/g, 'π')
    .replace(/\\le(?:q)?/g, '≤')
    .replace(/\\ge(?:q)?/g, '≥')
    .replace(/\\ne(?:q)?/g, '≠')
    .replace(/\\pm/g, '±')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Rasterizes the canonical scene into the shared full-board + detail-crop
 * JPEG composition used as model vision context. Because the input is an
 * immutable scene value, a capture can never observe newer strokes, focus
 * changes, or animation state than the revision it was asked to render.
 */
export async function renderSceneImage(scene: SceneState, options: SceneSnapshotOptions = {}): Promise<string | null> {
  const markup = await inlineSnapshotImageHrefs(sceneToCanonicalSvg(scene));
  if (!markup) return null;
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('board snapshot could not be rendered'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 576;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = SNAPSHOT_BACKGROUND;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (options.focusBox) {
      // One image carries both global context and a legible detail crop. This
      // preserves spatial grounding while giving Realtime vision enough pixels
      // to inspect a small learner mark.
      const srcW = image.naturalWidth || BOARD_W;
      const srcH = image.naturalHeight || BOARD_H;
      context.drawImage(image, 0, 0, srcW, srcH, 0, 96, 640, 384);
      context.strokeStyle = '#d9d4ca';
      context.lineWidth = 2;
      context.strokeRect(0, 96, 640, 384);
      context.fillStyle = '#26231f';
      context.font = '600 18px sans-serif';
      context.fillText('Full board', 16, 78);
      context.fillText('Learner’s drawing', 668, 78);

      const crop = normalizedCrop(options.focusBox);
      const target = fitInside(crop.w, crop.h, 276, 430);
      const dx = 660 + (284 - target.w) / 2;
      const dy = 96 + (430 - target.h) / 2;
      context.drawImage(image, crop.x, crop.y, crop.w, crop.h, dx, dy, target.w, target.h);
      context.strokeStyle = '#2c5be0';
      context.strokeRect(dx - 4, dy - 4, target.w + 8, target.h + 8);
    } else {
      const srcW = image.naturalWidth || BOARD_W;
      const srcH = image.naturalHeight || BOARD_H;
      context.drawImage(image, 0, 0, srcW, srcH, 0, 0, canvas.width, canvas.height);
    }
    for (const quality of [0.82, 0.68, 0.54, 0.4]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= 300_000) return dataUrl;
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function normalizedCrop(box: BBox): BBox {
  const x = Math.max(0, Math.min(BOARD_W - 1, box.x));
  const y = Math.max(0, Math.min(BOARD_H - 1, box.y));
  return {
    x,
    y,
    w: Math.max(1, Math.min(BOARD_W - x, box.w)),
    h: Math.max(1, Math.min(BOARD_H - y, box.h)),
  };
}

function fitInside(width: number, height: number, maxWidth: number, maxHeight: number): { w: number; h: number } {
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return { w: width * scale, h: height * scale };
}

export async function inlineSnapshotImageHrefs(
  markup: string,
  load: (path: string) => Promise<string | null> = loadSnapshotImage,
): Promise<string | null> {
  const paths = [...new Set([...markup.matchAll(/href="(\/api\/board-assets\/[^"]+)"/g)].map((match) => match[1]))];
  let inlined = markup;
  for (const path of paths) {
    const dataUrl = await load(path);
    if (!dataUrl || !/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return null;
    inlined = inlined.replaceAll(`href="${path}"`, `href="${dataUrl}"`);
  }
  return inlined;
}

async function loadSnapshotImage(path: string): Promise<string | null> {
  try {
    const absolute = new URL(path, globalThis.location?.origin).href;
    const response = await fetch(absolute, { credentials: 'same-origin' });
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!response.ok || !/^image\/(?:png|jpeg|webp|svg\+xml)$/.test(contentType)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 4_000_000) return null;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

export function absolutizeSnapshotImageHrefs(markup: string, origin?: string): string {
  if (!origin || !/^https?:\/\//.test(origin)) return markup;
  return markup.replace(/href="(\/api\/board-assets\/[^"]+)"/g, (_match, path: string) =>
    `href="${escapeXml(new URL(path, origin).href)}"`);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) =>
    char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '&' ? '&amp;' : char === "'" ? '&apos;' : '&quot;');
}
