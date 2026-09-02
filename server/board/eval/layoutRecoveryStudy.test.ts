import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileLiveLayoutRecoveryEvidence } from './layoutRecoveryEvidence.js';
import {
  buildLayoutFailureCohort,
  compileLayoutFailureFeedbackEvidence,
  F9_LAYOUT_RECOVERY_POLICY,
  layoutRecoveryBudgetPlan,
  runStagedRecoveryDecision,
  selectRecoveryCanaryRows,
  summarizeProxyRecovery,
} from './layoutRecoveryStudy.js';

const sourceRawJson = readFileSync(resolve('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json'), 'utf8');
const observationsRawJson = readFileSync(resolve('server/board/eval/results/2026-09-01-drawing-m1-pipeline-browser-observations.json'), 'utf8');
const feedbackRawJson = readFileSync(resolve('server/board/eval/results/2026-09-01-drawing-f9-layout-feedback.json'), 'utf8');
const liveResultRawJson = readFileSync(resolve('server/board/eval/results/2026-09-01-drawing-f9-recovery-study.json'), 'utf8');

describe('F9 targeted layout-recovery study', () => {
  it('selects exactly the 31 immutable Terra-low browser-layout failures', () => {
    const cohort = buildLayoutFailureCohort(sourceRawJson, observationsRawJson);

    expect(cohort).toHaveLength(31);
    expect(new Set(cohort.map((row) => row.sourceKey)).size).toBe(31);
    expect(cohort.every((row) => row.lowStructuredValid && !row.lowBrowserAccepted)).toBe(true);
    expect(cohort.every((row) => row.reasons.every((reason) =>
      /^(?:bounds|collision|stroke_collision|reserved|non_finite|crossings):/.test(reason)))).toBe(true);
    expect(summarizeProxyRecovery(cohort)).toEqual({
      failures: 31,
      mediumProxyRecovered: 26,
      postRecoveryDelivered: 355,
      postRecoveryValidity: 0.986111,
      minimumRecoveriesForGate: 21,
    });
  });

  it('verifies the immutable 31-row structured browser-feedback artifact', () => {
    const evidence = compileLayoutFailureFeedbackEvidence(
      sourceRawJson,
      observationsRawJson,
      feedbackRawJson,
    );

    expect(evidence.feedbackSha256).toBe(F9_LAYOUT_RECOVERY_POLICY.layoutFeedbackSha256);
    expect(evidence.artifact.rows).toHaveLength(31);
    expect(evidence.artifact.rows.every((row) => row.layoutIssues.every((issue) =>
      issue.itemBounds && (!issue.withItemId || issue.withItemBounds)))).toBe(true);
    expect(() => compileLayoutFailureFeedbackEvidence(
      sourceRawJson,
      observationsRawJson,
      feedbackRawJson.replace('"failureRows": 31', '"failureRows": 30'),
    )).toThrow(/SHA-256/i);
  });

  it('reconstructs the authorized live decision and spend ledger from the pinned result', () => {
    const evidence = compileLiveLayoutRecoveryEvidence(liveResultRawJson);

    expect(evidence).toMatchObject({
      resultSha256: '54201d05481fa871abe1708c644a6f009183908a463ee1da5dc97f38e21d76ed',
      providerCalls: 53,
      accountedCostUsd: 0.2692976,
      headroomUsd: 2.9807024,
      winner: 'medium_escalation',
      medium: {
        recovered: 21,
        delivered: 350,
        deliveredValidity: 0.972222,
        gradedRows: 14,
        meanGrade: 3.9643,
        qualifies: true,
      },
    });
    expect(() => compileLiveLayoutRecoveryEvidence(
      liveResultRawJson.replace('"providerCalls": 53', '"providerCalls": 54'),
    )).toThrow(/SHA-256/i);
  });

  it('fits the complete paired arm design below the five-dollar ceiling before launch', () => {
    const plan = layoutRecoveryBudgetPlan({ failureCount: 31, gradeRecoverySample: true });

    expect(plan.canary).toMatchObject({ intents: 3, maximumProviderCalls: 4 });
    expect(plan.full.maximumCompositionCalls).toBe(62);
    expect(plan.full.maximumJudgeCalls).toBe(28);
    expect(plan.full.maximumProviderCalls).toBe(90);
    expect(plan.conservativeTotalUsd).toBeLessThanOrEqual(5);
    expect(plan.chainDerivedFromPairedArms).toBe(true);
  });

  it('proves all three live paths with a four-call canary before scale', async () => {
    const rows = buildLayoutFailureCohort(sourceRawJson, observationsRawJson);
    const canaryRows = selectRecoveryCanaryRows(rows);
    expect(new Set(canaryRows.map((row) => row.intentId)).size).toBe(3);
    const calls: string[] = [];
    const result = await runStagedRecoveryDecision({
      rows,
      stopAfterCanary: true,
      runMedium: async (row) => {
        calls.push(`medium:${row.sourceKey}`);
        return { valid: true, value: `medium:${row.sourceKey}` };
      },
      runCorrection: async (row) => {
        calls.push(`correction:${row.sourceKey}`);
        return { valid: row !== canaryRows[2], value: `correction:${row.sourceKey}` };
      },
      grade: async () => ({ valid: true, grade: 4 }),
    });

    expect(calls).toEqual([
      `medium:${canaryRows[0].sourceKey}`,
      `correction:${canaryRows[1].sourceKey}`,
      `correction:${canaryRows[2].sourceKey}`,
      `medium:${canaryRows[2].sourceKey}`,
    ]);
    expect(result).toMatchObject({
      stage: 'canary',
      canary: { passed: true, providerCalls: 4, sourceKeys: canaryRows.map((row) => row.sourceKey) },
    });
  });

  it('early-stops once the cheapest arm has enough graded recoveries', async () => {
    const rows = buildLayoutFailureCohort(sourceRawJson, observationsRawJson);
    const result = await runStagedRecoveryDecision({
      rows,
      runMedium: async (row) => ({ valid: true, value: `medium:${row.sourceKey}` }),
      runCorrection: async (row) => ({ valid: true, value: `correction:${row.sourceKey}` }),
      grade: async () => ({ valid: true, grade: 4 }),
    });

    expect(result.stage).toBe('complete');
    expect(result.winner).toBe('targeted_correction');
    expect(result.summaries.targeted_correction).toMatchObject({ recovered: 21, delivered: 350, qualifies: true });
    expect(result.attempts.targeted_correction).toBe(21);
    expect(result.attempts.medium_escalation).toBeLessThanOrEqual(21);
  });
});
