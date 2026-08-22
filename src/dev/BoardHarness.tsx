import { useCallback, useMemo, useRef, useState } from 'react';
import { validateOps, type BoardOp } from '../../shared/boardOps';
import { applyOps, emptyScene, type SceneState } from '../board/scene';
import { BoardCanvas, type BoardHighlight } from '../board/BoardCanvas';
import type { BoardAnimator } from '../board/animator';

/**
 * Renderer test bench (dev-only route). Feeds the same op batches the
 * model would emit, across four different teaching domains, so visual
 * quality can be inspected and repaired without burning model turns.
 */

const SCENES: Record<string, unknown[]> = {
  geometry: [
    { op: 'add', id: 'tri', kind: 'polygon', points: [[280, 420], [640, 420], [520, 180]], color: '#2C5BE0' },
    { op: 'add', id: 'a1', kind: 'angle', vertex: [280, 420], from: [640, 420], to: [520, 180], label: 'A', color: '#E14B3C' },
    { op: 'add', id: 'a2', kind: 'angle', vertex: [640, 420], from: [280, 420], to: [520, 180], label: 'B', color: '#14A07A' },
    { op: 'add', id: 'a3', kind: 'angle', vertex: [520, 180], from: [280, 420], to: [640, 420], label: 'C', color: '#F0A227' },
    { op: 'add', id: 'base', kind: 'line', from: [180, 120], to: [860, 120], dash: true, color: '#26231F' },
    { op: 'add', id: 'lbl', kind: 'label', target: 'base', side: 'above', text: 'a straight line through the top corner' },
    { op: 'add', id: 'eq', kind: 'equation', at: [330, 480], latex: 'A + B + C = 180^\\circ', size: 'big', color: '#14A07A' },
    { op: 'add', id: 'rt', kind: 'angle', vertex: [780, 420], from: [900, 420], to: [780, 300], label: '90°', color: '#E14B3C' },
    { op: 'add', id: 'leg1', kind: 'line', from: [780, 420], to: [900, 420], color: '#26231F' },
    { op: 'add', id: 'leg2', kind: 'line', from: [780, 420], to: [780, 300], color: '#26231F' },
  ],
  process: [
    { op: 'add', id: 'sun', kind: 'circle', center: [140, 120], r: 52, color: '#F0A227', fill: true },
    { op: 'add', id: 'sunlbl', kind: 'label', target: 'sun', side: 'below', text: 'the Sun' },
    { op: 'add', id: 'b1', kind: 'box', at: [420, 120], text: 'Water in oceans warms up', color: '#2C5BE0' },
    { op: 'add', id: 'b2', kind: 'box', at: [740, 120], text: 'Vapour rises and cools', color: '#2C5BE0' },
    { op: 'add', id: 'b3', kind: 'box', at: [740, 330], text: 'Clouds form (condensation)', color: '#7A4DD8' },
    { op: 'add', id: 'b4', kind: 'box', at: [420, 330], text: 'Rain falls (precipitation)', color: '#14A07A' },
    { op: 'add', id: 'b5', kind: 'box', at: [140, 330], text: 'Rivers carry water back', color: '#2C5BE0' },
    { op: 'add', id: 'c1', kind: 'connector', from: 'sun', to: 'b1', label: 'heat' },
    { op: 'add', id: 'c2', kind: 'connector', from: 'b1', to: 'b2', label: 'evaporation' },
    { op: 'add', id: 'c3', kind: 'connector', from: 'b2', to: 'b3' },
    { op: 'add', id: 'c4', kind: 'connector', from: 'b3', to: 'b4' },
    { op: 'add', id: 'c5', kind: 'connector', from: 'b4', to: 'b5' },
    { op: 'add', id: 'c6', kind: 'connector', from: 'b5', to: 'b1', dash: true, label: 'the cycle repeats' },
    { op: 'add', id: 'title', kind: 'text', at: [400, 520], text: 'The water cycle', size: 'big' },
  ],
  graphs: [
    { op: 'add', id: 'ax', kind: 'axes', at: [120, 80], w: 460, h: 360, xRange: [-4, 4], yRange: [-2, 14], xLabel: 'x', yLabel: 'y' },
    { op: 'add', id: 'p1', kind: 'plot', axes: 'ax', expr: 'x^2', label: 'y = x²', color: '#2C5BE0' },
    { op: 'add', id: 'p2', kind: 'plot', axes: 'ax', expr: '2x + 3', label: 'y = 2x + 3', color: '#E14B3C' },
    { op: 'add', id: 'pt1', kind: 'point', at: [434, 187], label: 'they meet here', color: '#14A07A' },
    { op: 'add', id: 'bars', kind: 'bars', at: [660, 120], w: 290, h: 280, yLabel: 'rainfall (mm)', items: [
      { label: 'Mar', value: 48 }, { label: 'Apr', value: 62 }, { label: 'May', value: 90 }, { label: 'Jun', value: 34 },
    ], color: '#14A07A' },
    { op: 'add', id: 'nl', kind: 'numberline', at: [140, 520], w: 700, min: -1, max: 1, step: 0.25, marks: [
      { value: -0.5, label: '-½', color: '#E14B3C' }, { value: 0.75, label: '¾', color: '#2C5BE0' },
    ] },
  ],
  humanities: [
    { op: 'add', id: 'title', kind: 'text', at: [80, 70], text: 'Why did people build cities near rivers?', size: 'big' },
    { op: 'add', id: 'river', kind: 'path-substitute', at: [0, 0] },
    { op: 'add', id: 'b1', kind: 'box', at: [180, 200], text: 'Fresh water to drink', color: '#2C5BE0' },
    { op: 'add', id: 'b2', kind: 'box', at: [500, 160], text: 'Rich soil for farming', color: '#14A07A' },
    { op: 'add', id: 'b3', kind: 'box', at: [800, 200], text: 'Boats move goods and people', color: '#F0A227' },
    { op: 'add', id: 'hub', kind: 'circle', center: [500, 380], r: 60, color: '#E14B3C' },
    { op: 'add', id: 'hublbl', kind: 'label', target: 'hub', side: 'below', text: 'a city grows' },
    { op: 'add', id: 'c1', kind: 'connector', from: 'b1', to: 'hub' },
    { op: 'add', id: 'c2', kind: 'connector', from: 'b2', to: 'hub' },
    { op: 'add', id: 'c3', kind: 'connector', from: 'b3', to: 'hub' },
    { op: 'add', id: 'tbl', kind: 'table', at: [120, 470], headerRow: true, rows: [
      ['River', 'Civilisation'],
      ['Nile', 'Ancient Egypt'],
      ['Tigris', 'Mesopotamia'],
    ] },
    { op: 'add', id: 'eq', kind: 'equation', at: [700, 500], latex: '\\text{water} + \\text{soil} \\Rightarrow \\text{food}', color: '#14A07A' },
  ],
};

