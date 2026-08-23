import { z } from 'zod';
import { ResponseModeSchema } from './lessonTurn.js';

export const ResponseTaxonomySchema = z.enum([
  'correct',
  'partially_correct',
  'incorrect',
  'confident_misconception',
  'confusion',
  'missing_prerequisite',
  'irrelevant',
  'self_corrected',
  'uncertain_or_ambiguous',
  'no_meaningful_response',
]);
export type ResponseTaxonomy = z.infer<typeof ResponseTaxonomySchema>;

export const LessonStageKindSchema = z.enum(['orient', 'model', 'guided_check', 'independent_check', 'closure']);
export type LessonStageKind = z.infer<typeof LessonStageKindSchema>;

export const BoardPurposeSchema = z.enum([
  'establish_anchor', 'reveal_relation', 'demonstrate_change', 'compare_cases',
  'elicit_learner_work', 'test_prediction', 'summarize', 'none',
]);
export type BoardPurpose = z.infer<typeof BoardPurposeSchema>;

export const BoardMutationSchema = z.enum(['establish', 'extend', 'emphasize', 'compare', 'none']);
export type BoardMutation = z.infer<typeof BoardMutationSchema>;

/**
 * One durable plan for one small lesson goal. It is the coherence boundary:
 * adaptation changes the route through these stages, never the objective on
 * every turn. Three to five stages; structure, not a scripted lecture.
 */
export const LessonBlueprintSchema = z.object({
  blueprintId: z.string().min(1).max(120),
  goal: z.string().min(1).max(300),
  mode: z.enum(['board_led', 'conversation_led']),
  successCriteria: z.array(z.string().min(1).max(240)).min(1).max(4),
  anchor: z.object({
    semanticGroupId: z.string().min(1).max(160),
    template: z.string().min(1).max(80),
    instructionalQuestion: z.string().min(1).max(300),
    invariantObjectIds: z.array(z.string().min(1).max(160)).max(24).default([]),
  }).nullable(),
  stages: z.array(z.object({
    id: z.string().min(1).max(80),
    kind: LessonStageKindSchema,
    objective: z.string().min(1).max(240),
    boardPurpose: BoardPurposeSchema,
    allowedBoardMutation: BoardMutationSchema,
    learnerOpportunity: z.string().min(1).max(300),
    evidenceExpected: z.string().min(1).max(240),
  })).min(3).max(5),
  currentStageIndex: z.number().int().nonnegative().default(0),
  detourStack: z.array(z.object({
    reason: z.string().min(1).max(240),
    returnStageIndex: z.number().int().nonnegative(),
  })).max(4).default([]),
}).superRefine((blueprint, context) => {
  if (blueprint.mode === 'board_led' && !blueprint.anchor) {
    context.addIssue({ code: 'custom', path: ['anchor'], message: 'A board-led lesson requires one anchor representation.' });
  }
  const ids = blueprint.stages.map((stage) => stage.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['stages'], message: 'Stage ids must be unique.' });
  }
  if (blueprint.mode === 'board_led' && !blueprint.stages.some((stage) => stage.allowedBoardMutation === 'establish')) {
    context.addIssue({ code: 'custom', path: ['stages'], message: 'A board-led lesson needs a stage that establishes the anchor.' });
  }
  if (blueprint.currentStageIndex >= blueprint.stages.length) {
    context.addIssue({ code: 'custom', path: ['currentStageIndex'], message: 'currentStageIndex is out of range.' });
  }
});
export type LessonBlueprint = z.infer<typeof LessonBlueprintSchema>;

