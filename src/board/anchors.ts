import type { AnchorRef, ImageRegionSelector, ShapeSpec, Vec } from '../../shared/boardOps';
import { isCenterArc } from '../../shared/authoredSpecs';
import type { BBox } from './compile';
import { measureText, TEXT_SIZES } from './measure';
import type { SceneItem } from './scene';

export interface CompiledAnchor {
  point: Vec;
  bounds: BBox;
}
export type CompiledAnchors = Record<string, CompiledAnchor>;

export function anchorsForItem(item: SceneItem, bbox: BBox): CompiledAnchors {
  const anchors = genericAnchors(bbox);
  const spec = item.spec;
  switch (spec.kind) {
    case 'line':
      addPointAnchors(anchors, spec.from, spec.to);
      break;
    case 'polygon':
      spec.points.forEach((point, index) => { anchors[`vertex:${index}`] = pointAnchor(point); });
      break;
    case 'circle':
      anchors.center = pointAnchor(spec.center);
      anchors.top = pointAnchor([spec.center[0], spec.center[1] - spec.r]);
      anchors.bottom = pointAnchor([spec.center[0], spec.center[1] + spec.r]);
      anchors.left = pointAnchor([spec.center[0] - spec.r, spec.center[1]]);
      anchors.right = pointAnchor([spec.center[0] + spec.r, spec.center[1]]);
      break;
    case 'ellipse':
      anchors.center = pointAnchor(spec.center);
      anchors.top = pointAnchor([spec.center[0], spec.center[1] - spec.ry]);
      anchors.bottom = pointAnchor([spec.center[0], spec.center[1] + spec.ry]);
      anchors.left = pointAnchor([spec.center[0] - spec.rx, spec.center[1]]);
      anchors.right = pointAnchor([spec.center[0] + spec.rx, spec.center[1]]);
      break;
    case 'point': case 'text': case 'equation': case 'axes': case 'bars': case 'numberline': case 'box': case 'table':
    case 'asset': case 'image': case 'draggable': case 'snapZone': case 'tappable': case 'panelGrid': case 'scatter': case 'boxplot': case 'histogram': case 'isometricSolid': case 'cubeNet': case 'planView': case 'paperFoldHolePunch': case 'gridPaper':
      anchors.at = pointAnchor(spec.at);
      break;
    case 'angle':
      anchors.vertex = pointAnchor(spec.vertex);
      anchors.from = pointAnchor(spec.from);
      anchors.to = pointAnchor(spec.to);
      break;
    case 'path': case 'curve':
      if (spec.points.length > 0) addPointAnchors(anchors, spec.points[0], spec.points[spec.points.length - 1], spec.points[Math.floor((spec.points.length - 1) / 2)]);
      break;
    case 'arc':
      if (isCenterArc(spec)) anchors.center = pointAnchor(spec.center);
      else {
        anchors.start = pointAnchor(spec.from);
        anchors.middle = pointAnchor(spec.through);
        anchors.end = pointAnchor(spec.to);
      }
      break;
    case 'clock': case 'protractor':
      anchors.center = pointAnchor(spec.center);
      break;
    case 'connector': case 'label': case 'plot': case 'annotate': case 'transform': case 'regionFill':
      break;
  }
  addNumberlineAnchors(anchors, spec);
  addTableAnchors(anchors, spec);
  addBarAnchors(anchors, spec);
  addCurriculumAnchors(anchors, spec);
  return anchors;
}

export function resolveAnchorRef(
  ref: AnchorRef,
  items: readonly SceneItem[],
  anchors: ReadonlyMap<string, CompiledAnchors>,
  bboxes: ReadonlyMap<string, BBox>,
): CompiledAnchor | null {
  if (ref.type === 'point') return pointAnchor(ref.at);
  const id = ref.type === 'semantic' ? ref.objectId : ref.type === 'learner_stroke' ? ref.strokeId : ref.imageId;
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return null;
  if (ref.type === 'semantic') return anchors.get(id)?.[ref.anchor ?? 'center'] ?? null;
  if (ref.type === 'learner_stroke') {
    if (item.owner !== 'learner' || item.spec.kind !== 'path') return null;
    return anchors.get(id)?.[ref.anchor ?? 'middle'] ?? null;
  }
  if (item.spec.kind !== 'image') return null;
  const imageBounds = bboxes.get(id);
  return imageBounds ? resolveImageSelector(imageBounds, ref.selector) : null;
}

