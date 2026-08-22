/**
 * Text measurement for board layout. Uses a shared canvas 2D context with
 * the board's real fonts so wrapped lines and label boxes match what SVG
 * actually renders. Falls back to a character estimate in test environments
 * without canvas.
 */

export const FONT_HAND = "'Caveat', 'Segoe Print', cursive";

export const TEXT_SIZES = { small: 21, normal: 28, big: 38 } as const;
export type TextSizeName = keyof typeof TEXT_SIZES;

let ctx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    const canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  return ctx;
}

export function measureText(text: string, fontSize: number): number {
  const c = context();
  if (c) {
    c.font = `600 ${fontSize}px ${FONT_HAND}`;
    const width = c.measureText(text).width;
    if (width > 0) return width;
  }
  return text.length * fontSize * 0.48;
}

/** Greedy word wrap to a pixel width. Splits long words only if forced. */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measureText(candidate, fontSize) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}