export function BoardHarness() {
  const [scene, setScene] = useState<SceneState>(emptyScene);
  const [highlights, setHighlights] = useState<BoardHighlight[]>([]);
  const [rejections, setRejections] = useState<string[]>([]);
  const animatorRef = useRef<BoardAnimator | null>(null);
  const nonce = useRef(0);

  const load = useCallback((name: string) => {
    const { ops, rejected } = validateOps(SCENES[name]);
    setRejections(rejected.map((r) => r.reason));
    setScene((prev) => {
      const cleared = applyOps(prev, [{ op: 'clear' } as BoardOp], 'tutor');
      return applyOps(cleared.scene, ops, 'tutor').scene;
    });
  }, []);

  const highlight = useCallback(() => {
    setScene((current) => {
      const first = current.items[0];
      if (first) {
        nonce.current += 1;
        setHighlights([{ id: first.id, nonce: nonce.current }]);
      }
      return current;
    });
  }, []);

  const buttons = useMemo(() => Object.keys(SCENES), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--rail)' }}>
      <div style={{ display: 'flex', gap: 8, padding: 10 }}>
        {buttons.map((name) => (
          <button key={name} onClick={() => load(name)} data-scene={name}>
            {name}
          </button>
        ))}
        <button onClick={highlight}>highlight first</button>
        <button onClick={() => animatorRef.current?.finishAll()}>finish anims</button>
      </div>
      {rejections.length > 0 && (
        <div style={{ padding: '0 10px', color: '#E14B3C', fontSize: 13 }} data-rejections>
          rejected: {rejections.join(' | ')}
        </div>
      )}
      <div style={{ flex: 1, margin: 12, background: 'var(--board)', borderRadius: 12, border: '1px solid var(--rail-line)' }}>
        <BoardCanvas
          scene={scene}
          highlights={highlights}
          tool="pointer"
          penColor="#2C5BE0"
          interactive={false}
          onLearnerStroke={() => {}}
          onLearnerErase={() => {}}
          animatorRef={(a) => {
            animatorRef.current = a;
          }}
        />
      </div>
    </div>
  );
}
