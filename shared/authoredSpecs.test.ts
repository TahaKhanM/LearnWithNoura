import { describe, expect, it } from 'vitest';
import { BOARD_H, BOARD_W, PALETTE, validateOps } from './boardOps';
import { BOARD_ASSET_IDS, getBoardAsset } from './boardAssets';

describe('authored-tier tutor curves', () => {
  it('accepts a center-radius arc on the authored tier and rejects it on the fast tier', () => {
    const raw = [{
      op: 'add',
      id: 'arc-1',
      kind: 'arc',
      center: [400, 300],
      r: 80,
      startDeg: 0,
      endDeg: 90,
      color: 'blue',
    }];
    const authored = validateOps(raw, { tier: 'authored' });
    expect(authored.rejected).toHaveLength(0);
    expect(authored.ops).toHaveLength(1);
    expect(authored.ops[0]).toMatchObject({
      op: 'add',
      id: 'arc-1',
      color: PALETTE.blue,
      spec: { kind: 'arc', center: [400, 300], r: 80, startDeg: 0, endDeg: 90 },
    });

    const fast = validateOps(raw);
    expect(fast.ops).toHaveLength(0);
    expect(fast.rejected[0].reason).toMatch(/director|compiler|authored/i);
  });

  it('accepts a three-point arc and rejects collinear points', () => {
    const good = validateOps([{
      op: 'add',
      id: 'arc-3',
      kind: 'arc',
      from: [200, 400],
      through: [400, 200],
      to: [600, 400],
    }], { tier: 'authored' });
    expect(good.rejected).toHaveLength(0);
    expect(good.ops[0]).toMatchObject({
      spec: { kind: 'arc', from: [200, 400], through: [400, 200], to: [600, 400] },
    });

    const collinear = validateOps([{
      op: 'add',
      id: 'flat',
      kind: 'arc',
      from: [100, 300],
      through: [200, 300],
      to: [300, 300],
    }], { tier: 'authored' });
    expect(collinear.ops).toHaveLength(0);
    expect(collinear.rejected[0].reason).toMatch(/collinear|arc/i);
  });

  it('accepts a bounded cubic Bézier curve and clamps points and width', () => {
    const { ops, rejected } = validateOps([{
      op: 'add',
      id: 'curve-1',
      kind: 'curve',
      points: [[-50, 300], [200, -20], [400, 800], [1200, 300]],
      width: 40,
    }], { tier: 'authored' });
    expect(rejected).toHaveLength(0);
    const spec = (ops[0] as { spec: { points: number[][]; width: number } }).spec;
    expect(spec.points[0][0]).toBe(0);
    expect(spec.points[1][1]).toBe(0);
    expect(spec.points[2][1]).toBe(BOARD_H);
    expect(spec.points[3][0]).toBe(BOARD_W);
    expect(spec.width).toBeLessThanOrEqual(12);
  });

  it('rejects a curve with too few points or a non-cubic length', () => {
    const short = validateOps([{
      op: 'add', id: 'c', kind: 'curve', points: [[10, 10], [20, 20]],
    }], { tier: 'authored' });
    expect(short.ops).toHaveLength(0);

    const odd = validateOps([{
      op: 'add', id: 'c2', kind: 'curve', points: [[10, 10], [20, 20], [30, 30], [40, 40], [50, 50]],
    }], { tier: 'authored' });
    expect(odd.ops).toHaveLength(0);
  });

  it('still refuses learner-only paths on both tiers', () => {
    const raw = [{ op: 'add', id: 'p', kind: 'path', points: [[0, 0], [10, 10]] }];
    expect(validateOps(raw).rejected[0].reason).toContain('learner-only');
    expect(validateOps(raw, { tier: 'authored' }).rejected[0].reason).toContain('learner-only');
  });
});