function genericAnchors(bounds: BBox): CompiledAnchors {
  const center: Vec = [bounds.x + bounds.w / 2, bounds.y + bounds.h / 2];
  return {
    center: { point: center, bounds: { ...bounds } },
    top: pointAnchor([center[0], bounds.y]),
    bottom: pointAnchor([center[0], bounds.y + bounds.h]),
    left: pointAnchor([bounds.x, center[1]]),
    right: pointAnchor([bounds.x + bounds.w, center[1]]),
    'corner:top-left': pointAnchor([bounds.x, bounds.y]),
    'corner:top-right': pointAnchor([bounds.x + bounds.w, bounds.y]),
    'corner:bottom-left': pointAnchor([bounds.x, bounds.y + bounds.h]),
    'corner:bottom-right': pointAnchor([bounds.x + bounds.w, bounds.y + bounds.h]),
  };
}

function pointAnchor(point: Vec): CompiledAnchor {
  return { point, bounds: { x: point[0], y: point[1], w: 0, h: 0 } };
}

function addPointAnchors(anchors: CompiledAnchors, start: Vec, end: Vec, middle?: Vec): void {
  anchors.start = pointAnchor(start);
  anchors.end = pointAnchor(end);
  anchors.middle = pointAnchor(middle ?? [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]);
}

function addNumberlineAnchors(anchors: CompiledAnchors, spec: ShapeSpec): void {
  if (spec.kind !== 'numberline') return;
  const step = spec.step && spec.step > 0 ? spec.step : (spec.max - spec.min) / 10;
  for (let value = Math.ceil(spec.min / step) * step; value <= spec.max + step / 1e6; value += step) {
    const rounded = Number(value.toPrecision(10));
    const x = spec.at[0] + ((rounded - spec.min) / (spec.max - spec.min)) * spec.w;
    anchors[`tick:${rounded}`] = pointAnchor([x, spec.at[1]]);
  }
  for (const mark of spec.marks ?? []) {
    const x = spec.at[0] + ((mark.value - spec.min) / (spec.max - spec.min)) * spec.w;
    anchors[`mark:${Number(mark.value.toPrecision(10))}`] = pointAnchor([x, spec.at[1] - 14]);
  }
}

function addTableAnchors(anchors: CompiledAnchors, spec: ShapeSpec): void {
  if (spec.kind !== 'table' || spec.rows.length === 0) return;
  const size = TEXT_SIZES.small;
  const columns = spec.rows[0].length;
  const widths = Array.from({ length: columns }, (_, column) => Math.min(200, Math.max(64, ...spec.rows.map((row) => measureText(row[column] ?? '', size) + 24))));
  const rowHeight = size * 1.22 + 16;
  let x = spec.at[0];
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < spec.rows.length; row += 1) {
      const bounds = { x, y: spec.at[1] + row * rowHeight, w: widths[column], h: rowHeight };
      anchors[`cell:${row}:${column}`] = { point: [bounds.x + bounds.w / 2, bounds.y + bounds.h / 2], bounds };
    }
    x += widths[column];
  }
}

function addBarAnchors(anchors: CompiledAnchors, spec: ShapeSpec): void {
  if (spec.kind !== 'bars' || spec.items.length === 0) return;
  const maximum = Math.max(...spec.items.map((item) => item.value), 1);
  const slot = spec.w / spec.items.length;
  const baseline = spec.at[1] + spec.h;
  spec.items.forEach((bar, index) => {
    const height = Math.max(2, (Math.max(0, bar.value) / maximum) * (spec.h - 18));
    anchors[`bar-top:${index}`] = pointAnchor([spec.at[0] + slot * (index + 0.5), baseline - height]);
  });
}

