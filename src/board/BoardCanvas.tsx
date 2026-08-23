import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { BOARD_W, BOARD_H, type Vec } from '../../shared/boardOps';
import { compileScene, nodeBBox, type RenderNode, type BBox } from './compile';
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

/** A released tutor checkpoint whose new objects should draw on once. */
export interface BoardAnimationRequest {
  id: string;
  itemIds: string[];
}

export interface BoardCaptureOptions { focusBox?: BBox }

interface BoardCanvasProps {
  scene: SceneState;
  /** IDs the tutor just added; they get draw-on animation in this order. */
  highlights: BoardHighlight[];
  animationRequest?: BoardAnimationRequest | null;
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
  onCaptureReady?: (capture: (options?: BoardCaptureOptions) => Promise<string | null>) => void;
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
  animationPending,
}: {
  node: RenderNode;
  refCallback: (el: SVGElement | null) => void;
  hiddenInFocus: boolean;
  textKey: string;
  animationPending: boolean;
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
        style={animationPending ? {
          strokeDasharray: `${Math.max(1, node.length)}`,
          strokeDashoffset: `${Math.max(1, node.length)}`,
          fillOpacity: 0,
        } : undefined}
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
        style={animationPending ? { opacity: 0 } : undefined}
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
      style={animationPending ? { opacity: 0 } : undefined}
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
  animationRequest,
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
  const onTutorPenRef = useRef(onTutorPen);
  const nodeEls = useRef(new Map<string, (SVGElement | null)[]>());
  const enqueuedAnimationRequests = useRef(new Set<string>());
  const [liveStroke, setLiveStroke] = useState<Vec[] | null>(null);
  const [fontsReady, setFontsReady] = useState(() => !document.fonts);
  const [compact, setCompact] = useState(() => window.matchMedia?.('(max-width: 540px), (max-height: 500px)').matches ?? false);
  const strokeRef = useRef<Vec[] | null>(null);

  useEffect(() => {
    onTutorPenRef.current = onTutorPen;
  }, [onTutorPen]);

  // The animator belongs to the mounted canvas, not to the render-time
  // identity of callback props. Mic/phase updates can re-render LessonPage at
  // audio-frame frequency and must never tear down an in-progress drawing.
  useEffect(() => {
    animator.onPen = (position) => {
      setPen(position);
      onTutorPenRef.current?.(position);
    };
    return () => {
      animator.onPen = () => {};
      animator.cancelAll();
    };
  }, [animator]);

  useEffect(() => {
    animatorRef?.(animator);
  }, [animator, animatorRef]);

  useEffect(() => {
    if (!onCaptureReady) return;
    onCaptureReady((options) => captureBoardImage(svgRef.current, options));
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
  const pendingAnimationIds = useMemo(
    () => new Set(animationRequest?.itemIds ?? []),
    [animationRequest],
  );
  const semanticViewport = useMemo(
    () => overview || !compact
      ? { x: 0, y: 0, w: BOARD_W, h: BOARD_H, itemIds: [] }
      : deriveSemanticViewport(scene, focusSemanticObjectId, focusIndex, highlights.map((highlight) => highlight.id)),
    [scene, focusSemanticObjectId, focusIndex, overview, compact, highlights],
  );

  // Animation is an explicit released-checkpoint transaction. The nodes are
  // already hidden declaratively in this commit, and this layout effect queues
  // them before the browser can paint. This prevents visible -> hidden ->
  // visible flashes and stops unrelated re-renders/replays from reanimating.
  useLayoutEffect(() => {
    if (!animationRequest || enqueuedAnimationRequests.current.has(animationRequest.id)) return;
    const requested = new Set(animationRequest.itemIds);
    const fresh = compiled.filter((item) => requested.has(item.id));
    // Compilation can legitimately wait for fonts. Keep the animator's
    // transaction hold open until every requested object has DOM nodes.
    if (fresh.length !== requested.size) return;

    const tasks = fresh.map((item) => {
      const els = nodeEls.current.get(item.id);
      if (!els || els.length !== item.nodes.length) return null;
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
      return nodes.length > 0 ? { itemId: item.id, nodes } : null;
    });
    // Validate the whole checkpoint before enqueuing any part of it. A partial
    // ref commit must not duplicate earlier objects when React completes it.
    if (tasks.some((task) => task === null)) return;
    for (const task of tasks) animator.enqueue(task as NonNullable<typeof task>);
    enqueuedAnimationRequests.current.add(animationRequest.id);
    // Bound diagnostic memory during very long lessons.
    if (enqueuedAnimationRequests.current.size > 64) {
      const oldest = enqueuedAnimationRequests.current.values().next().value;
      if (oldest) enqueuedAnimationRequests.current.delete(oldest);
    }
    animator.commitTransaction(animationRequest.id);
  }, [animationRequest, compiled, animator]);

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
  const highlightedIds = useMemo(() => new Set(highlights.map((highlight) => highlight.id)), [highlights]);

  return (
    <div className="board__a11y-wrap">
    <svg
      ref={svgRef}
      className={`board__svg board__svg--${tool}`}
      data-fonts-ready={fontsReady}
      data-animation-request={animationRequest?.id ?? ''}
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
            data-animation-pending={pendingAnimationIds.has(item.id) ? 'true' : undefined}
            onPointerDown={eraseTarget(item.id, item.owner)}
            className={[
              'board__item',
              tool === 'erase' && item.owner === 'learner' ? 'board__item--erasable' : '',
              highlightedIds.size > 0 && item.owner === 'tutor' && !highlightedIds.has(item.id) ? 'board__item--deemphasized' : '',
            ].filter(Boolean).join(' ')}
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
                animationPending={pendingAnimationIds.has(item.id)}
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

async function captureBoardImage(svg: SVGSVGElement | null, options: BoardCaptureOptions = {}): Promise<string | null> {
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
    canvas.width = 960;
    canvas.height = 576;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#fcfbf7';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (options.focusBox) {
      // One image carries both global context and a legible detail crop. This
      // preserves spatial grounding while giving Realtime vision enough pixels
      // to inspect a small learner mark.
      context.drawImage(image, 0, 0, BOARD_W, BOARD_H, 0, 96, 640, 384);
      context.strokeStyle = '#d9d4ca';
      context.lineWidth = 2;
      context.strokeRect(0, 96, 640, 384);
      context.fillStyle = '#26231f';
      context.font = '600 18px sans-serif';
      context.fillText('Full board', 16, 78);
      context.fillText('Learner’s new mark', 668, 78);

      const crop = normalizedCrop(options.focusBox);
      const target = fitInside(crop.w, crop.h, 276, 430);
      const dx = 660 + (284 - target.w) / 2;
      const dy = 96 + (430 - target.h) / 2;
      context.drawImage(image, crop.x, crop.y, crop.w, crop.h, dx, dy, target.w, target.h);
      context.strokeStyle = '#2c5be0';
      context.strokeRect(dx - 4, dy - 4, target.w + 8, target.h + 8);
    } else {
      context.drawImage(image, 0, 0, BOARD_W, BOARD_H, 0, 0, canvas.width, canvas.height);
    }
    for (const quality of [0.82, 0.68, 0.54, 0.4]) {
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

function normalizedCrop(box: BBox): BBox {
  const x = Math.max(0, Math.min(BOARD_W - 1, box.x));
  const y = Math.max(0, Math.min(BOARD_H - 1, box.y));
  return {
    x,
    y,
    w: Math.max(1, Math.min(BOARD_W - x, box.w)),
    h: Math.max(1, Math.min(BOARD_H - y, box.h)),
  };
}

function fitInside(width: number, height: number, maxWidth: number, maxHeight: number): { w: number; h: number } {
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return { w: width * scale, h: height * scale };
}
