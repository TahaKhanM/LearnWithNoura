import { describe, expect, it } from 'vitest';
import { compileSnapZone } from './compileManipulatives';
import type { SceneItem } from './scene';

describe('compileSnapZone interval', () => {
  const items: SceneItem[] = [
    {
      id: 'line',
      owner: 'tutor',
      revision: 0,
      spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1 },
    },
  ];

  it('draws interval snap zones from numberline from/to rather than at/w', () => {
    const nodes = compileSnapZone({
      kind: 'snapZone',
      shape: 'interval',
      at: [999, 999],
      numberlineId: 'line',
      from: 0.7,
      to: 0.8,
    }, items);
    const bbox = nodes[0]?.bbox;
    expect(bbox).toBeDefined();
    expect(bbox!.x).toBeCloseTo(130 + 0.7 * 740, 0);
    expect(bbox!.w).toBeCloseTo(0.1 * 740, 0);
  });
});
