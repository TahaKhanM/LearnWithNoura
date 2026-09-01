import { describe, expect, it } from 'vitest';
import {
  IncrementalDirectorStreamParser,
  parseDirectorTextStream,
} from './directorStreamParser.js';

describe('production Director stream parser', () => {
  it('emits a complete policy-ready first step before the proposal finishes', () => {
    const proposal = scene([step('s1', 'a'), step('s2', 'b')]);
    const text = JSON.stringify(proposal);
    const secondStep = text.indexOf(JSON.stringify(proposal.steps[1]));
    const parser = new IncrementalDirectorStreamParser({ density: 'minimal', visibleObjectIds: [] });
    const first = parser.push(text.slice(0, secondStep + 20));

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      index: 0,
      header: { template: null, groupLabel: 'Streamed scene' },
      step: { id: 's1' },
      ops: [{ op: 'add', id: 'a' }],
    });
    expect(parser.push(text.slice(secondStep + 20))).toHaveLength(1);
    expect(parser.finish()).toMatchObject({
      groupLabel: 'Streamed scene',
      storyboard: [{ id: 's1' }, { id: 's2' }],
    });
  });

  it('rejects cross-step id collisions before emitting the later step', () => {
    const text = JSON.stringify(scene([step('s1', 'same'), step('s2', 'same')]));
    const parser = new IncrementalDirectorStreamParser({ density: 'minimal', visibleObjectIds: [] });
    expect(() => parser.push(text)).toThrow(/collide/i);
    expect(parser.snapshot()).toMatchObject({ emittedSteps: 1 });
  });

  it('aborts before exposing a step after the visual request epoch changes', async () => {
    const controller = new AbortController();
    controller.abort('new visual request');
    const stream = parseDirectorTextStream({
      chunks: chunks(JSON.stringify(scene([step('s1', 'a')]))),
      density: 'minimal',
      visibleObjectIds: [],
      signal: controller.signal,
    });
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function scene(steps: unknown[]) {
  return {
    template: null,
    groupLabel: 'Streamed scene',
    representation: 'diagram',
    illustration: null,
    steps,
  };
}

function step(id: string, objectId: string) {
  return {
    id,
    reveal: 'outline',
    narration: `Explain ${id}.`,
    ops: [{
      op: 'add', id: objectId, color: 'blue',
      spec: { kind: 'box', at: [500, 300], w: 240, h: 100, text: id },
    }],
  };
}

async function* chunks(value: string): AsyncGenerator<string> {
  yield value;
}
