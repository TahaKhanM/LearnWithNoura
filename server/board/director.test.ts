import { describe, expect, it } from 'vitest';
import { PALETTE } from '../../shared/boardOps';
import type { SceneValidationResult } from '../lesson/compiler';
import {
  directVisual,
  type BoardDirectorDeps,
  type DirectorMessage,
  type DirectorSceneRequest,
} from './director';

/**
 * Director pipeline behavior with scripted model doubles: no live provider
 * call is ever made. The render/validation doubles stand in for the real
 * headless-Chromium pipeline, which is proven separately by the compiled-
 * scenes Playwright suite.
 */

const CANDIDATE_IMAGE = 'data:image/jpeg;base64,candidate';
const BOARD_IMAGE = 'data:image/jpeg;base64,board';

function validProposal(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    groupLabel: 'Fraction bars',
    ops: [
      { op: 'add', id: 'bar-whole', color: 'blue', spec: { kind: 'box', at: [500, 200], w: 400, h: 90, text: 'One whole' } },
      { op: 'add', id: 'bar-label', color: 'green', spec: { kind: 'label', target: 'bar-whole', side: 'below', text: 'the same whole' } },
    ],
    storyboard: [
      { id: 'step-outline', reveal: 'outline', narration: 'Here is one whole bar.', objectIds: ['bar-whole'] },
      { id: 'step-label', reveal: 'label', narration: 'This name reminds us both fractions share it.', objectIds: ['bar-label'] },
    ],
    ...overrides,
  });
}

const approval = JSON.stringify({ approved: true, issues: [] });

interface ScriptedCall { messages: DirectorMessage[] }

function scriptedClient(replies: Array<string | null>) {
  const calls: ScriptedCall[] = [];
  return {
    calls,
    client: {
      complete: async ({ messages }: { messages: DirectorMessage[] }) => {
        calls.push({ messages });
        if (calls.length > replies.length) throw new Error('The scripted double ran out of replies.');
        return replies[calls.length - 1];
      },
    },
  };
}

