import { z } from 'zod';

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
  proposedAction: z.enum(['explain', 'visual', 'question', 'wait', 'feedback', 'practice', 'reteach', 'advance', 'complete']),
});
export type TeachingMove = z.infer<typeof TeachingMoveSchema>;

export interface EvidenceProjectionInput {
  evidenceId: string;
  taxonomy: ResponseTaxonomy;
  independent: boolean;
  explanationOrApplication: boolean;
  laterRetrieval: boolean;
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
  const unresolvedMisconception = evidence.some((item, index) =>
    item.taxonomy === 'confident_misconception' &&
    !evidence.slice(index + 1).some((later) => later.taxonomy === 'correct' && later.independent),
  );
  if (unresolvedMisconception) return 'uncertain';
  const positive = evidence.filter((item) =>
    ['correct', 'self_corrected'].includes(item.taxonomy),
  );
  const independent = positive.filter((item) => item.independent);
  const hasTransfer = positive.some((item) => item.explanationOrApplication);
  const hasRetrieval = positive.some((item) => item.laterRetrieval);
  if (independent.length >= 2 && hasTransfer && hasRetrieval) return 'demonstrated';
  const contradiction = positive.length > 0 && evidence.some((item) =>
    ['incorrect', 'confident_misconception', 'missing_prerequisite'].includes(item.taxonomy),
  );
  return contradiction ? 'uncertain' : 'progressing';
}

/** One conservative projection used by summaries and every Parent surface. */
export function projectConceptHistories(evidence: ConceptEvidenceHistoryInput[]): ConceptHistoryProjection[] {
  const grouped = new Map<string, ConceptEvidenceHistoryInput[]>();
  for (const entry of [...evidence].sort((left, right) => left.ts - right.ts || left.evidenceId.localeCompare(right.evidenceId))) {
    const key = entry.conceptId || normalizeConcept(entry.concept);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return [...grouped.entries()].map(([conceptId, history]) => {
    const projected = history.map((entry) => ({
      evidenceId: entry.evidenceId,
      taxonomy: entry.taxonomy,
      independent: entry.independenceLevel === 'independent',
      explanationOrApplication: entry.opportunityKind === 'explanation' || entry.opportunityKind === 'application',
      laterRetrieval: entry.opportunityKind === 'retrieval',
    }));
    const latest = history[history.length - 1];
    const hasUnresolvedMisconception = history.some((entry, index) =>
      entry.taxonomy === 'confident_misconception' &&
      !history.slice(index + 1).some((later) => later.taxonomy === 'correct' && later.independenceLevel === 'independent'),
    );
    const positive = history.some((entry) => ['correct', 'self_corrected'].includes(entry.taxonomy));
    const negative = history.some((entry) => ['incorrect', 'confident_misconception', 'missing_prerequisite'].includes(entry.taxonomy));
    return {
      concept: latest.concept,
      conceptId,
      status: projectConceptStatus(projected),
      evidenceIds: history.map((entry) => entry.evidenceId),
      latestEvidenceId: latest.evidenceId,
      hasContradiction: positive && negative,
      hasUnresolvedMisconception,
    };
  });
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
