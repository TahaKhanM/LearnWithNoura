import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileM7CurriculumEvidence } from './m7CurriculumEvidence.js';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const resultRawJson = read('server/board/eval/results/2026-09-03-drawing-m7-curriculum-browser-verified.json');
const result = JSON.parse(resultRawJson) as { rows: Array<{ rowId: string; screenshotPath: string }>; contactSheets: Array<{ path: string }> };
const input = {
  matrixRawJson: read('server/board/eval/curriculum-matrix-m7.json'),
  baselineFixturesRawJson: read('server/board/eval/fixtures/curriculum-matrix-scenes.json'),
  m7FixturesRawJson: read('server/board/eval/fixtures/m7-curriculum-new-scenes.json'),
  resultRawJson,
  screenshots: Object.fromEntries(result.rows.map((row) => [row.rowId, readFileSync(resolve(row.screenshotPath))])),
  contactSheets: result.contactSheets.map((sheet) => readFileSync(resolve(sheet.path))),
};

describe('M7 curriculum browser evidence', () => {
  it('hash-verifies all 39 rows and inspected contact sheets', () => {
    const evidence = compileM7CurriculumEvidence(input);
    expect(evidence.accepted).toBe(true);
    expect(evidence.summary).toEqual({
      totalRows: 39,
      supportedRows: 28,
      composableRows: 11,
      missingRows: 0,
      browserAccepted: 39,
      maximumFirstPaintMs: 29,
    });
    expect(evidence.contactSheetsInspected).toBe(true);
  });

  it('rejects altered browser or raster evidence', () => {
    expect(() => compileM7CurriculumEvidence({
      ...input,
      resultRawJson: resultRawJson.replace('"browserAccepted": 39', '"browserAccepted": 38'),
    })).toThrow(/hash/i);
    expect(() => compileM7CurriculumEvidence({
      ...input,
      screenshots: { ...input.screenshots, 'sat-boxplots': Buffer.from('tampered') },
    })).toThrow(/raster/i);
  });
});
