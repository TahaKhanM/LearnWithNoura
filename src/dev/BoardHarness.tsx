import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardOp } from '../../shared/boardOps';
import { adaptSemanticScene, VISUAL_PLAN_VERSION, type SemanticScenePlan } from '../../shared/semanticScene';
import { BoardCanvas, type BoardHighlight } from '../board/BoardCanvas';
import { registerKatexMeasurer } from '../board/compile';
import { measureKatexInDom } from '../board/domKatexMeasurer';
import { deriveSemanticViewports } from '../board/semanticViewport';
import { BoardSceneCoordinator } from '../board/sceneCoordinator';
import { sceneForGroup } from '../board/sceneGroups';
import { renderSceneImage } from '../board/snapshot';
import type { BoardAnimator } from '../board/animator';
import { describeScene, applyOps, emptyScene, type SceneState } from '../board/scene';
import './BoardHarness.css';

export interface ScenePreflightVerdict { accepted: boolean; reasons: string[] }

declare global {
  interface Window {
    /** Headless compiler validation entry point: runs the real client
     * pipeline (compile, inspection, annotation layout, quality budget)
     * with DOM-measured KaTeX bounds, against an empty board. */
    nouraPreflightScene?: (ops: BoardOp[], semanticGroupId?: string) => Promise<ScenePreflightVerdict>;
    /** Headless raster entry point: compiles the given ops through the
     * real render pipeline and returns the canonical board JPEG data URL
     * (the Board Director's eyes), or null when rendering fails. */
    nouraRenderScene?: (ops: BoardOp[], semanticGroupId?: string) => Promise<string | null>;
  }
}

async function preflightScene(ops: BoardOp[], semanticGroupId?: string): Promise<ScenePreflightVerdict> {
  await document.fonts.ready;
  registerKatexMeasurer(measureKatexInDom);
  try {
    return new BoardSceneCoordinator().preflightTutorOps(ops, semanticGroupId);
  } finally {
    registerKatexMeasurer(null);
  }
}

async function renderSceneToImage(ops: BoardOp[], semanticGroupId?: string): Promise<string | null> {
  await document.fonts.ready;
  registerKatexMeasurer(measureKatexInDom);
  try {
    const applied = applyOps(emptyScene, ops, 'tutor', semanticGroupId);
    return await renderSceneImage(sceneForGroup(applied.scene, semanticGroupId));
  } finally {
    registerKatexMeasurer(null);
  }
}

function semantic(
  template: SemanticScenePlan['groups'][number]['template'],
  domain: SemanticScenePlan['intent']['domain'],
  parameters: Record<string, unknown> = {},
): BoardOp[] {
  const noBoard = template === 'no_board';
  return adaptSemanticScene({
    schemaVersion: VISUAL_PLAN_VERSION,
    planId: `fixture-${template}`,
    intent: {
      objective: `Canonical ${template} fixture`,
      domain,
      relevance: noBoard ? 'none' : 'essential',
      questionAnswered: noBoard ? 'No visual question.' : `How is ${template} organized?`,
      rationale: noBoard ? 'Speech is clearer.' : 'This canonical fixture tests the visual relationship.',
      action: noBoard ? 'skip' : 'create',
      density: 'standard',
      ...(noBoard ? { noBoardReason: 'No diagram needed.' } : {}),
    },
    groups: [{ id: `group-${template}`, label: template, revealOrder: ['outline', 'relation', 'label', 'connector', 'emphasis'], template, parameters }],
  }).ops;
}

const SCENES: Record<string, BoardOp[]> = {
  pythagorean: semantic('pythagorean_area_proof', 'geometry'),
  'triangle-angles': semantic('triangle_angle_sum', 'geometry'),
  'unit-circle': semantic('unit_circle_projection', 'geometry', { angleDegrees: 60 }),
  slopes: semantic('slope_comparison', 'quantitative', { slopes: [1, 2, -1] }),
  fractions: semantic('fraction_comparison', 'quantitative', { values: [2 / 3, 3 / 5], labels: ['2/3', '3/5'] }),
  'water-cycle': semantic('causal_cycle', 'process', { labels: ['Evaporation', 'Condensation', 'Precipitation', 'Collection'] }),
  argument: semantic('argument_structure', 'argument'),
  history: semantic('cause_effect', 'history', { labels: ['New trade route', 'Goods and ideas move', 'Cities grow'] }),
  grammar: semantic('grammar_structure', 'grammar', { labels: ['The curious fox', 'followed', 'the bright trail'] }),
  'relationship-map': semantic('relationship_map', 'argument', { layout: 'hierarchy', nodes: [{ id: 'claim', label: 'Claim' }, { id: 'evidence', label: 'Evidence' }, { id: 'reason', label: 'Reasoning' }], edges: [{ from: 'claim', to: 'evidence', label: 'supported by' }, { from: 'evidence', to: 'reason' }] }),
  'worked-steps': semantic('worked_steps', 'algebra', { steps: ['Collect like terms', 'Subtract three', 'Divide by two', 'Check the result'] }),
  comparison: semantic('comparison', 'comparison', { leftTitle: 'Solid', rightTitle: 'Liquid', leftItems: ['Fixed shape', 'Particles packed'], rightItems: ['Takes container shape', 'Particles move'] }),
  'part-whole': semantic('part_whole', 'quantitative', { labels: ['Known', 'Unknown'], values: [3, 2], wholeLabel: 'Five equal parts' }),
  'no-board': semantic('no_board', 'none'),
};