export const TeachingMoveSchema = z.object({
  classification: ResponseTaxonomySchema.optional(),
  rationale: z.string().min(1).max(600),
  microObjective: z.string().min(1).max(220),
  strategy: z.string().min(1).max(220),
  visualStrategy: z.string().min(1).max(220).optional(),
  semanticObjectId: z.string().min(1).max(160).optional(),
  childFacingText: z.string().min(1).max(1200),
  questionOrTask: z.string().min(1).max(500).optional(),
  taskId: z.string().min(1).max(160).optional(),
  /** How the learner is expected to answer the questionOrTask. */
  responseMode: ResponseModeSchema.optional(),
  proposedAction: z.enum(['explain', 'visual', 'question', 'wait', 'feedback', 'practice', 'reteach', 'advance', 'complete']),
  /** Blueprint linkage: which persisted stage this move executes and why. */
  blueprintId: z.string().min(1).max(120).optional(),
  stageId: z.string().min(1).max(80).optional(),
  goalLink: z.string().min(1).max(300).optional(),
  boardPurpose: BoardPurposeSchema.optional(),
  anchorGroupId: z.string().min(1).max(160).optional(),
  targetObjectIds: z.array(z.string().min(1).max(160)).max(12).optional(),
  learnerOpportunityId: z.string().min(1).max(160).optional(),
  expectedEvidence: z.string().min(1).max(240).optional(),
  detourReason: z.string().min(1).max(240).optional(),
  returnStageId: z.string().min(1).max(80).optional(),
});
export type TeachingMove = z.infer<typeof TeachingMoveSchema>;

export interface EvidenceProjectionInput {
  evidenceId: string;
  taxonomy: ResponseTaxonomy;
  independent: boolean;
  explanationOrApplication: boolean;
  laterRetrieval: boolean;
  /** Stable identity for one learner answer/opportunity. Multiple model
   * classifications of the same answer must use the same value. */
  opportunityId?: string;
  /** Task revisited by a retrieval. Required when laterRetrieval is true. */
  retrievalOf?: string | null;
  taskId?: string;
  ts?: number;
  supersedes?: string[];
}

export type EvidenceOpportunityKind = 'recall' | 'explanation' | 'application' | 'retrieval';

export interface ConceptEvidenceHistoryInput {
  evidenceId: string;
  concept: string;
  conceptId: string;
  taxonomy: ResponseTaxonomy;
  independenceLevel: 'none' | 'reduced' | 'independent';
  opportunityKind: EvidenceOpportunityKind;
  taskId: string;
  sessionId: string;
  turnId: string;
  ts: number;
  /** Durable row/order tie-breaker when timestamps share a millisecond. */
  order?: number;
  id?: number;
  retrievalOf?: string | null;
  contradicts?: string[];
  supersedes?: string[];
}

export interface ConceptHistoryProjection {
  concept: string;
  conceptId: string;
  status: ConceptStatus;
  evidenceIds: string[];
  latestEvidenceId: string;
  hasContradiction: boolean;
  hasUnresolvedMisconception: boolean;
}

export type ConceptStatus = 'not_observed' | 'progressing' | 'uncertain' | 'demonstrated';

export function projectConceptStatus(evidence: EvidenceProjectionInput[]): ConceptStatus {
  if (evidence.length === 0) return 'not_observed';
  const synthetic = evidence.map((entry, index): ConceptEvidenceHistoryInput => ({
    evidenceId: entry.evidenceId,
    concept: 'concept',
    conceptId: 'concept',
    taxonomy: entry.taxonomy,
    independenceLevel: entry.independent ? 'independent' : 'reduced',
    opportunityKind: entry.laterRetrieval ? 'retrieval' : entry.explanationOrApplication ? 'application' : 'recall',
    taskId: entry.taskId ?? entry.opportunityId ?? `task-${index}`,
    sessionId: 'projection',
    turnId: entry.opportunityId ?? `turn-${index}`,
    ts: entry.ts ?? index,
    retrievalOf: entry.retrievalOf ?? null,
    contradicts: [],
    supersedes: entry.supersedes ?? [],
  }));
  return projectConceptHistories(synthetic)[0]?.status ?? 'not_observed';
}

