import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileM1PipelineStudyEvidence } from './m1PipelineStudyEvidence.js';
import {
  M1BrowserObservationArtifactSchema,
  M1_PIPELINE_STUDY_POLICY,
  M1PipelineStudyReportSchema,
  summarizeM1PipelineStudyRows,
} from './m1PipelineStudy.js';

const sourceRawJson = read('server/board/eval/results/2026-08-31-drawing-model-bakeoff-raw.json');
const observationRawJson = read(M1_PIPELINE_STUDY_POLICY.browserObservationPath);
const resultRawJson = read('server/board/eval/results/2026-09-01-drawing-m1-pipeline-study.json');

describe('M1 zero-provider paired delivery-path A/B evidence', () => {
  it('verifies the separately pinned browser ledger and deterministic report', () => {
    const evidence = compileM1PipelineStudyEvidence(
      sourceRawJson, observationRawJson, resultRawJson,
    );

    expect(evidence).toMatchObject({
      sourceSha256: 'e02ccc9f240f72a7937fe192f30867434eb7f857fb6c45a5f8b52fa06507ae79',
      browserObservationSha256: 'a8847373ff3a9d3aa8bdd1c34fa5f4dcb99e4bc617ce23459ccdebd67767017a',
      report: {
        pass: false,
        studyKind: 'paired_delivery_path_same_proposal',
        generatorModelComparison: false,
        providerCalls: 0,
        runtimeCostUsd: 0,
        summary: {
          all: { rows: 360, atomicAccepted: 329, candidateAccepted: 329 },
          diagrams: {
            rows: 320,
            atomicAccepted: 290,
            candidateAccepted: 290,
            validityDropPercentagePoints: 0,
          },
          readiness: {
            rows: 290,
            p50StreamedFirstValidatedStepReadyMs: 2_655,
            p50AtomicProposalCompleteMs: 4_708,
            providerCriticalPathReadinessCut: 0.436066,
          },
          diagramValidityWithinTolerance: true,
          absoluteFirstPassValidityGateMet: false,
          providerCriticalPathReadinessCutMet: true,
          deliveryPathStudyPass: true,
          m1AcceptancePass: false,
        },
      },
    });
  });

  it('records every raw browser verdict, render hash, and isolation fact', () => {
    const observations = M1BrowserObservationArtifactSchema.parse(JSON.parse(observationRawJson));
    expect(observations.rows).toHaveLength(360);
    expect(new Set(observations.rows.map((row) => row.sourceKey)).size).toBe(360);
    expect(observations.browserHarness).toEqual({
      origin: 'http://localhost:5180',
      path: '/dev/board',
      finalOrigin: 'http://localhost:5180',
      finalPath: '/dev/board',
      engine: 'chromium',
      externalRequestCount: 0,
      fullScenePreflights: 360,
      cumulativePreflights: 847,
      rasterRenders: 720,
    });
    expect(observations.rows.filter((row) => row.route === 'streaming_diagram')
      .reduce((total, row) => total + row.streamed.cumulativeVerdicts.length, 0)).toBe(847);
    expect(observations.rows.every((row) =>
      row.atomic.opsSha256 === row.streamed.opsSha256 &&
      row.atomic.rasterSha256 === row.streamed.rasterSha256)).toBe(true);
  });

  it('requires non-attriting parity-backed reuse of all 24 source quality rows', () => {
    const report = resultObject();
    expect(report.summary.quality).toEqual({
      expectedSourceRows: 24,
      sourceRows: 24,
      reusedRows: 24,
      atomicMeanGrade: 3.7292,
      candidateMeanGrade: 3.7292,
      absoluteGradeDelta: 0,
      completeNonAttritingReuse: true,
    });
    const qualityRows = report.rows.filter((row) => row.sourceQualityEvidenceComplete);
    expect(qualityRows).toHaveLength(24);
    expect(qualityRows.every((row) =>
      row.qualityEvidenceReused && row.exactOpsParity && row.exactRasterParity)).toBe(true);

    const attrited = report.rows.map((row) => ({ ...row }));
    const firstQuality = attrited.find((row) => row.sourceQualityEvidenceComplete);
    if (!firstQuality) throw new Error('Fixture unexpectedly has no quality evidence.');
    firstQuality.qualityEvidenceReused = false;
    const summary = summarizeM1PipelineStudyRows(attrited);
    expect(summary.quality).toMatchObject({ reusedRows: 23, completeNonAttritingReuse: false });
    expect(summary.qualityWithinTolerance).toBe(false);
    expect(summary.deliveryPathStudyPass).toBe(false);
  });

  it('applies the five-point non-inferiority rule to diagrams, not illustrations', () => {
    const report = resultObject();
    const illustrationFailures = report.rows.map((row) => ({
      ...row,
      candidateAccepted: row.route === 'classic_illustration' ? false : row.candidateAccepted,
    }));
    const supplemental = summarizeM1PipelineStudyRows(illustrationFailures);
    expect(supplemental.all.validityDropPercentagePoints).toBeGreaterThan(5);
    expect(supplemental.diagrams.validityDropPercentagePoints).toBe(0);
    expect(supplemental.diagramValidityWithinTolerance).toBe(true);
    expect(supplemental.deliveryPathStudyPass).toBe(true);

    const diagramFailures = report.rows.map((row) => ({ ...row }));
    for (const row of diagramFailures
      .filter((row) => row.route === 'streaming_diagram' && row.candidateAccepted)
      .slice(0, 17)) row.candidateAccepted = false;
    const failed = summarizeM1PipelineStudyRows(diagramFailures);
    expect(failed.diagrams.validityDropPercentagePoints).toBeGreaterThan(5);
    expect(failed.diagramValidityWithinTolerance).toBe(false);
    expect(failed.selectedRevealPolicy).toBe('reveal_after_2_steps_requires_readiness_evidence');
  });

  it('labels readiness conservatively and leaves actual UI first paint unclaimed', () => {
    const report = resultObject();
    expect(report.evidenceBoundary).toMatch(/provider-critical-path readiness only/i);
    expect(report.evidenceBoundary).toMatch(/does not prove ops_presented UI first paint/i);
    expect(report.summary.actualUiFirstPaintAcceptance)
      .toBe('requires_separate_ops_presented_evidence');
    expect('latency' in report.summary).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('rejects source, raw-observation, and result-only fabrication attacks', () => {
    const modifiedSource = sourceRawJson.replace('"schemaVersion"', '"schemaVersioN"');
    expect(() => compileM1PipelineStudyEvidence(
      modifiedSource, observationRawJson, resultRawJson,
    )).toThrow(/source SHA-256/i);

    const modifiedObservation = observationRawJson.replace('"accepted": true', '"accepted": false');
    expect(() => compileM1PipelineStudyEvidence(
      sourceRawJson, modifiedObservation, resultRawJson,
    )).toThrow(/browser-observation SHA-256/i);

    const fabricatedResult = resultObject();
    fabricatedResult.pass = true;
    expect(() => compileM1PipelineStudyEvidence(
      sourceRawJson, observationRawJson, JSON.stringify(fabricatedResult),
    )).toThrow(/does not reproduce/i);

    const fabricatedRow = resultObject();
    fabricatedRow.rows[0].candidateAccepted = !fabricatedRow.rows[0].candidateAccepted;
    fabricatedRow.summary = summarizeM1PipelineStudyRows(fabricatedRow.rows);
    fabricatedRow.pass = fabricatedRow.summary.m1AcceptancePass;
    expect(() => compileM1PipelineStudyEvidence(
      sourceRawJson, observationRawJson, JSON.stringify(fabricatedRow),
    )).toThrow(/does not reproduce/i);
  });

  it('contains no model SDK/env/live flag and pins local network isolation', () => {
    const implementation = [
      read('server/board/eval/m1PipelineStudy.ts'),
      read('server/board/eval/m1PipelineStudyEvidence.ts'),
      read('server/board/eval/m1PipelineStudyTypes.ts'),
      read('scripts/evaluate-director-m1.ts'),
    ].join('\n');
    expect(implementation).not.toMatch(/from ['"]openai['"]/i);
    expect(implementation).not.toMatch(/process\.env|OPENAI_API_KEY|authorized-live-run|max-spend-usd/);
    expect(implementation).toMatch(/context\.route\('/);
    expect(implementation).toMatch(/routeWebSocket/);
    expect(implementation).toMatch(/route\.abort\('blockedbyclient'\)/);
    expect(implementation).toMatch(/final\.origin !== target\.origin/);
    expect(M1_PIPELINE_STUDY_POLICY).toMatchObject({
      studyKind: 'paired_delivery_path_same_proposal',
      expectedSourceQualityEvidenceCompleteRows: 24,
      maximumDiagramValidityDropPercentagePoints: 5,
      minimumAbsoluteFirstPassValidity: 0.95,
      minimumProviderCriticalPathReadinessCut: 0.4,
    });
  });
});

function resultObject() {
  return M1PipelineStudyReportSchema.parse(JSON.parse(resultRawJson));
}
function read(path: string): string { return readFileSync(resolve(path), 'utf8'); }