const SCENE_GROUPS: Record<string, string> = {
  pythagorean: 'group-pythagorean_area_proof',
  'triangle-angles': 'group-triangle_angle_sum',
  'unit-circle': 'group-unit_circle_projection',
  slopes: 'group-slope_comparison',
  fractions: 'group-fraction_comparison',
  'water-cycle': 'group-causal_cycle',
  argument: 'group-argument_structure',
  history: 'group-cause_effect',
  grammar: 'group-grammar_structure',
  'relationship-map': 'group-relationship_map',
  'worked-steps': 'group-worked_steps',
  comparison: 'group-comparison',
  'part-whole': 'group-part_whole',
  'no-board': 'group-no_board',
};

export function BoardHarness() {
  const [scene, setScene] = useState<SceneState>(emptyScene);
  const [highlights, setHighlights] = useState<BoardHighlight[]>([]);
  const [rejections, setRejections] = useState<string[]>([]);
  const [active, setActive] = useState('none');
  const [focusIndex, setFocusIndex] = useState(0);
  const [overview, setOverview] = useState(false);
  const animatorRef = useRef<BoardAnimator | null>(null);
  const nonce = useRef(0);

  const load = useCallback((name: string) => {
    const ops = SCENES[name] ?? [];
    setRejections([]);
    setActive(name);
    setFocusIndex(0);
    setOverview(false);
    setScene((previous) => {
      const cleared = applyOps(previous, [{ op: 'clear' }], 'tutor');
      return applyOps(cleared.scene, ops, 'tutor').scene;
    });
  }, []);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('scene');
    if (requested && SCENES[requested]) load(requested);
  }, [load]);

  useEffect(() => {
    window.nouraPreflightScene = preflightScene;
    window.nouraRenderScene = renderSceneToImage;
    return () => {
      delete window.nouraPreflightScene;
      delete window.nouraRenderScene;
    };
  }, []);

  const highlight = useCallback(() => {
    setScene((current) => {
      const first = current.items[0];
      if (first) setHighlights([{ id: first.id, nonce: ++nonce.current }]);
      return current;
    });
  }, []);

  // The extra adversarial/canonical scene is addressable by URL for visual
  // tests without perturbing every established fixture screenshot.
  const buttons = useMemo(() => Object.keys(SCENES).filter((name) => !['triangle-angles', 'relationship-map', 'worked-steps', 'comparison', 'part-whole'].includes(name)), []);
  const activeGroup = SCENE_GROUPS[active];
  const viewCount = deriveSemanticViewports(scene, activeGroup, highlights.map((highlight) => highlight.id)).length;
  return (
    <main id="main-content" style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh', background: 'var(--rail)' }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 10 }} aria-label="Canonical scene fixtures">
        <strong style={{ alignSelf: 'center', marginRight: 8 }}>Noura visual fixtures</strong>
        {buttons.map((name) => <button key={name} onClick={() => load(name)} data-scene={name} style={{ minHeight: 44 }}>{name}</button>)}
        <button onClick={highlight} style={{ minHeight: 44 }}>Highlight first</button>
      </header>
      {rejections.length > 0 && <div style={{ padding: '0 10px', color: 'var(--red)', fontSize: 13 }} data-rejections>rejected: {rejections.join(' | ')}</div>}
      <p style={{ margin: '0 12px', color: 'var(--ink-soft)' }} data-active-scene>Active: {active}</p>
      {activeGroup && active !== 'no-board' && (
        <nav className="board-harness__focus-controls" aria-label="Board focus navigation">
          <label>Board section<select aria-label="Board section" value={activeGroup} onChange={() => undefined}><option value={activeGroup}>{active.replaceAll('-', ' ')}</option></select></label>
          <button aria-label="Previous part of this board section" disabled={overview || focusIndex <= 0} onClick={() => setFocusIndex((value) => Math.max(0, value - 1))}>Previous</button>
          <button aria-label="Next part of this board section" disabled={overview || focusIndex >= viewCount - 1} onClick={() => setFocusIndex((value) => Math.min(viewCount - 1, value + 1))}>Next</button>
          <button aria-label={overview ? 'Focus the active board area' : 'Fit the full board overview'} aria-pressed={overview} onClick={() => setOverview((value) => !value)}>{overview ? 'Focus' : 'Overview'}</button>
        </nav>
      )}
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
          focusSemanticObjectId={activeGroup}
          focusIndex={focusIndex}
          overview={overview}
        />
      </div>
    </main>
  );
}
