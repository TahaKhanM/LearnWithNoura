import type { ShapeSpec, Vec } from '../../shared/boardOps';
import { isCenterArc } from '../../shared/authoredSpecs';
import { translateCurriculumSpec } from '../../shared/curriculumSpecs';
import { compileScene, type BBox } from './compile';
import type { SceneState } from './scene';

export function resolveRelationalPlacements(scene: SceneState): SceneState {
  let arranged = scene;
  for (let pass = 0; pass < scene.items.length; pass += 1) {
    let changed = false;
    for (const item of arranged.items) {
      if (!item.place) continue;
      const target = arranged.items.find((candidate) => candidate.id === item.place?.anchor);
      if (!target || target.place) continue;
      const compiled = new Map(compileScene(arranged.items).map((entry) => [entry.id, entry.bbox]));
      const itemBounds = compiled.get(item.id); const targetBounds = compiled.get(target.id);
      if (!itemBounds || !targetBounds) continue;
      const obstacles = [...compiled.entries()].filter(([id]) => id !== item.id && id !== target.id).map(([, bounds]) => bounds);
      const desired = desiredOrigin(itemBounds, targetBounds, item.place.side, item.place.gap, item.place.align, obstacles);
      const translated = translateSpec(item.spec, desired.x - itemBounds.x, desired.y - itemBounds.y);
      if (!translated) continue;
      arranged = {
        ...arranged,
        items: arranged.items.map((candidate) => candidate.id === item.id
          ? { ...candidate, spec: translated, place: undefined, revision: candidate.revision + 1 }
          : candidate),
      };
      changed = true;
    }
    if (!changed) break;
  }
  return arranged;
}

function desiredOrigin(
  item: BBox,
  anchor: BBox,
  side: 'above' | 'below' | 'left' | 'right' | 'inside' | 'on',
  gap: number,
  align: 'start' | 'center' | 'end',
  obstacles: BBox[],
): { x: number; y: number } {
  const horizontal = align === 'start' ? anchor.x : align === 'end' ? anchor.x + anchor.w - item.w : anchor.x + (anchor.w - item.w) / 2;
  const vertical = align === 'start' ? anchor.y : align === 'end' ? anchor.y + anchor.h - item.h : anchor.y + (anchor.h - item.h) / 2;
  const originFor = (candidate: typeof side) => {
    if (candidate === 'above') return { x: horizontal, y: anchor.y - gap - item.h };
    if (candidate === 'below') return { x: horizontal, y: anchor.y + anchor.h + gap };
    if (candidate === 'left') return { x: anchor.x - gap - item.w, y: vertical };
    if (candidate === 'right') return { x: anchor.x + anchor.w + gap, y: vertical };
    if (candidate === 'inside') return { x: horizontal, y: Math.max(anchor.y + gap, vertical) };
    return { x: anchor.x + (anchor.w - item.w) / 2, y: anchor.y + (anchor.h - item.h) / 2 };
  };
  if (side === 'inside' || side === 'on') return originFor(side);
  const opposite: typeof side = side === 'above' ? 'below' : side === 'below' ? 'above' : side === 'left' ? 'right' : 'left';
  const perpendicular: Array<typeof side> = side === 'above' || side === 'below' ? ['right', 'left'] : ['below', 'above'];
  const candidates = [side, opposite, ...perpendicular].map(originFor);
  return candidates.find((origin) => {
    const box = { ...origin, w: item.w, h: item.h };
    return box.x >= 24 && box.y >= 24 && box.x + box.w <= 976 && box.y + box.h <= 576 &&
      obstacles.every((obstacle) => !overlap(box, obstacle, 10));
  }) ?? candidates[0];
}

function overlap(a: BBox, b: BBox, gap: number): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

function translateSpec(spec: ShapeSpec, dx: number, dy: number): ShapeSpec | null {
  const move = ([x, y]: Vec): Vec => [x + dx, y + dy];
  switch (spec.kind) {
    case 'line': return { ...spec, from: move(spec.from), to: move(spec.to) };
    case 'polygon': return { ...spec, points: spec.points.map(move) };
    case 'circle': case 'ellipse': return { ...spec, center: move(spec.center) };
    case 'point': case 'text': case 'equation': case 'axes': case 'bars': case 'numberline': case 'box': case 'table': case 'asset': case 'draggable': case 'snapZone': case 'tappable':
      return { ...spec, at: move(spec.at) };
    case 'angle': return { ...spec, vertex: move(spec.vertex), from: move(spec.from), to: move(spec.to) };
    case 'connector': return { ...spec, ...(Array.isArray(spec.from) ? { from: move(spec.from) } : {}), ...(Array.isArray(spec.to) ? { to: move(spec.to) } : {}) };
    case 'path': case 'curve': return { ...spec, points: spec.points.map(move) };
    case 'arc': return isCenterArc(spec)
      ? { ...spec, center: move(spec.center) }
      : { ...spec, from: move(spec.from), through: move(spec.through), to: move(spec.to) };
    case 'image': return { ...spec, at: move(spec.at), ...(spec.crop ? { crop: { ...spec.crop, x: spec.crop.x + dx, y: spec.crop.y + dy } } : {}) };
    case 'panelGrid': case 'regionFill': case 'scatter': case 'boxplot': case 'histogram': case 'isometricSolid': case 'cubeNet': case 'planView': case 'paperFoldHolePunch': case 'gridPaper': case 'clock': case 'protractor':
      return translateCurriculumSpec(spec, dx, dy);
    case 'label': case 'plot': case 'annotate': case 'transform':
      return null;
  }
}
