import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardOp } from '../../shared/boardOps';
import type { LayoutPreflightResult } from '../../shared/layoutFeedback';
import { adaptSemanticScene, VISUAL_PLAN_VERSION, type SemanticScenePlan } from '../../shared/semanticScene';
import { BoardCanvas, type BoardHighlight } from '../board/BoardCanvas';
import { registerKatexMeasurer } from '../board/compile';
import { measureKatexInDom, prepareDomBoardMeasurement } from '../board/domKatexMeasurer';
import { deriveSemanticViewports } from '../board/semanticViewport';
import { BoardSceneCoordinator } from '../board/sceneCoordinator';
import { sceneForGroup } from '../board/sceneGroups';
import { renderSceneImage } from '../board/snapshot';
import { resolveRelationalPlacements } from '../board/relationalPlacement';
import type { BoardAnimator } from '../board/animator';
import { describeScene, applyOps, emptyScene, type SceneState } from '../board/scene';
import './BoardHarness.css';

export type ScenePreflightVerdict = LayoutPreflightResult;

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
    nouraPreflightSceneWithContext?: (input: ContextSceneInput) => Promise<ScenePreflightVerdict>;
    nouraRenderSceneWithContext?: (input: ContextSceneInput) => Promise<string | null>;
  }
}

interface ContextSceneInput {
  existingTutorOps: BoardOp[];
  existingLearnerOps: BoardOp[];
  candidateOps: BoardOp[];
  semanticGroupId: string;
}

async function preflightScene(ops: BoardOp[], semanticGroupId?: string): Promise<ScenePreflightVerdict> {
  await prepareDomBoardMeasurement(ops);
  registerKatexMeasurer(measureKatexInDom);
  try {
    return new BoardSceneCoordinator().preflightTutorOps(ops, semanticGroupId);
  } finally {
    registerKatexMeasurer(null);
  }
}

async function renderSceneToImage(ops: BoardOp[], semanticGroupId?: string): Promise<string | null> {
  await prepareDomBoardMeasurement(ops);
  registerKatexMeasurer(measureKatexInDom);
  try {
    const applied = applyOps(emptyScene, ops, 'tutor', semanticGroupId);
    return await renderSceneImage(sceneForGroup(applied.scene, semanticGroupId));
  } finally {
    registerKatexMeasurer(null);
  }
}

async function preflightSceneWithContext(input: ContextSceneInput): Promise<ScenePreflightVerdict> {
  await prepareDomBoardMeasurement([...input.existingTutorOps, ...input.candidateOps]);
  registerKatexMeasurer(measureKatexInDom);
  try {
    const board = new BoardSceneCoordinator();
    board.applyReplay(input.existingTutorOps, 'tutor', input.semanticGroupId);
    board.applyLearner(input.existingLearnerOps, input.semanticGroupId);
    return board.preflightTutorOps(input.candidateOps, input.semanticGroupId);
  } finally {
    registerKatexMeasurer(null);
  }
}