function userText(call: ScriptedCall): string {
  return call.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

function userImages(call: ScriptedCall): string[] {
  return call.messages
    .flatMap((message) => message.content)
    .flatMap((part) => (part.type === 'image' ? [part.dataUrl] : []));
}

function request(overrides: Partial<DirectorSceneRequest> = {}): DirectorSceneRequest {
  return {
    purpose: 'Show the fractions as bars because the number line confused the learner',
    idea: 'Two fraction bars of the same whole, so 2/3 visibly exceeds 3/5',
    constraints: null,
    density: 'standard',
    targetObjectIds: [],
    sectionId: 'lesson-anchor-alt1',
    sectionLabel: 'Fraction bars',
    boardSummary: 'Visible objects now:\nanchor-scale: number line 0..1',
    visibleObjectIds: ['anchor-scale'],
    currentBoardOps: [
      { op: 'add', id: 'anchor-scale', spec: { kind: 'numberline', at: [130, 300], w: 740, min: 0, max: 1 } },
    ],
    stageBrief: 'model — place both fractions on a shared representation',
    learnerContext: 'Learner: Maya, age 10',
    ...overrides,
  };
}

function deps(
  client: { complete: (request: { messages: DirectorMessage[] }) => Promise<string | null> },
  overrides: Partial<BoardDirectorDeps> = {},
): BoardDirectorDeps & { validations: Array<unknown> ; renders: Array<unknown> } {
  const validations: Array<unknown> = [];
  const renders: Array<unknown> = [];
  return {
    client,
    validateScene: async (ops) => {
      validations.push(ops);
      return { ok: true };
    },
    renderScene: async (ops, groupId) => {
      renders.push({ ops, groupId });
      return groupId ? CANDIDATE_IMAGE : BOARD_IMAGE;
    },
    validations,
    renders,
    ...overrides,
  };
}

describe('the Board Director pipeline', () => {
  it('accepts a valid proposal on the first try after render and vision checks', async () => {
    const scripted = scriptedClient([validProposal(), approval]);
    const directorDeps = deps(scripted.client);
    const result = await directVisual(directorDeps, request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.groupId).toBe('lesson-anchor-alt1');
    expect(result.scene.template).toBeNull();
    expect(result.scene.storyboard.map((step) => step.id)).toEqual(['step-outline', 'step-label']);
    // Ops passed through the shared validator: colors normalize to markers.
    expect(result.scene.ops[0]).toMatchObject({ op: 'add', id: 'bar-whole', color: PALETTE.blue });

    // One proposal pass, one vision pass; the current board and the
    // candidate were both rendered through the real pipeline.
    expect(scripted.calls).toHaveLength(2);
    expect(userImages(scripted.calls[0])).toEqual([BOARD_IMAGE]);
    expect(userImages(scripted.calls[1])).toEqual([CANDIDATE_IMAGE]);
    expect(userText(scripted.calls[0])).toContain('Ids already taken (never reuse): anchor-scale');
    expect(directorDeps.validations).toHaveLength(1);
  });

  it('feeds deterministic render-pipeline rejections back and accepts the corrected scene', async () => {
    const scripted = scriptedClient([validProposal(), validProposal(), approval]);
    let validations = 0;
    const directorDeps = deps(scripted.client, {
      validateScene: async (): Promise<SceneValidationResult> => {
        validations += 1;
        return validations === 1 ? { ok: false, issues: ['text overlaps the bar outline'] } : { ok: true };
      },
    });
    const result = await directVisual(directorDeps, request());

    expect(result.ok).toBe(true);
    expect(validations).toBe(2);
    expect(userText(scripted.calls[1])).toContain('Deterministic layout validation rejected the scene: text overlaps the bar outline');
  });

  it('feeds vision-pass rejections back and accepts the corrected scene', async () => {
    const scripted = scriptedClient([
      validProposal(),
      JSON.stringify({ approved: false, issues: ['the label sits outside the board'] }),
      validProposal(),
      approval,
    ]);
    const result = await directVisual(deps(scripted.client), request());

    expect(result.ok).toBe(true);
    expect(scripted.calls).toHaveLength(4);
    expect(userText(scripted.calls[2])).toContain('Rendered inspection found: the label sits outside the board');
  });

  it('fails closed with reasons after persistent invalid proposals', async () => {
    const scripted = scriptedClient(['not json at all', 'still not json', '{}']);
    const result = await directVisual(deps(scripted.client), request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.length).toBeGreaterThan(0);
    // Three proposal rounds (initial + two corrections), no vision calls.
    expect(scripted.calls).toHaveLength(3);
  });

  it('strips permanence violations and keeps the additive scene', async () => {
    const scripted = scriptedClient([
      validProposal({
        ops: [
          { op: 'clear' },
          { op: 'erase', id: 'anchor-scale' },
          { op: 'add', id: 'bar-whole', spec: { kind: 'box', at: [500, 200], w: 400, h: 90, text: 'One whole' } },
          { op: 'add', id: 'bar-label', spec: { kind: 'label', target: 'bar-whole', side: 'below', text: 'the same whole' } },
        ],
      }),
      approval,
    ]);
    const result = await directVisual(deps(scripted.client), request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.ops.map((op) => op.op)).toEqual(['add', 'add']);
    expect(result.scene.ops.map((op) => (op.op === 'add' ? op.id : ''))).toEqual(['bar-whole', 'bar-label']);
  });

  it('rejects a storyboard that relied on a stripped destructive operation', async () => {
    const scripted = scriptedClient([
      validProposal({
        ops: [
          { op: 'erase', id: 'bar-label' },
          { op: 'add', id: 'bar-whole', spec: { kind: 'box', at: [500, 200], w: 400, h: 90, text: 'One whole' } },
        ],
      }),
      validProposal(),
      approval,
    ]);
    const result = await directVisual(deps(scripted.client), request());

    expect(result.ok).toBe(true);
    expect(userText(scripted.calls[1])).toContain('Storyboard references bar-label');
  });

  it('enforces the density budget with corrective feedback', async () => {
    const crowdedOps = Array.from({ length: 15 }, (_, index) => ({
      op: 'add',
      id: `crowd-${index}`,
      spec: { kind: 'box', at: [120 + (index % 5) * 180, 120 + Math.floor(index / 5) * 160], text: `Idea ${index}` },
    }));
    const crowdedStoryboard = [{
      id: 'step-crowd', reveal: 'outline', narration: 'Too many boxes at once.',
      objectIds: crowdedOps.map((op) => op.id),
    }];
    const scripted = scriptedClient([
      validProposal({ ops: crowdedOps, storyboard: crowdedStoryboard }),
      validProposal(),
      approval,
    ]);
    const result = await directVisual(deps(scripted.client), request({ density: 'minimal' }));

    expect(result.ok).toBe(true);
    expect(userText(scripted.calls[1])).toContain('minimal density budget is 14');
  });

  it('rejects id collisions with visible board objects', async () => {
    const scripted = scriptedClient([
      validProposal({
        ops: [
          { op: 'add', id: 'anchor-scale', spec: { kind: 'box', at: [500, 200], text: 'collides' } },
          { op: 'add', id: 'bar-label', spec: { kind: 'label', target: 'anchor-scale', text: 'label' } },
        ],
        storyboard: [
          { id: 'step-1', reveal: 'outline', narration: 'A colliding box.', objectIds: ['anchor-scale'] },
          { id: 'step-2', reveal: 'label', narration: 'Its label.', objectIds: ['bar-label'] },
        ],
      }),
      validProposal(),
      approval,
    ]);
    const result = await directVisual(deps(scripted.client), request());

    expect(result.ok).toBe(true);
    expect(userText(scripted.calls[1])).toContain('collide with objects already on the board: anchor-scale');
  });

  it('fails closed when the candidate cannot be rendered for inspection', async () => {
    const scripted = scriptedClient([validProposal(), validProposal(), validProposal()]);
    const result = await directVisual(deps(scripted.client, {
      renderScene: async (_ops, groupId) => (groupId ? null : BOARD_IMAGE),
    }), request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual(['The candidate scene could not be rendered for inspection.']);
  });

  it('omits the board snapshot for an empty board and treats junk vision replies as rejections', async () => {
    const scripted = scriptedClient([validProposal(), 'not json', validProposal(), approval]);
    const result = await directVisual(deps(scripted.client), request({
      currentBoardOps: [],
      boardSummary: 'The board is empty.',
      visibleObjectIds: [],
    }));

    expect(result.ok).toBe(true);
    expect(userImages(scripted.calls[0])).toEqual([]);
    expect(userText(scripted.calls[2])).toContain('The vision inspection reply was invalid');
  });

  it('places a generated illustration under exact overlay BoardOps and never trusts the image for labels', async () => {
    const scripted = scriptedClient([
      validProposal({
        representation: 'illustration',
        illustration: {
          purpose: 'Show a pond habitat',
          subject: 'A calm pond with a frog and reeds',
          requiredElements: ['frog'],
          forbiddenElements: ['text'],
        },
        ops: [
          { op: 'add', id: 'frog-label', spec: { kind: 'text', at: [200, 540], text: 'frog' } },
          { op: 'add', id: 'eq', spec: { kind: 'equation', at: [700, 540], latex: 'living+nonliving' } },
        ],
        storyboard: [
          { id: 'step-label', reveal: 'label', narration: 'The frog lives at the edge of the pond.', objectIds: ['frog-label', 'eq'] },
        ],
      }),
      approval,
    ]);
    const prepared = {
      ok: true as const,
      spec: {
        kind: 'image' as const,
        assetId: 'img-a1b2c3d4e5f67890',
        at: [80, 60] as [number, number],
        w: 840,
        h: 420,
        alt: 'A pond habitat',
      },
      objectId: 'illust-pond',
      cacheHit: false,
      latencyMs: 12,
      imageCount: 1,
      totalTokens: 40,
    };
    const result = await directVisual(deps(scripted.client, {
      illustrations: {
        enabled: true,
        prepare: async () => prepared,
      },
    }), request({ purpose: 'Show a pond habitat', idea: 'A frog lives among the reeds' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.ops[0]).toMatchObject({ op: 'add', id: 'illust-pond', spec: { kind: 'image', assetId: 'img-a1b2c3d4e5f67890' } });
    expect(result.scene.ops.map((op) => op.op === 'add' ? op.spec.kind : '')).toEqual(['image', 'text', 'equation']);
    expect(JSON.stringify(result.scene.ops)).not.toContain('data:image');
    expect(result.scene.storyboard[0].objectIds[0]).toBe('illust-pond');
    expect(result.illustration).toMatchObject({ ok: true, cacheHit: false, imageCount: 1 });
  });

  it('does not request an illustration when the feature is off', async () => {
    const scripted = scriptedClient([
      validProposal({
        representation: 'illustration',
        illustration: { purpose: 'Show a frog', subject: 'A frog', requiredElements: [], forbiddenElements: [] },
      }),
      validProposal(),
      approval,
    ]);
    let prepareCalls = 0;
    const result = await directVisual(deps(scripted.client, {
      illustrations: {
        enabled: false,
        prepare: async () => {
          prepareCalls += 1;
          throw new Error('prepare must not run when illustrations are off');
        },
      },
    }), request());
    expect(result.ok).toBe(true);
    expect(prepareCalls).toBe(0);
    expect(userText(scripted.calls[1])).toContain('Illustrations are not available');
  });
});