describe('handwritten annotation style', () => {
  it('accepts short handwritten text on the authored tier only', () => {
    const raw = [{
      op: 'add',
      id: 'note',
      kind: 'text',
      at: [80, 80],
      text: 'watch this',
      style: 'handwritten',
    }];
    const authored = validateOps(raw, { tier: 'authored' });
    expect(authored.rejected).toHaveLength(0);
    expect(authored.ops[0]).toMatchObject({ spec: { kind: 'text', style: 'handwritten', text: 'watch this' } });

    const fast = validateOps(raw);
    expect(fast.ops).toHaveLength(0);
    expect(fast.rejected[0].reason).toMatch(/handwritten|authored|director/i);
  });

  it('does not attach handwritten style to ordinary fast-tier text', () => {
    const { ops, rejected } = validateOps([{
      op: 'add', id: 't', kind: 'text', at: [10, 40], text: 'typeset',
    }]);
    expect(rejected).toHaveLength(0);
    expect((ops[0] as { spec: { style?: string } }).spec.style).toBeUndefined();
  });

  it('rejects a fast-tier add+update batch that smuggles handwritten style', () => {
    const { ops, rejected } = validateOps([
      { op: 'add', id: 't', kind: 'text', at: [10, 40], text: 'typeset' },
      { op: 'update', id: 't', props: { style: 'handwritten' } },
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'add', id: 't', spec: { kind: 'text', text: 'typeset' } });
    expect((ops[0] as { spec: { style?: string } }).spec.style).toBeUndefined();
    expect(rejected.some((entry) => /handwritten|authored|director/i.test(entry.reason))).toBe(true);
  });

  it('accepts an authored-tier update that applies handwritten style', () => {
    const { ops, rejected } = validateOps([
      { op: 'add', id: 't', kind: 'text', at: [10, 40], text: 'typeset' },
      { op: 'update', id: 't', props: { style: 'handwritten' } },
    ], { tier: 'authored' });
    expect(rejected).toHaveLength(0);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ op: 'update', id: 't', props: { style: 'handwritten' } });
  });
});

describe('curated educational assets', () => {
  it('accepts a registry asset on the authored tier and rejects unknown ids', () => {
    const good = validateOps([{
      op: 'add',
      id: 'sun-1',
      kind: 'asset',
      assetId: 'sun',
      at: [200, 160],
      size: 72,
      color: 'amber',
    }], { tier: 'authored' });
    expect(good.rejected).toHaveLength(0);
    expect(good.ops[0]).toMatchObject({
      spec: { kind: 'asset', assetId: 'sun', at: [200, 160], size: 72 },
    });

    const unknown = validateOps([{
      op: 'add', id: 'x', kind: 'asset', assetId: 'not-a-real-icon', at: [100, 100],
    }], { tier: 'authored' });
    expect(unknown.ops).toHaveLength(0);
    expect(unknown.rejected[0].reason).toMatch(/unknown asset/i);
  });

  it('rejects assets from the voice-model fast tier', () => {
    const { ops, rejected } = validateOps([{
      op: 'add', id: 'sun-1', kind: 'asset', assetId: 'sun', at: [200, 160],
    }]);
    expect(ops).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/director|compiler|authored/i);
  });

  it('walks the registry: unique ids, a11y labels, and safe viewBox-normalized paths', () => {
    expect(BOARD_ASSET_IDS.length).toBeGreaterThanOrEqual(40);
    expect(BOARD_ASSET_IDS.length).toBeLessThanOrEqual(60);
    const seen = new Set<string>();
    for (const id of BOARD_ASSET_IDS) {
      expect(seen.has(id), `duplicate asset id ${id}`).toBe(false);
      seen.add(id);
      const asset = getBoardAsset(id);
      expect(asset, `missing asset ${id}`).toBeDefined();
      if (!asset) continue;
      expect(asset.id).toBe(id);
      expect(asset.label.length).toBeGreaterThan(0);
      expect(asset.viewBox).toBe(24);
      expect(asset.paths.length).toBeGreaterThan(0);
      for (const d of asset.paths) {
        expect(d.length).toBeGreaterThan(2);
        expect(d.length).toBeLessThanOrEqual(800);
        expect(d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]+$/);
      }
    }
  });
});