async function renderSceneWithContext(input: ContextSceneInput): Promise<string | null> {
  await prepareDomBoardMeasurement([...input.existingTutorOps, ...input.candidateOps]);
  registerKatexMeasurer(measureKatexInDom);
  try {
    const board = new BoardSceneCoordinator();
    board.applyReplay(input.existingTutorOps, 'tutor', input.semanticGroupId);
    board.applyLearner(input.existingLearnerOps, input.semanticGroupId);
    if (!board.applyTutorCheckpoint(input.candidateOps, input.semanticGroupId)) return null;
    return renderSceneImage(sceneForGroup(board.current, input.semanticGroupId));
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
  handwritten: [
    { op: 'add', id: 'note-box', spec: { kind: 'box', at: [500, 280], w: 280, h: 90, text: 'Water cycle' } },
    { op: 'add', id: 'margin-note', spec: { kind: 'text', at: [80, 90], text: 'starts with the sun', style: 'handwritten', size: 'small' } },
  ],
  assets: [
    { op: 'add', id: 'icon-sun', spec: { kind: 'asset', assetId: 'sun', at: [220, 200], size: 88, label: 'Sun' }, color: 'amber' },
    { op: 'add', id: 'icon-cloud', spec: { kind: 'asset', assetId: 'cloud', at: [500, 180], size: 88, label: 'Cloud' }, color: 'blue' },
    { op: 'add', id: 'icon-drop', spec: { kind: 'asset', assetId: 'raindrop', at: [760, 200], size: 80, label: 'Rain' }, color: 'blue' },
    { op: 'add', id: 'icon-plant', spec: { kind: 'asset', assetId: 'plant', at: [500, 420], size: 88, label: 'Plant' }, color: 'green' },
  ],
  'arc-curve': [
    { op: 'add', id: 'guide-arc', spec: { kind: 'arc', center: [380, 280], r: 110, startDeg: 200, endDeg: 340 }, color: 'blue' },
    { op: 'add', id: 'smooth-curve', spec: { kind: 'curve', points: [[120, 420], [280, 180], [620, 500], [860, 220]] }, color: 'violet' },
    { op: 'add', id: 'arc-label', spec: { kind: 'text', at: [300, 120], text: 'smooth path' } },
  ],
  illustration: [
    { op: 'add', id: 'pond', spec: { kind: 'image', assetId: 'img-a1b2c3d4e5f67890', at: [80, 60], w: 840, h: 400, alt: 'A pond habitat with reeds and a frog' } },
    { op: 'add', id: 'frog-label', spec: { kind: 'text', at: [220, 540], text: 'frog' } },
    { op: 'add', id: 'reed-label', spec: { kind: 'text', at: [720, 540], text: 'reeds' } },
    { op: 'add', id: 'arrow', spec: { kind: 'line', from: [220, 520], to: [260, 360], arrow: 'end' }, color: 'amber' },
  ],
  annotations: [
    { op: 'add', id: 'annotation-box', spec: { kind: 'box', at: [250, 190], w: 220, h: 90, text: 'Key idea' }, color: 'blue' },
    { op: 'add', id: 'annotation-triangle', spec: { kind: 'polygon', points: [[520, 350], [680, 120], [840, 350]] } },
    { op: 'add', id: 'annotation-scale', spec: { kind: 'numberline', at: [150, 470], w: 700, min: 0, max: 10, step: 1 }, color: 'ink' },
    { op: 'add', id: 'annotation-circle', spec: { kind: 'annotate', style: 'circle', target: { type: 'semantic', objectId: 'annotation-box', anchor: 'center' } }, color: 'red' },
    { op: 'add', id: 'annotation-bracket', spec: { kind: 'annotate', style: 'bracket', target: { type: 'semantic', objectId: 'annotation-triangle', anchor: 'center' } }, color: 'violet' },
    { op: 'add', id: 'annotation-tick', spec: { kind: 'annotate', style: 'tick', target: { type: 'semantic', objectId: 'annotation-scale', anchor: 'tick:5' } }, color: 'green' },
    { op: 'add', id: 'annotation-callout', spec: { kind: 'annotate', style: 'callout', target: { type: 'semantic', objectId: 'annotation-triangle', anchor: 'vertex:1' }, note: 'Check the apex' }, color: '#F0A227' },
  ],
  'm7-data': [
    { op: 'add', id: 'm7-scatter', spec: { kind: 'scatter', at: [55, 80], w: 250, h: 220, xRange: [0, 10], yRange: [0, 20], points: [[1, 2], [3, 8], [5, 11], [7, 15], [9, 17]], xLabel: 'hours', yLabel: 'score' }, color: '#2C5BE0' },
    { op: 'add', id: 'm7-boxplot', spec: { kind: 'boxplot', at: [360, 205], w: 270, min: 1, q1: 3, median: 5, q3: 7, max: 10, label: 'Scores' }, color: '#7A4DD8' },
    { op: 'add', id: 'm7-histogram', spec: { kind: 'histogram', at: [690, 80], w: 250, h: 220, bins: [{ from: 0, to: 5, frequency: 2 }, { from: 5, to: 10, frequency: 6 }, { from: 10, to: 15, frequency: 4 }], xLabel: 'time', yLabel: 'frequency' }, color: '#14A07A' },
  ],
  'm7-spatial': [
    { op: 'add', id: 'm7-solid', spec: { kind: 'isometricSolid', at: [140, 455], unit: 54, voxels: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [1, 0, 1], [2, 0, 1], [2, 0, 2]] }, color: '#2C5BE0' },
    { op: 'add', id: 'm7-net', spec: { kind: 'cubeNet', at: [340, 90], cell: 70, faces: [{ id: 'A', row: 1, col: 0 }, { id: 'B', row: 1, col: 1 }, { id: 'C', row: 1, col: 2 }, { id: 'D', row: 1, col: 3 }, { id: 'E', row: 0, col: 1 }, { id: 'F', row: 2, col: 1 }] }, color: '#7A4DD8' },
    { op: 'add', id: 'm7-plan', spec: { kind: 'planView', at: [755, 120], cell: 55, heights: [[1, 0, 2], [3, 1, 0], [0, 2, 1]] }, color: '#14A07A' },
  ],
  'm7-relations': [
    { op: 'add', id: 'm7-panels', spec: { kind: 'panelGrid', at: [45, 55], w: 390, h: 230, rows: 2, cols: 2, panels: [{ row: 0, col: 0, label: '1', marks: [{ shape: 'circle', x: 0.4, y: 0.55, fill: true }] }, { row: 0, col: 1, label: '2', marks: [{ shape: 'circle', x: 0.35, y: 0.55, fill: true }, { shape: 'circle', x: 0.65, y: 0.55, fill: true }] }, { row: 1, col: 0, label: '3', marks: [{ shape: 'triangle', x: 0.5, y: 0.55, fill: true }] }] }, color: '#2C5BE0' },
    { op: 'add', id: 'm7-placed-pattern-note', place: { anchor: 'm7-panels', side: 'below', gap: 18, align: 'center' }, spec: { kind: 'text', at: [0, 0], text: 'Pattern grows by one', size: 'small' }, color: '#2C5BE0' },
    { op: 'add', id: 'm7-source-shape', spec: { kind: 'polygon', points: [[500, 220], [575, 80], [650, 220]] }, color: '#26231F' },
    { op: 'add', id: 'm7-transformed-shape', spec: { kind: 'transform', target: 'm7-source-shape', operation: { type: 'translate', vector: [210, 0] }, label: 'translated' }, color: '#E14B3C' },
    { op: 'add', id: 'm7-venn', spec: { kind: 'regionFill', mode: 'venn', at: [500, 290], w: 410, h: 220, operation: 'intersection', labels: ['A', 'B'] }, color: '#7A4DD8' },
    { op: 'add', id: 'm7-fraction-fill', spec: { kind: 'regionFill', mode: 'fraction', at: [65, 390], w: 350, h: 85, numerator: 3, denominator: 5 }, color: '#14A07A' },
  ],
  'm7-regions': [
    { op: 'add', id: 'm7-region-axes', spec: { kind: 'axes', at: [170, 70], w: 650, h: 430, xRange: [-5, 5], yRange: [-5, 5], xLabel: 'x', yLabel: 'y' }, color: '#26231F' },
    { op: 'add', id: 'm7-half-plane', spec: { kind: 'regionFill', mode: 'half_plane', axes: 'm7-region-axes', slope: 0.6, intercept: 1, side: 'above', inclusive: false }, color: '#2C5BE0' },
  ],
  'm7-paper': [
    { op: 'add', id: 'm7-paper-fold', spec: { kind: 'paperFoldHolePunch', at: [70, 120], w: 860, h: 330, folds: ['right', 'down'], holes: [[0.72, 0.35]] }, color: '#7A4DD8' },
  ],
  'm7-instruments': [
    { op: 'add', id: 'm7-grid', spec: { kind: 'gridPaper', at: [55, 70], w: 420, h: 440, spacing: 28, style: 'grid', majorEvery: 5 }, color: '#2C5BE0' },
    { op: 'add', id: 'm7-clock', spec: { kind: 'clock', center: [265, 285], r: 155, hour: 10, minute: 10 }, color: '#26231F' },
    { op: 'add', id: 'm7-protractor', spec: { kind: 'protractor', center: [735, 455], r: 215, angleDeg: 65, label: '65°' }, color: '#7A4DD8' },
  ],
};

