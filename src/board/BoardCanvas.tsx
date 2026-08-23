import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { BOARD_W, BOARD_H, type Vec } from '../../shared/boardOps';
import { compileScene, nodeBBox, type CompiledItem, type RenderNode, type BBox } from './compile';
import type { SceneState } from './scene';
import { BoardAnimator, hideForAnimation, type PenPosition } from './animator';
import { contains, deriveSemanticViewport } from './semanticViewport';
import { FONT_HAND } from './measure';
import './Board.css';

export type BoardTool = 'pointer' | 'draw' | 'erase';

export interface BoardHighlight {
  id: string;
  nonce: number;
}

interface BoardCanvasProps {
  scene: SceneState;
  /** IDs the tutor just added; they get draw-on animation in this order. */
  highlights: BoardHighlight[];
  tool: BoardTool;
  penColor: string;
  interactive: boolean;
  onLearnerStroke: (points: Vec[]) => void;
  onLearnerErase: (id: string) => void;
  onLearnerActivityStart?: () => void;
  onTutorPen?: (position: PenPosition | null) => void;
  onLearnerAttention?: (position: Vec, kind: 'drawing' | 'pointer' | 'focus') => void;
  longDescription?: string;
  /** Lets the lesson own generation-scoped animation transactions. */
  animatorRef?: (animator: BoardAnimator) => void;
  focusSemanticObjectId?: string;
  focusIndex?: number;
  overview?: boolean;
  onCaptureReady?: (capture: () => Promise<string | null>) => void;
}

function KatexBlock({ node }: { node: Extract<RenderNode, { type: 'katex' }> }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(node.latex, { throwOnError: false, output: 'html' });
    } catch {
      return node.latex;
    }
  }, [node.latex]);
  return (
    <foreignObject
      x={node.x}
      y={node.y}
      width={Math.min(BOARD_W - node.x, node.w * 1.6 + 40)}
      height={node.h * 1.6 + 20}
      className="board__katex"
    >
      <div
        style={{ fontSize: node.fontSize, color: node.color }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </foreignObject>
  );
}

const NodeView = memo(function NodeView({
  node,
  refCallback,
  hiddenInFocus,
  textKey,
}: {
  node: RenderNode;
  refCallback: (el: SVGElement | null) => void;
  hiddenInFocus: boolean;
  textKey: string;
}) {
  if (node.type === 'path') {
    return (
      <path
        ref={refCallback as (el: SVGPathElement | null) => void}
        d={node.d}
        stroke={node.color}
        strokeWidth={node.width}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={node.fill ?? 'none'}
        strokeDasharray={node.dash ? '7 7' : undefined}
        className="board__stroke"
      />
    );
  }
  if (node.type === 'text') {
    return (
      <text
        ref={refCallback as (el: SVGTextElement | null) => void}
        x={node.x}
        y={node.y}
        fontSize={node.size}
        fill={node.color}
        textAnchor={node.anchor}
        fontFamily={FONT_HAND}
        fontWeight={600}
        className="board__text"
        visibility={hiddenInFocus ? 'hidden' : 'visible'}
        data-required-text={node.text}
        data-required-text-key={textKey}
        data-focus-contained={hiddenInFocus ? 'false' : 'true'}
      >
        {node.text}
      </text>
    );
  }
  return (
    <g
      ref={refCallback as (el: SVGGElement | null) => void}
      visibility={hiddenInFocus ? 'hidden' : 'visible'}
      data-required-text={node.latex}
      data-required-text-key={textKey}
      data-focus-contained={hiddenInFocus ? 'false' : 'true'}
    >
      <KatexBlock node={node} />
    </g>
  );
});

/** Pen nib that follows live drawing. */
function Pen({ pos }: { pos: PenPosition | null }) {
  return (
    <g
      className={`board__pen${pos ? ' board__pen--active' : ''}`}
      style={
        pos
          ? { transform: `translate(${pos.x}px, ${pos.y}px)` }
          : undefined
      }
      aria-hidden="true"
    >
      <circle r="4" className="board__pen-dot" />
      <path
        d="M 3 -3 L 17 -22 L 23 -18 L 9 1 Z M 3 -3 l -1.5 6 l 5.5 -2.6 Z"
        className="board__pen-body"
      />
    </g>
  );
}