describe('authored-tier manipulatives', () => {
  it('rejects fast-tier add of draggable, snapZone, and tappable kinds', () => {
    for (const kind of ['draggable', 'snapZone', 'tappable'] as const) {
      const raw = kind === 'draggable'
        ? [{ op: 'add', id: 'm', kind, handle: 'token', at: [200, 300], size: 44 }]
        : kind === 'snapZone'
          ? [{ op: 'add', id: 'z', kind, shape: 'interval', at: [685, 300], from: 0.7, to: 0.8 }]
          : [{ op: 'add', id: 't', kind, shape: 'circle', at: [400, 300], r: 22 }];
      const fast = validateOps(raw);
      expect(fast.ops).toHaveLength(0);
      expect(fast.rejected[0].reason).toMatch(/director|compiler|authored/i);
    }
  });

  it('rejects fast-tier updates that mention manipulative authored fields', () => {
    const { ops, rejected } = validateOps([
      { op: 'update', id: 'zone', props: { from: 0, to: 1 } },
    ]);
    expect(ops).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/manipulative|authored|director/i);
  });
});

describe('authored-tier generated illustrations', () => {
  const imageAdd = {
    op: 'add' as const,
    id: 'pond',
    kind: 'image',
    assetId: 'img-a1b2c3d4e5f67890',
    at: [80, 60],
    w: 840,
    h: 420,
    alt: 'A pond habitat with plants and a frog, no words',
  };

  it('accepts a server-issued image spec on the authored tier', () => {
    const { ops, rejected } = validateOps([imageAdd], { tier: 'authored' });
    expect(rejected).toHaveLength(0);
    expect(ops[0]).toMatchObject({
      op: 'add',
      id: 'pond',
      spec: {
        kind: 'image',
        assetId: 'img-a1b2c3d4e5f67890',
        at: [80, 60],
        w: 840,
        h: 420,
        alt: 'A pond habitat with plants and a frog, no words',
      },
    });
  });

  it('rejects image add and update from the voice-model fast tier', () => {
    const add = validateOps([imageAdd]);
    expect(add.ops).toHaveLength(0);
    expect(add.rejected[0].reason).toMatch(/director|compiler|authored/i);

    const update = validateOps([
      { op: 'update', id: 'pond', props: { assetId: 'img-a1b2c3d4e5f67890', alt: 'changed' } },
    ]);
    expect(update.ops).toHaveLength(0);
    expect(update.rejected[0].reason).toMatch(/manipulative|authored|director/i);
  });

  it('rejects a missing alt, a data-URL assetId, and an http assetId', () => {
    const missingAlt = validateOps([{ ...imageAdd, alt: '' }], { tier: 'authored' });
    expect(missingAlt.ops).toHaveLength(0);
    expect(missingAlt.rejected[0].reason).toMatch(/alt|image/i);

    const dataUrl = validateOps([{
      ...imageAdd,
      assetId: 'data:image/png;base64,AAAA',
    }], { tier: 'authored' });
    expect(dataUrl.ops).toHaveLength(0);
    expect(dataUrl.rejected[0].reason).toMatch(/assetId|image|server-issued/i);

    const remote = validateOps([{
      ...imageAdd,
      assetId: 'https://example.test/pond.png',
    }], { tier: 'authored' });
    expect(remote.ops).toHaveLength(0);
    expect(remote.rejected[0].reason).toMatch(/assetId|image|server-issued/i);
  });

  it('accepts an optional crop and clamps placement onto the board', () => {
    const { ops, rejected } = validateOps([{
      ...imageAdd,
      at: [-20, 800],
      w: 2000,
      h: 10,
      crop: { x: -4, y: 10, w: 200, h: 80 },
    }], { tier: 'authored' });
    expect(rejected).toHaveLength(0);
    const spec = (ops[0] as { spec: { at: number[]; w: number; h: number; crop?: { x: number; y: number; w: number; h: number } } }).spec;
    expect(spec.at[0]).toBe(0);
    expect(spec.at[1]).toBe(BOARD_H);
    expect(spec.w).toBeLessThanOrEqual(BOARD_W);
    expect(spec.h).toBeGreaterThanOrEqual(40);
    expect(spec.crop?.x).toBe(0);
  });
});