/** One conservative projection used by summaries and every Parent surface. */
export function projectConceptHistories(evidence: ConceptEvidenceHistoryInput[]): ConceptHistoryProjection[] {
  const grouped = new Map<string, ConceptEvidenceHistoryInput[]>();
  const ordered = evidence.map((entry, index) => ({ entry, index })).sort((left, right) =>
    left.entry.ts - right.entry.ts ||
    (left.entry.order ?? left.entry.id ?? left.index) - (right.entry.order ?? right.entry.id ?? right.index),
  );
  for (const { entry } of ordered) {
    const key = entry.conceptId || normalizeConcept(entry.concept);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return [...grouped.entries()].map(([conceptId, history]) => {
    const latest = history[history.length - 1];
    const negativeEntries = history.filter((entry) => isNegative(entry.taxonomy));
    const positiveEntries = history.filter((entry) => isPositive(entry.taxonomy));
    const resolutionIndex = new Map<string, number>();
    for (const negative of negativeEntries) {
      const negativeIndex = history.indexOf(negative);
      const resolvingIndex = history.findIndex((candidate, candidateIndex) =>
        candidateIndex > negativeIndex &&
        candidate.independenceLevel === 'independent' &&
        candidate.taxonomy === 'correct' &&
        (candidate.supersedes ?? []).includes(negative.evidenceId),
      );
      if (resolvingIndex >= 0) resolutionIndex.set(negative.evidenceId, resolvingIndex);
    }
    const unresolvedNegative = negativeEntries.some((entry) => !resolutionIndex.has(entry.evidenceId));
    const explicitContradictions = history.filter((entry) => (entry.contradicts?.length ?? 0) > 0);
    const unresolvedExplicitContradiction = explicitContradictions.some((entry) => {
      const selfResolved = entry.taxonomy === 'correct' && entry.independenceLevel === 'independent' &&
        (entry.contradicts ?? []).every((evidenceId) => (entry.supersedes ?? []).includes(evidenceId));
      if (selfResolved) return false;
      const entryIndex = history.indexOf(entry);
      return !history.some((candidate, candidateIndex) =>
        candidateIndex > entryIndex && candidate.independenceLevel === 'independent' && candidate.taxonomy === 'correct' &&
        (candidate.supersedes ?? []).includes(entry.evidenceId),
      );
    });
    const hasUnresolvedMisconception = negativeEntries.some((entry) =>
      entry.taxonomy === 'confident_misconception' && !resolutionIndex.has(entry.evidenceId),
    );

    // A correction resolves a misconception but is not itself independent
    // confirmation. Demonstration candidates begin after the latest explicit
    // resolution, so one correction plus one later success stays Progressing.
    const latestResolution = Math.max(-1, ...resolutionIndex.values());
    const candidates = history.slice(latestResolution + 1);
    const opportunities = distinctPositiveOpportunities(candidates);
    const independent = opportunities.filter((entry) => entry.independent);
    const transfer = independent.filter((entry) => entry.explanationOrApplication);
    const hasChronologicalRetrieval = independent.some((retrieval) =>
      retrieval.laterRetrieval && Boolean(retrieval.retrievalOf) && transfer.some((source) =>
        source.taskId === retrieval.retrievalOf &&
        (source.ts < retrieval.ts || (source.ts === retrieval.ts && source.order < retrieval.order)) &&
        source.opportunityId !== retrieval.opportunityId,
      ),
    );
    let status: ConceptStatus;
    if (unresolvedNegative || unresolvedExplicitContradiction || isNegative(latest.taxonomy)) status = 'uncertain';
    else if (!isPositive(latest.taxonomy)) status = latest.taxonomy === 'partially_correct' || latest.taxonomy === 'irrelevant' ? 'progressing' : 'uncertain';
    else if (independent.length >= 2 && transfer.length > 0 && hasChronologicalRetrieval) status = 'demonstrated';
    else status = 'progressing';
    return {
      concept: latest.concept,
      conceptId,
      status,
      evidenceIds: history.map((entry) => entry.evidenceId),
      latestEvidenceId: latest.evidenceId,
      hasContradiction: (positiveEntries.length > 0 && negativeEntries.length > 0) || explicitContradictions.length > 0,
      hasUnresolvedMisconception,
    };
  });
}

interface PositiveOpportunity {
  opportunityId: string;
  taskId: string;
  ts: number;
  order: number;
  independent: boolean;
  explanationOrApplication: boolean;
  laterRetrieval: boolean;
  retrievalOf: string | null;
}

function distinctPositiveOpportunities(history: ConceptEvidenceHistoryInput[]): PositiveOpportunity[] {
  const grouped = new Map<string, ConceptEvidenceHistoryInput[]>();
  for (const entry of history) {
    const opportunityId = `${entry.sessionId}\u0000${entry.taskId}\u0000${entry.turnId}`;
    grouped.set(opportunityId, [...(grouped.get(opportunityId) ?? []), entry]);
  }
  const opportunities: PositiveOpportunity[] = [];
  for (const [opportunityId, entries] of grouped) {
    // Duplicate classifications from one answer are one opportunity. Any
    // negative classification in that answer prevents it being positive
    // unless the negative is explicitly superseded within the opportunity.
    const unresolvedWithinOpportunity = entries.some((entry) =>
      isNegative(entry.taxonomy) && !entries.some((candidate) =>
        candidate.ts >= entry.ts && candidate.taxonomy === 'correct' && (candidate.supersedes ?? []).includes(entry.evidenceId),
      ),
    );
    const positives = entries.filter((entry) => isPositive(entry.taxonomy));
    if (unresolvedWithinOpportunity || positives.length === 0) continue;
    const latest = positives[positives.length - 1];
    opportunities.push({
      opportunityId,
      taskId: latest.taskId,
      ts: Math.max(...positives.map((entry) => entry.ts)),
      order: Math.max(...positives.map((entry, index) => entry.order ?? entry.id ?? index)),
      independent: positives.some((entry) => entry.taxonomy === 'correct' && entry.independenceLevel === 'independent'),
      explanationOrApplication: positives.some((entry) => entry.opportunityKind === 'explanation' || entry.opportunityKind === 'application'),
      laterRetrieval: positives.some((entry) => entry.opportunityKind === 'retrieval'),
      retrievalOf: positives.find((entry) => entry.opportunityKind === 'retrieval')?.retrievalOf ?? null,
    });
  }
  return opportunities.sort((left, right) => left.ts - right.ts || left.order - right.order || left.opportunityId.localeCompare(right.opportunityId));
}

function isPositive(taxonomy: ResponseTaxonomy): boolean {
  return taxonomy === 'correct' || taxonomy === 'self_corrected';
}

function isNegative(taxonomy: ResponseTaxonomy): boolean {
  return taxonomy === 'incorrect' || taxonomy === 'confident_misconception' || taxonomy === 'missing_prerequisite';
}

function normalizeConcept(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unspecified';
}

export const TAXONOMY_POLICY: Record<ResponseTaxonomy, string> = {
  correct: 'Confirm specifically, then ask an explanation or transfer probe; never infer mastery from one answer.',
  partially_correct: 'Name the correct component, target the missing relation, and preserve the useful representation.',
  incorrect: 'Correct neutrally or diagnose; never add false praise.',
  confident_misconception: 'Elicit reasoning, contrast a counterexample, change representation, and require later independent evidence.',
  confusion: 'Reduce the step size, model one worked example, then ask a tiny check.',
  missing_prerequisite: 'Teach the minimum prerequisite and then return to the lesson goal.',
  irrelevant: 'Reconnect gently; if repeated, offer a choice or short reset.',
  self_corrected: 'Store the original and correction; treat it as positive but less independent evidence.',
  uncertain_or_ambiguous: 'Repeat what was heard and ask for confirmation; do not grade or store mastery evidence.',
  no_meaningful_response: 'Reprompt once, then offer a choice, example, or break; never invent evidence.',
};
