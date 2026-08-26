/**
 * Compile a generated illustration into an SVG image node. Extracted so
 * compile.ts does not grow: the image is a background container; labels
 * and equations stay on the overlay layer as exact BoardOps.
 */

import type { ImageSpec } from '../../shared/authoredSpecs';
import type { BBox } from './compile';

export const IMAGE_LABEL_BAND_PX = 44;

export interface ImageNode {
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  href: string;
  alt: string;
  crop?: { x: number; y: number; w: number; h: number };
}

/** Persist/replay stores assetId; the client resolves bytes through this path. */
export function illustrationHref(assetId: string): string {
  return `/api/board-assets/${encodeURIComponent(assetId)}`;
}

export function compileImage(spec: ImageSpec): ImageNode {
  const [x, y] = spec.at;
  return {
    type: 'image',
    x,
    y,
    w: spec.w,
    h: spec.h,
    href: illustrationHref(spec.assetId),
    alt: spec.alt,
    ...(spec.crop ? { crop: spec.crop } : {}),
  };
}

/** Top and bottom strips reserved for exact overlay labels. */
export function imageLabelBands(spec: ImageSpec): BBox[] {
  const [x, y] = spec.at;
  const band = Math.min(IMAGE_LABEL_BAND_PX, Math.max(12, spec.h / 6));
  return [
    { x, y, w: spec.w, h: band },
    { x, y: y + spec.h - band, w: spec.w, h: band },
  ];
}
