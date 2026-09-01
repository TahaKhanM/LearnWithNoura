import { describe, expect, it } from 'vitest';
import type { BoardOp } from '../../shared/boardOps';
import { parseDirectorStreamProposal } from '../../server/board/directorStreamSchema.js';
import { loadDirectorEvalCorpus } from '../../server/board/eval/corpus.js';
import rawReport from '../../server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json';
import { applyOps, emptyScene } from './scene';
import { sceneForGroup } from './sceneGroups';
import { inspectScene, repairSceneOnce } from './inspection';
import { layoutTutorAnnotations } from './annotationLayout';
import { BoardSceneCoordinator } from './sceneCoordinator';

const raw = rawReport as { trials: SourceTrial[] };
const corpus = new Map(loadDirectorEvalCorpus().map((intent) => [intent.id, intent]));

describe('bounded tutor-layout convergence', () => {
  it.each([
    'grammar-main-subordinate',
    'abstract-recursion',
    'compare-budget',
    'math-fraction-strip-holdout',
  ])('resolves repair-induced annotation dependencies for %s', (intentId) => {
    const { proposal, existingOps } = failingProposal(intentId);
    const board = new BoardSceneCoordinator();
    if (existingOps.length > 0) board.applyReplay(existingOps, 'tutor', 'existing');
    expect(board.preflightTutorOps(proposal.ops as BoardOp[], 'candidate')).toEqual({ accepted: true, reasons: [] });
  });

  it('never rescues semantic graph points by translating them into canvas bounds', () => {
    const { proposal, existingOps } = failingProposal('graph-linear');
    const board = new BoardSceneCoordinator();
    if (existingOps.length > 0) board.applyReplay(existingOps, 'tutor', 'existing');
    expect(board.preflightTutorOps(proposal.ops as BoardOp[], 'candidate')).toEqual({
      accepted: false,
      reasons: expect.arrayContaining([expect.stringMatching(/^bounds:pt/)]),
    });
  });

  it('keeps an already accepted scene structurally identical to the original one-repair path', () => {
    const trial = sourceTrial('math-number-line', (candidate) => candidate.validatorPassed);
    const intent = corpus.get(trial.intentId)!;
    const proposal = parseDirectorStreamProposal(trial.proposalText, intent.density);
    const applied = applyOps(emptyScene, proposal.ops as BoardOp[], 'tutor', 'candidate', { tier: 'authored' });
    let baseline = layoutTutorAnnotations(sceneForGroup(applied.scene, 'candidate'));
    const inspection = inspectScene(baseline);
    if (!inspection.accepted) baseline = repairSceneOnce(baseline, inspection);

    const board = new BoardSceneCoordinator();
    const accepted = board.applyTutorCheckpoint(proposal.ops as BoardOp[], 'candidate');
    expect(accepted).not.toBeNull();
    expect(sceneForGroup(accepted!.scene, 'candidate').items).toEqual(baseline.items);
  });
});

interface SourceTrial {
  intentId: string;
  conditionId: string;
  strictSchemaValid: boolean;
  validatorPassed: boolean;
  storyboardCoverage: boolean;
  proposalText: string;
}

function sourceTrial(intentId: string, predicate: (trial: SourceTrial) => boolean): SourceTrial {
  const trial = raw.trials.find((candidate) =>
    candidate.conditionId === 'terra-low' && candidate.intentId === intentId && predicate(candidate));
  if (!trial) throw new Error(`Missing pinned Terra-low trial for ${intentId}.`);
  return trial;
}

function failingProposal(intentId: string) {
  const trial = sourceTrial(intentId, (candidate) =>
    candidate.strictSchemaValid && !candidate.validatorPassed && candidate.storyboardCoverage);
  const intent = corpus.get(intentId);
  if (!intent) throw new Error(`Unknown corpus intent ${intentId}.`);
  return {
    proposal: parseDirectorStreamProposal(trial.proposalText, intent.density),
    existingOps: (intent.existingBoardOps ?? []) as BoardOp[],
  };
}