function addCurriculumAnchors(anchors: CompiledAnchors, spec: ShapeSpec): void {
  if (spec.kind === 'scatter') {
    spec.points.forEach(([x, y], index) => {
      const point: Vec = [
        spec.at[0] + ((x - spec.xRange[0]) / (spec.xRange[1] - spec.xRange[0])) * spec.w,
        spec.at[1] + spec.h - ((y - spec.yRange[0]) / (spec.yRange[1] - spec.yRange[0])) * spec.h,
      ];
      anchors[`point:${index}`] = pointAnchor(point);
    });
  } else if (spec.kind === 'clock') {
    const minuteAngle = spec.minute / 60 * Math.PI * 2 - Math.PI / 2;
    const hourAngle = ((spec.hour % 12 + spec.minute / 60) / 12) * Math.PI * 2 - Math.PI / 2;
    anchors['hand:minute'] = pointAnchor([spec.center[0] + Math.cos(minuteAngle) * spec.r * 0.8, spec.center[1] + Math.sin(minuteAngle) * spec.r * 0.8]);
    anchors['hand:hour'] = pointAnchor([spec.center[0] + Math.cos(hourAngle) * spec.r * 0.58, spec.center[1] + Math.sin(hourAngle) * spec.r * 0.58]);
  } else if (spec.kind === 'panelGrid') {
    const cellW = spec.w / spec.cols; const cellH = spec.h / spec.rows;
    for (let row = 0; row < spec.rows; row += 1) for (let col = 0; col < spec.cols; col += 1) {
      const bounds = { x: spec.at[0] + col * cellW, y: spec.at[1] + row * cellH, w: cellW, h: cellH };
      anchors[`panel:${row}:${col}`] = { point: [bounds.x + bounds.w / 2, bounds.y + bounds.h / 2], bounds };
    }
  } else if (spec.kind === 'cubeNet') {
    for (const face of spec.faces) {
      const bounds = { x: spec.at[0] + face.col * spec.cell, y: spec.at[1] + face.row * spec.cell, w: spec.cell, h: spec.cell };
      anchors[`face:${face.id}`] = { point: [bounds.x + spec.cell / 2, bounds.y + spec.cell / 2], bounds };
    }
  } else if (spec.kind === 'planView') {
    spec.heights.forEach((row, rowIndex) => row.forEach((_height, columnIndex) => {
      const bounds = { x: spec.at[0] + columnIndex * spec.cell, y: spec.at[1] + rowIndex * spec.cell, w: spec.cell, h: spec.cell };
      anchors[`cell:${rowIndex}:${columnIndex}`] = { point: [bounds.x + spec.cell / 2, bounds.y + spec.cell / 2], bounds };
    }));
  } else if (spec.kind === 'protractor') {
    for (let degree = 0; degree <= 180; degree += 10) {
      const angle = -degree * Math.PI / 180;
      anchors[`degree:${degree}`] = pointAnchor([spec.center[0] + Math.cos(angle) * spec.r, spec.center[1] + Math.sin(angle) * spec.r]);
    }
  }
}

function resolveImageSelector(image: BBox, selector: ImageRegionSelector): CompiledAnchor {
  if (selector.type === 'FragmentSelector') {
    const bounds = {
      x: image.x + image.w * selector.x,
      y: image.y + image.h * selector.y,
      w: image.w * selector.w,
      h: image.h * selector.h,
    };
    return { point: [bounds.x + bounds.w / 2, bounds.y + bounds.h / 2], bounds };
  }
  if (selector.type === 'PointSelector') {
    return pointAnchor([image.x + image.w * selector.x, image.y + image.h * selector.y]);
  }
  const points = selector.points.map(([x, y]): Vec => [image.x + image.w * x, image.y + image.h * y]);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  return { point: [bounds.x + bounds.w / 2, bounds.y + bounds.h / 2], bounds };
}
