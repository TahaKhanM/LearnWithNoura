import { pointsToPath } from './geometry';
import type { BoardSnapshot } from './scene';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Re-renders the canonical scene rather than photographing the DOM. The
 * resulting image has the board and its marks, but no toolbar, text editor,
 * or other interface chrome.
 */
export function boardSnapshotToSvg(snapshot: BoardSnapshot): string {
  const marks = snapshot.objects.map(({ action }) => {
    const color = escapeXml(action.color ?? '#26231F');

    if (action.type === 'drawLine') {
      return `<line x1="${action.x1}" y1="${action.y1}" x2="${action.x2}" y2="${action.y2}" stroke="${color}" stroke-width="${action.strokeWidth ?? 3}" stroke-linecap="round"/>`;
    }
    if (action.type === 'drawEllipse') {
      return `<ellipse cx="${action.x}" cy="${action.y}" rx="${action.rx}" ry="${action.ry}" fill="none" stroke="${color}" stroke-width="${action.strokeWidth ?? 3}"/>`;
    }
    if (action.type === 'drawPath') {
      return `<path d="${pointsToPath(action.points)}" fill="none" stroke="${color}" stroke-width="${action.strokeWidth ?? 4}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    return `<text x="${action.x}" y="${action.y}" fill="${color}" font-family="'Comic Sans MS','Segoe Print',sans-serif" font-size="${action.fontSize ?? 28}" font-weight="600">${escapeXml(action.str)}</text>`;
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${snapshot.width}" height="${snapshot.height}" viewBox="0 0 ${snapshot.width} ${snapshot.height}">`,
    '<defs><pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse"><path d="M34 0H0V34" fill="none" stroke="#e9e6dc" stroke-width="1"/></pattern></defs>',
    `<rect width="${snapshot.width}" height="${snapshot.height}" fill="#fcfbf7"/>`,
    `<rect width="${snapshot.width}" height="${snapshot.height}" fill="url(#grid)"/>`,
    ...marks,
    '</svg>',
  ].join('');
}

function loadSvgImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not render the whiteboard image.'));
    image.src = url;
  });
}

/** Rasterizes the scene into a data URL accepted by multimodal chat models. */
export async function captureBoardPng(snapshot: BoardSnapshot): Promise<string> {
  const blob = new Blob([boardSnapshotToSvg(snapshot)], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadSvgImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable.');
    context.drawImage(image, 0, 0, snapshot.width, snapshot.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}
