import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * Measures a KaTeX expression by rendering it into a hidden DOM node with
 * the same markup the board's KatexBlock produces. Only meaningful in a
 * real browser (headless Chromium validation); returns null when the
 * render yields no measurable box.
 */
export function measureKatexInDom(latex: string, fontSize: number): { w: number; h: number } | null {
  try {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;display:inline-block;';
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