export function BoardCanvas({
  scene,
  highlights,
  tool,
  penColor,
  interactive,
  onLearnerStroke,
  onLearnerErase,
  onLearnerActivityStart,
  onTutorPen,
  onLearnerAttention,
  longDescription,
  animatorRef,
  focusSemanticObjectId,
  focusIndex = 0,
  overview = false,
  onCaptureReady,
}: BoardCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const animator = useMemo(() => new BoardAnimator(), []);
  const [pen, setPen] = useState<PenPosition | null>(null);
  const nodeEls = useRef(new Map<string, (SVGElement | null)[]>());
  const animatedIds = useRef(new Set<string>());
  const lastEpoch = useRef(scene.epoch);
  const [liveStroke, setLiveStroke] = useState<Vec[] | null>(null);
  const [fontsReady, setFontsReady] = useState(() => !document.fonts);
  const [compact, setCompact] = useState(() => window.matchMedia?.('(max-width: 540px), (max-height: 500px)').matches ?? false);
  const strokeRef = useRef<Vec[] | null>(null);

  useEffect(() => {
    animator.onPen = (position) => {
      setPen(position);
      onTutorPen?.(position);
    };
    animatorRef?.(animator);
    return () => animator.cancelAll();
  }, [animator, animatorRef, onTutorPen]);

  useEffect(() => {
    if (!onCaptureReady) return;
    onCaptureReady(() => captureBoardImage(svgRef.current));
  }, [onCaptureReady]);

  useEffect(() => {
    let cancelled = false;
    if (!document.fonts) return;
    void document.fonts.ready.then(() => { if (!cancelled) setFontsReady(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 540px), (max-height: 500px)');
    if (!query) return;
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  const compiled = useMemo(() => fontsReady ? compileScene(scene.items) : [], [scene.items, fontsReady]);
  const semanticViewport = useMemo(
    () => overview || !compact
      ? { x: 0, y: 0, w: BOARD_W, h: BOARD_H, itemIds: [] }
      : deriveSemanticViewport(scene, focusSemanticObjectId, focusIndex, highlights.map((highlight) => highlight.id)),
    [scene, focusSemanticObjectId, focusIndex, overview, compact, highlights],
  );

  // A clear resets animation memory so re-used ids animate again.
  if (scene.epoch !== lastEpoch.current) {
    lastEpoch.current = scene.epoch;
    animatedIds.current = new Set();
  }

  // After render: hide and enqueue newly-added tutor items, in scene order.
  useEffect(() => {
    const fresh: CompiledItem[] = [];
    for (const item of compiled) {
      const key = `${item.id}@${scene.epoch}`;
      if (item.owner === 'tutor' && !animatedIds.current.has(key)) {
        animatedIds.current.add(key);
        if (item.revision === 0) fresh.push(item);
      }
    }
    for (const item of fresh) {
      const els = nodeEls.current.get(item.id);
      if (!els) continue;
      const nodes = item.nodes
        .map((node, i) => {
          const el = els[i];
          if (!el) return null;
          const kind = node.type;
          const length =
            node.type === 'path' ? node.length : node.type === 'text' ? node.text.length : 24;
          hideForAnimation(el, kind, length);
          return { el, kind, length };
        })
        .filter((n): n is NonNullable<typeof n> => n !== null);
      if (nodes.length > 0) animator.enqueue({ itemId: item.id, nodes });
    }
  }, [compiled, scene.epoch, animator]);

  const boardPoint = useCallback((clientX: number, clientY: number): Vec => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const ctm = typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
    if (ctm) {
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const p = pt.matrixTransform(ctm.inverse());
      return [
        Math.max(0, Math.min(BOARD_W, p.x)),
        Math.max(0, Math.min(BOARD_H, p.y)),
      ];
    }
    const rect = svg.getBoundingClientRect();
    return [
      Math.max(0, Math.min(BOARD_W, ((clientX - rect.left) / rect.width) * BOARD_W)),
      Math.max(0, Math.min(BOARD_H, ((clientY - rect.top) / rect.height) * BOARD_H)),
    ];
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!interactive || tool !== 'draw' || e.button !== 0) return;
      e.preventDefault();
      onLearnerActivityStart?.();
      svgRef.current?.setPointerCapture?.(e.pointerId);
      const start = boardPoint(e.clientX, e.clientY);
      strokeRef.current = [start];
      setLiveStroke([start]);
    },
    [interactive, tool, boardPoint, onLearnerActivityStart],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const stroke = strokeRef.current;
      const point = boardPoint(e.clientX, e.clientY);
      onLearnerAttention?.(point, stroke ? 'drawing' : 'pointer');
      if (!stroke) return;
      const previous = stroke[stroke.length - 1];
      if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 3) return;
      stroke.push(point);
      setLiveStroke([...stroke]);
    },
    [boardPoint, onLearnerAttention],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const stroke = strokeRef.current;
      if (!stroke) return;
      strokeRef.current = null;
      setLiveStroke(null);
      if (svgRef.current?.hasPointerCapture?.(e.pointerId)) {
        svgRef.current.releasePointerCapture?.(e.pointerId);
      }
      if (stroke.length >= 2) onLearnerStroke(stroke);
    },
    [onLearnerStroke],
  );

  const eraseTarget = useCallback(
    (id: string, owner: 'tutor' | 'learner') => (e: React.PointerEvent) => {
      if (!interactive || tool !== 'erase') return;
      if (owner !== 'learner') return; // the tutor's work is erased by asking
      e.preventDefault();
      e.stopPropagation();
      onLearnerErase(id);
    },
    [interactive, tool, onLearnerErase],
  );

  const highlightBoxes = useMemo(() => {
    const byId = new Map(compiled.map((item) => [item.id, item.bbox]));
    return highlights
      .map((h) => ({ ...h, bbox: byId.get(h.id) }))
      .filter((h): h is BoardHighlight & { bbox: BBox } => Boolean(h.bbox));
  }, [highlights, compiled]);

  return (
    <div className="board__a11y-wrap">
    <svg
      ref={svgRef}
      className={`board__svg board__svg--${tool}`}
      data-fonts-ready={fontsReady}
      viewBox={`${semanticViewport.x} ${semanticViewport.y} ${semanticViewport.w} ${semanticViewport.h}`}
      data-semantic-object={focusSemanticObjectId ?? ''}
      data-viewbox={`${semanticViewport.x},${semanticViewport.y},${semanticViewport.w},${semanticViewport.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Shared Noura whiteboard"
      aria-describedby="noura-board-description"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {highlightBoxes.map((h) => (
        <rect
          key={`${h.id}-${h.nonce}`}
          className="board__highlight"
          x={h.bbox.x - 12}
          y={h.bbox.y - 12}
          width={h.bbox.w + 24}
          height={h.bbox.h + 24}
          rx={12}
        />
      ))}

      {compiled.map((item) => {
        const els: (SVGElement | null)[] = [];
        nodeEls.current.set(item.id, els);
        return (
          <g
            key={`${item.id}@${scene.epoch}`}
            data-item={item.id}
            onPointerDown={eraseTarget(item.id, item.owner)}
            className={
              tool === 'erase' && item.owner === 'learner' ? 'board__item board__item--erasable' : 'board__item'
            }
            tabIndex={interactive ? 0 : undefined}
            onFocus={() => onLearnerAttention?.([
              item.bbox.x + item.bbox.w / 2,
              item.bbox.y + item.bbox.h / 2,
            ], 'focus')}
          >
            {item.nodes.map((node, i) => (
              <NodeView
                key={`${i}-${item.revision}`}
                node={node}
                textKey={`${item.id}:${i}`}
                hiddenInFocus={Boolean(
                  compact && !overview && focusSemanticObjectId &&
                  (node.type === 'text' || node.type === 'katex') &&
                  !contains(semanticViewport, nodeBBox(node), -12),
                )}
                refCallback={(el) => {
                  els[i] = el;
                }}
              />
            ))}
            {tool === 'erase' && item.owner === 'learner' && (
              <rect
                x={item.bbox.x - 8}
                y={item.bbox.y - 8}
                width={item.bbox.w + 16}
                height={item.bbox.h + 16}
                className="board__erase-target"
              />
            )}
          </g>
        );
      })}

      {liveStroke && liveStroke.length > 1 && (
        <path
          d={`M ${liveStroke.map((p) => `${p[0]} ${p[1]}`).join(' L ')}`}
          stroke={penColor}
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}

      <Pen pos={pen} />
    </svg>
      <p id="noura-board-description" className="board__long-description">
        {longDescription ?? 'The shared teaching board is empty.'}
      </p>
    </div>
  );
}

async function captureBoardImage(svg: SVGSVGElement | null): Promise<string | null> {
  if (!svg) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(BOARD_W));
  clone.setAttribute('height', String(BOARD_H));
  clone.setAttribute('viewBox', `0 0 ${BOARD_W} ${BOARD_H}`);
  const markup = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('board image could not be rendered'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = Math.round((768 * BOARD_H) / BOARD_W);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#fcfbf7';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrl.length <= 300_000) return dataUrl;
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
