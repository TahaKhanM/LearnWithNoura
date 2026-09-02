import katex from 'katex';
import type { BoardOp } from '../../shared/boardOps';
import 'katex/dist/katex.min.css';

/**
 * Measures a KaTeX expression by rendering it into a hidden DOM node with
 * the same markup the board's KatexBlock produces. Only meaningful in a
 * real browser (headless Chromium validation); returns null when the
 * render yields no measurable box.
 */
export async function prepareDomBoardMeasurement(ops: BoardOp[]): Promise<void> {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;';
  const hand = document.createElement('span');
  hand.style.cssText = 'font:600 28px "Caveat Variable";';
  hand.textContent = 'Board measurement';
  host.appendChild(hand);
  for (const op of ops) {
    if (op.op !== 'add' || op.spec.kind !== 'equation') continue;
    const equation = document.createElement('span');
    equation.style.cssText = `display:inline-block;line-height:1.3;font-size:${op.spec.size === 'small' ? 16 : op.spec.size === 'big' ? 26 : 20}px;`;
    equation.innerHTML = katex.renderToString(op.spec.latex, { throwOnError: false, output: 'html' });
    host.appendChild(equation);
  }
  document.body.appendChild(host);
  try {
    const fonts = document.fonts;
    if (fonts && typeof fonts.load === 'function') {
      await Promise.all([
        fonts.load('500 28px "Caveat Variable"'),
        fonts.load('600 28px "Caveat Variable"'),
        fonts.ready,
      ]);
    }
  } finally {
    host.remove();
  }
}

export function measureKatexInDom(latex: string, fontSize: number): { w: number; h: number } | null {
  try {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;display:inline-block;line-height:1.3;';
    host.style.fontSize = `${fontSize}px`;
    host.innerHTML = katex.renderToString(latex, { throwOnError: false, output: 'html' });
    document.body.appendChild(host);
    const rect = host.getBoundingClientRect();
    host.remove();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    return { w: rect.width, h: rect.height };
  } catch {
    return null;
  }
}
