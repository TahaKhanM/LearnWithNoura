import { describe, expect, it } from 'vitest';
import { PALETTE, type AddOp } from '../../shared/boardOps.js';
import type { LayoutIssue } from '../../shared/layoutFeedback.js';
import type { DirectorSceneRequest } from './director.js';
import { correctLayoutOnce, type LayoutCorrectionPort } from './layoutCorrection.js';

const prior: AddOp = {
  op: 'add', id: 'fixed', color: 'blue',
  spec: { kind: 'box', at: [500, 240], w: 220, h: 100, text: 'Fixed meaning' },
};
const rejected: AddOp = {
  op: 'add', id: 'move-me', color: 'red',
  spec: { kind: 'box', at: [505, 245], w: 220, h: 100, text: 'Preserve this meaning' },
};
const issue: LayoutIssue = {
  code: 'collision',
  itemId: 'move-me',
  withItemId: 'fixed',
  itemBounds: { x: 395, y: 195, w: 220, h: 100 },
  withItemBounds: { x: 390, y: 190, w: 220, h: 100 },
};

describe('targeted layout correction', () => {
  it('applies one streamed placement patch without changing semantic content', async () => {
    const port = correctionPort(['{"placements":[', '{"id":"move-me","dx":0,"dy":180,"side":null}', ']}']);
    const result = await correctLayoutOnce(port, {
      request: sceneRequest(),
      priorOps: [prior],
      rejectedOps: [rejected],
      layoutIssues: [issue],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      ok: true,
      ops: [{
        ...rejected,
        color: PALETTE.red,
        spec: { ...rejected.spec, at: [505, 425] },
      }],
    });
  });

  it('rejects patches outside the offending step and schema', async () => {
    const wrongId = await correctLayoutOnce(correctionPort([
      '{"placements":[{"id":"fixed","dx":0,"dy":180,"side":null}]}',
    ]), {
      request: sceneRequest(), priorOps: [prior], rejectedOps: [rejected],
      layoutIssues: [issue], signal: new AbortController().signal,
    });
    expect(wrongId).toMatchObject({ ok: false, code: 'invalid_patch' });

    const semanticRewrite = await correctLayoutOnce(correctionPort([
      '{"placements":[{"id":"move-me","dx":0,"dy":180,"side":null,"text":"changed"}]}',
    ]), {
      request: sceneRequest(), priorOps: [prior], rejectedOps: [rejected],
      layoutIssues: [issue], signal: new AbortController().signal,
    });
    expect(semanticRewrite).toMatchObject({ ok: false, code: 'invalid_patch' });
  });
});

function correctionPort(chunks: string[]): LayoutCorrectionPort {
  return {
    async *streamPlacements() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function sceneRequest(): DirectorSceneRequest {
  return {
    purpose: 'Compare two ideas', idea: 'Two boxes with distinct meanings', constraints: null,
    density: 'minimal', targetObjectIds: [], sectionId: 'section-1', sectionLabel: 'Comparison',
    boardSummary: 'empty', visibleObjectIds: [], currentBoardOps: [],
    stageBrief: 'model', learnerContext: 'omitted',
  };
}
