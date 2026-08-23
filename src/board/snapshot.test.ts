import { describe, expect, it } from 'vitest';
import { applyOps, emptyScene } from './scene';
import { latexToPlainText, sceneToCanonicalSvg } from './snapshot';

describe('canonical board snapshot', () => {
  const scene = applyOps(emptyScene, [
    { op: 'add', id: 'scale', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1, step: 0.5, marks: [{ value: 0.5, label: '1/2' }, { value: 0.75, label: '3/4' }] } },
    { op: 'add', id: 'sum', color: '#14A07A', spec: { kind: 'equation', at: [400, 480], latex: 'A+B+C=180^\\circ' } },
    { op: 'add', id: 'note', spec: { kind: 'text', at: [500, 120], text: 'Compare on one scale' } },
  ], 'tutor', 'fraction-scale').scene;

  it('renders from immutable scene data at the full board viewBox, independent of any mounted view', () => {
    const svg = sceneToCanonicalSvg(scene);
    expect(svg).toContain('viewBox="0 0 1000 600"');
    // Identical scenes produce identical snapshots — there is no dependency
    // on focus viewport, compact mode, highlights, or animation state.
    expect(sceneToCanonicalSvg(scene)).toBe(svg);
  });

  it('includes every required label and a readable equation', () => {
    const svg = sceneToCanonicalSvg(scene);
    expect(svg).toContain('1/2');
    expect(svg).toContain('3/4');
    expect(svg).toContain('Compare on one scale');
    expect(svg).toContain('A+B+C=180°');
  });

  it('contains no transient UI: no highlight halo, pen, or hidden-for-animation styling', () => {
    const svg = sceneToCanonicalSvg(scene);
    expect(svg).not.toContain('board__highlight');
    expect(svg).not.toContain('board__pen');
    expect(svg).not.toContain('stroke-dashoffset');
    expect(svg).not.toContain('visibility="hidden"');
    expect(svg).not.toContain('opacity: 0');
  });

  it('renders learner strokes alongside tutor geometry', () => {
    const withSketch = applyOps(scene, [
      { op: 'add', id: 'sketch-circle', color: '#E14B3C', spec: { kind: 'path', points: [[300, 280], [320, 260], [340, 280], [320, 300], [300, 280]] } },
    ], 'learner', 'fraction-scale').scene;
    const svg = sceneToCanonicalSvg(withSketch);
    expect(svg).toContain('data-item="sketch-circle"');
    expect(svg).toContain('#E14B3C');
  });

  it('translates common LaTeX into deterministic readable text', () => {
    expect(latexToPlainText('c^2=a^2+b^2')).toBe('c^2=a^2+b^2');
    expect(latexToPlainText('A+B+C=180^\\circ')).toBe('A+B+C=180°');
    expect(latexToPlainText('\\frac{2}{3}<\\frac{3}{4}')).toBe('(2)/(3)<(3)/(4)');
    expect(latexToPlainText('\\sqrt{9}=3')).toBe('√(9)=3');
    expect(latexToPlainText('2\\times 3\\cdot \\pi')).toBe('2× 3· π');
  });
});