const GROUPED_SCENES: Record<string, { groups: Array<{ id: string; ops: BoardOp[] }>; camera: string }> = {
  'two-regions': {
    camera: 'region-two',
    groups: [
      { id: 'region-one', ops: [{ op: 'add', id: 'one-box', spec: { kind: 'box', at: [900, 280], w: 160, h: 90, text: 'First idea' } }] },
      { id: 'region-two', ops: [{ op: 'add', id: 'two-box', spec: { kind: 'box', at: [500, 280], w: 300, h: 100, text: 'Second idea' } }] },
    ],
  },
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
  handwritten: 'group-handwritten',
  assets: 'group-assets',
  'arc-curve': 'group-arc-curve',
  illustration: 'group-illustration',
  annotations: 'group-annotations',
  'm7-data': 'group-m7-data',
  'm7-spatial': 'group-m7-spatial',
  'm7-relations': 'group-m7-relations',
  'm7-regions': 'group-m7-regions',
  'm7-paper': 'group-m7-paper',
  'm7-instruments': 'group-m7-instruments',
  'two-regions': 'region-two',
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

  const [cameraRegionId, setCameraRegionId] = useState<string | undefined>();
  const load = useCallback((name: string) => {
    const grouped = GROUPED_SCENES[name];
    const ops = SCENES[name] ?? [];
    setRejections([]);
    setActive(name);
    setFocusIndex(0);
    setOverview(false);
    setCameraRegionId(grouped?.camera ?? SCENE_GROUPS[name]);
    setScene((previous) => {
      let next = applyOps(previous, [{ op: 'clear' }], 'tutor').scene;
      if (grouped) {
        for (const group of grouped.groups) next = applyOps(next, group.ops, 'tutor', group.id).scene;
        return resolveRelationalPlacements(next);
      }
      return resolveRelationalPlacements(applyOps(next, ops, 'tutor', ['handwritten', 'assets', 'arc-curve', 'illustration', 'annotations'].includes(name) || name.startsWith('m7-') ? SCENE_GROUPS[name] : undefined).scene);
    });
  }, []);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('scene');
    if (requested && (SCENES[requested] || GROUPED_SCENES[requested])) load(requested);
  }, [load]);

  useEffect(() => {
    window.nouraPreflightScene = preflightScene;
    window.nouraRenderScene = renderSceneToImage;
    window.nouraPreflightSceneWithContext = preflightSceneWithContext;
    window.nouraRenderSceneWithContext = renderSceneWithContext;
    return () => {
      delete window.nouraPreflightScene;
      delete window.nouraRenderScene;
      delete window.nouraPreflightSceneWithContext;
      delete window.nouraRenderSceneWithContext;
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
  const buttons = useMemo(() => Object.keys(SCENES).filter((name) => !['triangle-angles', 'relationship-map', 'worked-steps', 'comparison', 'part-whole', 'handwritten', 'assets', 'arc-curve', 'illustration'].includes(name)), []);
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
          cameraRegionId={cameraRegionId ?? activeGroup}
          focusIndex={focusIndex}
          overview={overview}
        />
      </div>
    </main>
  );
}
