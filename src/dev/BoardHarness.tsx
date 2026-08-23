import { useCallback, useMemo, useRef, useState } from 'react';
import type { BoardOp } from '../../shared/boardOps';
import { adaptSemanticScene, VISUAL_PLAN_VERSION, type SemanticScenePlan } from '../../shared/semanticScene';
import { BoardCanvas, type BoardHighlight } from '../board/BoardCanvas';
import type { BoardAnimator } from '../board/animator';
import { describeScene, applyOps, emptyScene, type SceneState } from '../board/scene';
import './BoardHarness.css';

function semantic(
  template: SemanticScenePlan['groups'][number]['template'],
  domain: SemanticScenePlan['intent']['domain'],
  parameters: Record<string, unknown> = {},
): BoardOp[] {
  return adaptSemanticScene({
    schemaVersion: VISUAL_PLAN_VERSION,
    planId: `fixture-${template}`,
    intent: { objective: `Canonical ${template} fixture`, domain },
    groups: [{ id: `group-${template}`, label: template, revealOrder: ['outline', 'relation', 'label', 'connector', 'emphasis'], template, parameters }],
  }).ops;
}

const SCENES: Record<string, BoardOp[]> = {
  pythagorean: semantic('pythagorean_area_proof', 'geometry'),
  'unit-circle': semantic('unit_circle_projection', 'geometry', { angleDegrees: 60 }),
  slopes: semantic('slope_comparison', 'quantitative', { slopes: [1, 2, -1] }),
  fractions: semantic('fraction_comparison', 'quantitative', { values: [2 / 3, 3 / 5], labels: ['2/3', '3/5'] }),
  'water-cycle': semantic('causal_cycle', 'process', { labels: ['Evaporation', 'Condensation', 'Precipitation', 'Collection'] }),
  argument: semantic('argument_structure', 'argument'),
  history: semantic('cause_effect', 'history', { labels: ['New trade route', 'Goods and ideas move', 'Cities grow'] }),
  grammar: semantic('grammar_structure', 'grammar', { labels: ['The curious fox', 'followed', 'the bright trail'] }),
  'no-board': semantic('no_board', 'none'),
};

export function BoardHarness() {
  const [scene, setScene] = useState<SceneState>(emptyScene);
  const [highlights, setHighlights] = useState<BoardHighlight[]>([]);
  const [rejections, setRejections] = useState<string[]>([]);
  const [active, setActive] = useState('none');
  const animatorRef = useRef<BoardAnimator | null>(null);
  const nonce = useRef(0);

  const load = useCallback((name: string) => {
    const ops = SCENES[name] ?? [];
    setRejections([]);
    setActive(name);
    setScene((previous) => {
      const cleared = applyOps(previous, [{ op: 'clear' }], 'tutor');
      return applyOps(cleared.scene, ops, 'tutor').scene;
    });
  }, []);

  const highlight = useCallback(() => {
    setScene((current) => {
      const first = current.items[0];
      if (first) setHighlights([{ id: first.id, nonce: ++nonce.current }]);
      return current;
    });
  }, []);

  const buttons = useMemo(() => Object.keys(SCENES), []);
  return (
    <main id="main-content" style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh', background: 'var(--rail)' }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 10 }} aria-label="Canonical scene fixtures">
        <strong style={{ alignSelf: 'center', marginRight: 8 }}>Noura visual fixtures</strong>
        {buttons.map((name) => <button key={name} onClick={() => load(name)} data-scene={name} style={{ minHeight: 44 }}>{name}</button>)}
        <button onClick={highlight} style={{ minHeight: 44 }}>Highlight first</button>
      </header>
      {rejections.length > 0 && <div style={{ padding: '0 10px', color: 'var(--red)', fontSize: 13 }} data-rejections>rejected: {rejections.join(' | ')}</div>}
      <p style={{ margin: '0 12px', color: 'var(--ink-soft)' }} data-active-scene>Active: {active}</p>
      <div className="board-harness__surface" style={{ flex: 1, minHeight: 500, margin: 12, background: 'var(--board)', borderRadius: 12, border: '1px solid var(--rail-line)' }}>
        <BoardCanvas
          scene={scene}
          highlights={highlights}
          tool="pointer"
          penColor="#2C5BE0"
          interactive={false}
          onLearnerStroke={() => {}}
          onLearnerErase={() => {}}
          longDescription={describeScene(scene)}
          animatorRef={(animator) => { animatorRef.current = animator; }}
        />
      </div>
    </main>
  );
}
