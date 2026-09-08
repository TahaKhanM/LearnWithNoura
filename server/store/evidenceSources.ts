import type { EvidenceInput } from './repo.js';

export interface EvidenceSource {
  id: number;
  type: string;
  released: boolean;
  releaseRequested: boolean;
  payload: unknown;
}

export function evidenceSourceIds(entry: EvidenceInput): number[] {
  const ids = [...new Set(entry.sourceEventIds ?? [])];
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Evidence requires valid positive source event IDs.');
  }
  return ids;
}

/** Rows must have been selected from this evidence's session, under the write boundary. */
export function assertEvidenceSources(ids: number[], rows: EvidenceSource[], entry: EvidenceInput, released: boolean): void {
  const sources = new Map(rows.map(row => [row.id, row]));
  for (const id of ids) {
    const source = sources.get(id);
    if (!source) throw new Error('Every evidence source must exist in the same session.');
    if (source.released) continue;
    const payload = source.payload && typeof source.payload === 'object'
      ? source.payload as Record<string, unknown> : {};
    if (released || !entry.idempotencyKey || !entry.turnId || !entry.generationId
      || payload.idempotencyKey !== entry.idempotencyKey
      || payload.turnId !== entry.turnId || payload.generationId !== entry.generationId) {
      throw new Error('Unreleased evidence sources must belong to the same staged fallback generation.');
    }
    // Nonvisual events release atomically with turn completion. Visual sources
    // also need the browser checkpoint, otherwise completion leaves them hidden.
    if (source.type === 'semantic_scene' && !source.releaseRequested) {
      throw new Error('A visual evidence source must be acknowledged before staging evidence.');
    }
  }
}
