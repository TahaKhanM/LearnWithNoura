import { describe, expect, it } from 'vitest';
import { applyOps, emptyScene } from './scene';
import { absolutizeSnapshotImageHrefs, inlineSnapshotImageHrefs, latexToPlainText, sceneToCanonicalSvg } from './snapshot';

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

  it('renders equations as a measured-outline placeholder instead of bare snapshot text', () => {
    const svg = sceneToCanonicalSvg(scene);
    expect(svg).toContain('data-katex="true"');
    expect(svg).toContain('data-latex="A+B+C=180^\\circ"');
    expect(svg).toMatch(/<g data-katex="true"[^>]*>[\s\S]*<rect /);
    expect(svg).toMatch(/data-katex="true"[\s\S]*A\+B\+C=180°/);
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

  it('places two regions at identical local coordinates on distinct tiles', () => {
    let two = applyOps(emptyScene, [
      { op: 'add', id: 'one-box', spec: { kind: 'box', at: [500, 300], w: 160, h: 80, text: 'First' } },
    ], 'tutor', 'region-one').scene;
    two = applyOps(two, [
      { op: 'add', id: 'two-box', spec: { kind: 'box', at: [500, 300], w: 160, h: 80, text: 'Second' } },
    ], 'tutor', 'region-two').scene;
    const svg = sceneToCanonicalSvg(two);
    expect(svg).toContain('data-item="one-box"');
    expect(svg).toContain('data-item="two-box"');
    expect(svg).toMatch(/data-item="two-box"[^>]*transform="translate\(1080 0\)"/);
    expect(svg).not.toMatch(/data-item="one-box"[^>]*transform=/);
    expect(svg).toContain('viewBox="0 0 2080 600"');
  });

  it('serializes an illustration by assetId and inlines fetched bytes only for rasterization', async () => {
    const pictured = applyOps(emptyScene, [
      { op: 'add', id: 'pond', spec: { kind: 'image', assetId: 'img-a1b2c3d4e5f67890', at: [80, 60], w: 840, h: 420, alt: 'A pond habitat' } },
      { op: 'add', id: 'frog', spec: { kind: 'text', at: [200, 520], text: 'frog' } },
    ], 'tutor', 'habitat').scene;
    const svg = sceneToCanonicalSvg(pictured);
    expect(svg).toContain('data-item="pond"');
    expect(svg).toContain('href="/api/board-assets/img-a1b2c3d4e5f67890"');
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(svg).toContain('aria-label="A pond habitat"');
    expect(svg).toContain('frog');
    expect(svg).not.toContain('data:image');
    expect(absolutizeSnapshotImageHrefs(svg, 'https://lesson.example')).toContain('href="https://lesson.example/api/board-assets/img-a1b2c3d4e5f67890"');
    const inlined = await inlineSnapshotImageHrefs(svg, async (path) => {
      expect(path).toBe('/api/board-assets/img-a1b2c3d4e5f67890');
      return 'data:image/png;base64,cGl4ZWxz';
    });
    expect(inlined).toContain('href="data:image/png;base64,cGl4ZWxz"');
    await expect(inlineSnapshotImageHrefs(svg, async () => null)).resolves.toBeNull();
  });

  it('paints a late-arriving illustration behind overlay marks already on the board', () => {
    let pictured = applyOps(emptyScene, [
      { op: 'add', id: 'frog', spec: { kind: 'text', at: [200, 520], text: 'frog' } },
    ], 'tutor', 'habitat').scene;
    pictured = applyOps(pictured, [
      { op: 'add', id: 'pond', spec: { kind: 'image', assetId: 'img-a1b2c3d4e5f67890', at: [80, 60], w: 840, h: 420, alt: 'A pond habitat' } },
    ], 'tutor', 'habitat').scene;
    const svg = sceneToCanonicalSvg(pictured);
    expect(svg.indexOf('data-item="pond"')).toBeGreaterThan(-1);
    expect(svg.indexOf('data-item="pond"')).toBeLessThan(svg.indexOf('data-item="frog"'));
  });

  it('keeps learner-pen strokes at the live preview width in snapshots', () => {
    const sketched = applyOps(emptyScene, [{
      op: 'add',
      id: 'pen',
      color: '#26231F',
      spec: { kind: 'path', points: [[120, 300], [220, 300], [420, 300], [520, 300]], width: 4 },
    }], 'learner', 'sketch').scene;
    expect(sceneToCanonicalSvg(sketched)).toContain('stroke-width="4"');
  });

  it('translates common LaTeX into deterministic readable text', () => {
    expect(latexToPlainText('c^2=a^2+b^2')).toBe('c^2=a^2+b^2');
    expect(latexToPlainText('A+B+C=180^\\circ')).toBe('A+B+C=180°');
    expect(latexToPlainText('\\frac{2}{3}<\\frac{3}{4}')).toBe('(2)/(3)<(3)/(4)');
    expect(latexToPlainText('\\sqrt{9}=3')).toBe('√(9)=3');
    expect(latexToPlainText('2\\times 3\\cdot \\pi')).toBe('2× 3· π');
  });
});
