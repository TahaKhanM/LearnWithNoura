import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { materializeSketchCorpus } from './corpus.js';
import { SKETCH_INTERPRETATIONS } from './types.js';
import {
  SYNTHETIC_SKETCH_STROKE_WIDTH,
  interpretSketchOffline,
  parseSketchReply,
  renderSyntheticSketchSvg,
  scoreSketchCorpusOffline,
  sketchInterpretationJsonSchema,
  sketchCorpusContactSheetSvg,
  syntheticSketchOps,
} from './sketchCorpus.js';

describe('M5 rebuilt sketch corpus', () => {
  it('closes interpretations to the ten checked-in labels', () => {
    const sketches = materializeSketchCorpus();
    expect(sketches).toHaveLength(30);
    const labels = [...new Set(sketches.map((entry) => entry.expectedInterpretation))];
    expect(labels.sort()).toEqual([...SKETCH_INTERPRETATIONS].sort());
    expect(sketchInterpretationJsonSchema.enum).toEqual([...SKETCH_INTERPRETATIONS]);
    expect(parseSketchReply(JSON.stringify({ interpretation: 'straight line', confidence: 0.8 }))).toEqual({
      interpretation: 'straight line',
      confidence: 0.8,
      valid: true,
    });
    expect(parseSketchReply(JSON.stringify({ interpretation: 'a squiggle', confidence: 0.9 }))).toMatchObject({
      valid: false,
    });
  });

  it('uses the live learner-pen stroke width', () => {
    const sketch = materializeSketchCorpus()[0];
    expect(SYNTHETIC_SKETCH_STROKE_WIDTH).toBe(4);
    expect(syntheticSketchOps(sketch)).toEqual([{
      op: 'add',
      id: `synthetic-sketch-${sketch.id}`,
      color: 'ink',
      spec: { kind: 'path', points: sketch.points, width: 4 },
    }]);
  });

  it('renders a unique inspectable SVG for every jittered variant', () => {
    const sketches = materializeSketchCorpus();
    const hashes = new Set<string>();
    for (const sketch of sketches) {
      const svg = renderSyntheticSketchSvg(sketch);
      expect(svg).toContain(`data-sketch-id="${sketch.id}"`);
      expect(svg).toContain(`data-interpretation="${sketch.expectedInterpretation}"`);
      expect(svg).toContain('stroke-width="4"');
      expect(svg).toContain('<path ');
      hashes.add(createHash('sha256').update(svg).digest('hex'));
    }
    expect(hashes.size).toBe(30);
  });

  it('scores every synthetic sketch offline without a provider', () => {
    const report = scoreSketchCorpusOffline();
    expect(report.providerCalls).toBe(0);
    expect(report.itemCount).toBe(30);
    expect(report.accuracy).toBe(1);
    expect(report.cheaperModelAssistDefault).toBe('off');
    for (const row of report.rows) {
      expect(row.predicted).toBe(row.expected);
      expect(row.confidence).toBeGreaterThan(0);
    }
  });

  it('labels the ten bases on one human-inspectable contact sheet', () => {
    const sheet = sketchCorpusContactSheetSvg();
    for (const label of SKETCH_INTERPRETATIONS) {
      expect(sheet).toContain(label);
    }
    expect(sheet).toContain('stroke-width="4"');
    expect(sheet.match(/<path /g)?.length).toBe(10);
    const fixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures/sketch-corpus-contact-sheet.svg'),
      'utf8',
    );
    expect(sheet).toBe(fixture);
  });

  it('keeps the geometric reader from claiming check-grading authority', () => {
    const sketch = materializeSketchCorpus()[0];
    const reading = interpretSketchOffline(sketch.points);
    expect(SKETCH_INTERPRETATIONS).toContain(reading.interpretation);
    expect(reading.semanticClaim).toBe(false);
  });
});
