import { useCallback, useMemo, useRef } from 'react';
import type { UpdateOp, Vec } from '../../shared/boardOps';
import { isManipulativeSpec, MIN_MANIPULATIVE_HIT_PX } from '../../shared/manipulativeSpecs';
import type { SceneItem, SceneState } from './scene';
import { snapPointToZone } from './compileManipulatives';
import type { NumberlineSpec } from '../../shared/boardOps';

export type ManipulativeFeedback = 'idle' | 'correct' | 'try-again' | 'not-yet';

interface ManipulativeLayerProps {
  scene: SceneState;
  enabled: boolean;
  pointFromClient: (clientX: number, clientY: number) => Vec;
  regionOffset: (semanticGroupId?: string) => { x: number; y: number };
  activeRegionId?: string;
  onMove: (op: UpdateOp, inverse: UpdateOp, note: string) => void;
  onTap: (op: UpdateOp, inverse: UpdateOp, note: string) => void;
  feedback: ManipulativeFeedback;
  checkTargetId?: string;
}

function numberlineMapper(items: SceneItem[], numberlineId: string): ((value: number) => number) | undefined {
  const line = items.find((entry) => entry.id === numberlineId);
  if (!line || line.spec.kind !== 'numberline') return undefined;
  const spec = line.spec as NumberlineSpec;
  return (value: number) => spec.at[0] + ((value - spec.min) / (spec.max - spec.min)) * spec.w;
}

export function ManipulativeLayer({
  scene,
  enabled,
  pointFromClient,
  regionOffset,
  activeRegionId,
  onMove,
  onTap,
  feedback,
  checkTargetId,
}: ManipulativeLayerProps) {
  const dragRef = useRef<{ id: string } | null>(null);

  const operables = useMemo(
    () => scene.items.filter((item) => isManipulativeSpec(item.spec) && (item.spec.kind === 'draggable' || item.spec.kind === 'tappable')),
    [scene.items],
  );

  const snapZones = useMemo(
    () => scene.items.filter((item) => item.spec.kind === 'snapZone'),
    [scene.items],
  );

  const handlePointerDown = useCallback((item: SceneItem, event: React.PointerEvent<SVGElement>) => {
    if (!enabled || !isManipulativeSpec(item.spec)) return;
    event.stopPropagation();
    (event.currentTarget as SVGElement).setPointerCapture(event.pointerId);
    if (item.spec.kind === 'tappable') {
      const inverse: UpdateOp = { op: 'update', id: item.id, props: { selected: item.spec.selected === true } };
      const next = !item.spec.selected;
      onTap({ op: 'update', id: item.id, props: { selected: next } }, inverse, `${next ? 'selected' : 'deselected'} ${item.id}`);
      return;
    }
    if (item.spec.kind === 'draggable') dragRef.current = { id: item.id };
  }, [enabled, onTap]);

  const handlePointerMove = useCallback((item: SceneItem, event: React.PointerEvent<SVGElement>) => {
    if (!enabled || item.spec.kind !== 'draggable' || dragRef.current?.id !== item.id) return;
    const point = pointFromClient(event.clientX, event.clientY);
    let next = point;
    for (const zoneItem of snapZones) {
      if (zoneItem.spec.kind !== 'snapZone') continue;
      const mapper = zoneItem.spec.numberlineId ? numberlineMapper(scene.items, zoneItem.spec.numberlineId) : undefined;
      const snapped = snapPointToZone(point, zoneItem.spec, mapper);
      if (Math.hypot(snapped[0] - point[0], snapped[1] - point[1]) < 16) {
        next = snapped;
        break;
      }
    }
    const current = scene.items.find((entry) => entry.id === item.id);
    if (!current || current.spec.kind !== 'draggable') return;
    if (Math.hypot(next[0] - current.spec.at[0], next[1] - current.spec.at[1]) < 0.5) return;
    const inverse: UpdateOp = { op: 'update', id: item.id, props: { at: current.spec.at } };
    onMove({ op: 'update', id: item.id, props: { at: next } }, inverse, `moved ${item.id} to (${Math.round(next[0])}, ${Math.round(next[1])})`);
  }, [enabled, onMove, pointFromClient, scene.items, snapZones]);

  const handlePointerUp = useCallback((_item: SceneItem, event: React.PointerEvent<SVGElement>) => {
    dragRef.current = null;
    if ((event.currentTarget as SVGElement).hasPointerCapture(event.pointerId)) {
      (event.currentTarget as SVGElement).releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleKeyDown = useCallback((item: SceneItem, event: React.KeyboardEvent<SVGElement>) => {
    if (!enabled || !isManipulativeSpec(item.spec) || item.spec.kind !== 'tappable') return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const inverse: UpdateOp = { op: 'update', id: item.id, props: { selected: item.spec.selected === true } };
    const next = !item.spec.selected;
    onTap({ op: 'update', id: item.id, props: { selected: next } }, inverse, `${next ? 'selected' : 'deselected'} ${item.id} with keyboard`);
  }, [enabled, onTap]);

  if (!enabled || operables.length === 0) return null;

  return (
    <g className="board__manipulatives">
      {operables.map((item) => {
        if (!isManipulativeSpec(item.spec)) return null;
        if (activeRegionId && item.semanticGroupId && item.semanticGroupId !== activeRegionId) return null;
        const origin = regionOffset(item.semanticGroupId);
        const isTarget = checkTargetId === item.id;
        const size = item.spec.kind === 'draggable'
          ? Math.max(item.spec.size ?? MIN_MANIPULATIVE_HIT_PX, MIN_MANIPULATIVE_HIT_PX)
          : item.spec.kind === 'tappable' && item.spec.shape === 'circle'
            ? Math.max((item.spec.r ?? MIN_MANIPULATIVE_HIT_PX / 2) * 2, MIN_MANIPULATIVE_HIT_PX)
            : Math.max(item.spec.w ?? MIN_MANIPULATIVE_HIT_PX, item.spec.h ?? MIN_MANIPULATIVE_HIT_PX);
        const r = size / 2;
        const label = item.spec.kind === 'draggable'
          ? item.spec.label ?? `Move ${item.id}`
          : item.spec.kind === 'tappable'
            ? item.spec.label ?? `Choose ${item.id}`
            : `Move ${item.id}`;
        const feedbackClass = isTarget && feedback !== 'idle' ? ` board__manipulative--${feedback}` : '';
        return (
          <circle
            key={`hit-${item.id}`}
            className={`board__manipulative-hit${feedbackClass}`}
            cx={origin.x + item.spec.at[0]}
            cy={origin.y + item.spec.at[1]}
            r={r}
            tabIndex={0}
            role={item.spec.kind === 'tappable' ? 'button' : 'slider'}
            aria-label={label}
            aria-pressed={item.spec.kind === 'tappable' ? item.spec.selected === true : undefined}
            data-manipulative-id={item.id}
            onPointerDown={(event) => handlePointerDown(item, event)}
            onPointerMove={(event) => handlePointerMove(item, event)}
            onPointerUp={(event) => handlePointerUp(item, event)}
            onKeyDown={(event) => handleKeyDown(item, event)}
            style={{ fill: 'transparent', stroke: 'transparent', cursor: item.spec.kind === 'draggable' ? 'grab' : 'pointer' }}
          />
        );
      })}
    </g>
  );
}
