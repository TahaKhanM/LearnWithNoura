import type OpenAI from 'openai';
import { z } from 'zod';
import { projectConceptHistories, type ConceptEvidenceHistoryInput } from '../shared/pedagogy.js';
import type { DomainRepository } from './store/domain.js';
import type { EvidenceRow, SessionSummary } from './store/repo.js';

const ClaimSchema = z.object({
  concept: z.string().min(1).max(160),
  evidence: z.string().min(1).max(500),
  evidenceIds: z.array(z.string().min(1)).min(1).max(6),
});

const StrengthClaimSchema = ClaimSchema.extend({ status: z.enum(['progressing', 'demonstrated']) });

const SessionSummarySchema = z.object({
  headline: z.string().min(1).max(320),
  workedOn: z.array(z.string().min(1).max(120)).max(6),
  strengths: z.array(StrengthClaimSchema).max(3),
  struggles: z.array(ClaimSchema.extend({ kind: z.enum(['misconception', 'gap', 'uncertain']) })).max(3),
  recommendation: z.string().min(1).max(500),
  recommendationEvidenceIds: z.array(z.string().min(1)).max(6),
  confidenceNote: z.string().min(1).max(320),
});

const SUMMARY_PROMPT = `Write a short, honest Noura session report for a parent from the supplied transcript and evidence observations.

Rules:
- Every strength, struggle, and recommendation must cite one or more supplied evidence IDs.
- Quotes must match the supplied transcript exactly after whitespace and punctuation normalization.
- Never invent a score, percentage, mastery claim, or event.
- Label every strength as progressing or demonstrated. One correct or self-corrected answer is only progressing.
- Demonstrated requires distinct independent task/turn opportunities, explanation/application, and a chronologically later retrieval tied to the earlier task.
- Duplicate classifications from one answer never count twice. Latest negative or unresolved contradiction/misconception is uncertain.
- A correction is progress, not confirmation; after explicit resolution, require fresh independent application/explanation and tied later retrieval.
- Preserve contradiction, uncertainty, earlier difficulty, and later improvement.
- If evidence is thin, use empty claim arrays and say so plainly.
- Plain, warm, specific language. Refer to the learner by name.

Reply with JSON only:
{
  "headline": "one evidence-calibrated sentence",
  "workedOn": ["short phrase"],
  "strengths": [{"concept":"...","evidence":"...","status":"progressing|demonstrated","evidenceIds":["uuid"]}],
  "struggles": [{"concept":"...","evidence":"...","kind":"misconception|gap|uncertain","evidenceIds":["uuid"]}],
  "recommendation": "one useful next action",
  "recommendationEvidenceIds": ["uuid"],
  "confidenceNote": "how much independent evidence exists"
}`;

export async function summarizeSession(client: OpenAI, model: string, repo: DomainRepository, sessionId: string): Promise<SessionSummary | null> {
  const session = await repo.getSession(sessionId);
  const child = session ? await repo.getChild(session.childId) : null;
  if (!session || !child || session.status !== 'ended') return null;
  const throughEventId = session.endedEventId;
  const events = await repo.listEvents(sessionId, 1000, throughEventId);
  const evidence = await repo.listEvidence(sessionId);
  const transcript = events
    .filter((event) => ['tutor_said', 'learner_said', 'interrupted'].includes(event.type))
    .map((event) => {
      if (event.type === 'interrupted') return `[${child.name} interrupted]`;
      const text = (event.payload as { text?: string }).text ?? '';
      return `${event.type === 'tutor_said' ? 'Noura' : child.name}: ${text}`;
    })
    .slice(-160)
    .join('\n');
  if (!transcript.trim()) return null;
  if (evidence.length === 0) return thinEvidenceFallback(child.name, session.goal, throughEventId);

  const evidenceBlock = evidence.map((entry) =>
    `- [${entry.evidenceId}] ${entry.taxonomy}; ${entry.confidenceBasis}; ${entry.concept}: ${entry.observation}${entry.normalizedExcerpt ? `; exact excerpt: "${entry.normalizedExcerpt}"` : ''}; source events: ${entry.sourceEventIds.join(', ')}`,
  ).join('\n');

  const response = await client.chat.completions.create({
    model,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: `Learner: ${child.name}${child.age ? `, age ${child.age}` : ''}\nGoal: ${session.goal}\nCutoff event: ${throughEventId ?? 'none'}\n\nEvidence:\n${evidenceBlock}\n\nTranscript:\n${transcript}` },
    ],
  });
  const content = response.choices[0]?.message?.content;
  if (!content) return buildDeterministicSummary(child.name, session.goal, evidence, throughEventId);
  try {
    const parsed = SessionSummarySchema.parse(JSON.parse(content));
    if (!validateSummaryCitations(parsed, evidence, transcript)) return buildDeterministicSummary(child.name, session.goal, evidence, throughEventId);
    return { version: 2, throughEventId, ...parsed };
  } catch {
    return buildDeterministicSummary(child.name, session.goal, evidence, throughEventId);
  }
}

export function validateSummaryCitations(
  summary: z.infer<typeof SessionSummarySchema>,
  evidence: EvidenceRow[],
  transcript: string,
): boolean {
  const ids = new Set(evidence.map((entry) => entry.evidenceId));
  const claims = [...summary.strengths, ...summary.struggles];
  if (claims.some((claim) => claim.evidenceIds.length === 0 || claim.evidenceIds.some((id) => !ids.has(id)))) return false;
  if (summary.recommendationEvidenceIds.some((id) => !ids.has(id))) return false;
  const byEvidenceId = new Map(evidence.map((entry) => [entry.evidenceId, entry]));
  const projections = new Map(projectConceptHistories(evidence.map(projectionInput)).map((projection) => [projection.conceptId, projection]));
  for (const claim of summary.strengths) {
    const cited = claim.evidenceIds.map((id) => byEvidenceId.get(id)).filter((entry): entry is EvidenceRow => Boolean(entry));
    const conceptIds = new Set(cited.map((entry) => entry.conceptId));
    if (conceptIds.size !== 1) return false;
    const projection = projections.get(cited[0]?.conceptId ?? '');
    if (!projection || projection.status === 'uncertain' || projection.status === 'not_observed' || claim.status !== projection.status) return false;
  }
  const normalizedTranscript = normalize(transcript);
  for (const text of [...claims.map((claim) => claim.evidence), summary.recommendation]) {
    for (const quote of extractQuotes(text)) if (!normalizedTranscript.includes(normalize(quote))) return false;
  }
  return true;
}

export function buildDeterministicSummary(name: string, goal: string, evidence: EvidenceRow[], throughEventId: number | null): SessionSummary {
  const latest = evidence[evidence.length - 1];
  const projections = projectConceptHistories(evidence.map(projectionInput));
  const byConcept = new Map<string, EvidenceRow[]>();
  for (const entry of evidence) byConcept.set(entry.conceptId, [...(byConcept.get(entry.conceptId) ?? []), entry]);
  const strengths = projections
    .filter((projection) => projection.status === 'progressing' || projection.status === 'demonstrated')
    .slice(-3)
    .map((projection) => {
      const history = byConcept.get(projection.conceptId) ?? [];
      const supporting = history.filter((entry) => ['correct', 'self_corrected'].includes(entry.taxonomy));
      const representative = supporting[supporting.length - 1] ?? history[history.length - 1];
      return {
        concept: projection.concept,
        evidence: representative.observation,
        status: projection.status as 'progressing' | 'demonstrated',
        evidenceIds: projection.status === 'demonstrated' ? projection.evidenceIds.slice(-6) : [representative.evidenceId],
      };
    });
  const struggles = projections
    .filter((projection) => projection.status === 'uncertain')
    .slice(-3)
    .map((projection) => {
      const history = byConcept.get(projection.conceptId) ?? [];
      const representative = [...history].reverse().find((entry) =>
        ['confident_misconception', 'incorrect', 'missing_prerequisite'].includes(entry.taxonomy),
      ) ?? history[history.length - 1];
      return {
        concept: projection.concept,
        evidence: representative.observation,
        kind: (projection.hasUnresolvedMisconception ? 'misconception' : representative.taxonomy === 'missing_prerequisite' ? 'gap' : 'uncertain') as 'misconception' | 'gap' | 'uncertain',
        evidenceIds: projection.evidenceIds.slice(-6),
      };
    });
  return {
    version: 2,
    throughEventId,
    headline: `${name} worked on ${goal}; this report is limited to directly recorded evidence.`,
    workedOn: [...new Set(evidence.map((entry) => entry.concept))].slice(0, 6),
    strengths,
    struggles,
    recommendation: `Use another independent opportunity on ${latest?.concept ?? goal} before drawing a stronger conclusion.`,
    recommendationEvidenceIds: latest ? [latest.evidenceId] : [],
    confidenceNote: projections.some((projection) => projection.status === 'demonstrated')
      ? 'Demonstrated labels require independent evidence across explanation or application and later retrieval.'
      : evidence.length < 2
        ? 'This session produced only thin evidence; no concept is labelled demonstrated.'
        : 'Evidence is still developing or contradictory; no concept is labelled demonstrated yet.',
  };
}

function thinEvidenceFallback(name: string, goal: string, throughEventId: number | null): SessionSummary {
  return {
    version: 2,
    throughEventId,
    headline: `${name} worked on ${goal}, but no meaningful learner evidence was recorded.`,
    workedOn: [goal],
    strengths: [],
    struggles: [],
    recommendation: 'Ask one small independent question next time before drawing a conclusion.',
    recommendationEvidenceIds: [],
    confidenceNote: 'No learner response supported a claim about understanding.',
  };
}

function projectionInput(entry: EvidenceRow): ConceptEvidenceHistoryInput {
  return {
    evidenceId: entry.evidenceId,
    concept: entry.concept,
    conceptId: entry.conceptId,
    taxonomy: entry.taxonomy,
    independenceLevel: entry.independenceLevel,
    opportunityKind: entry.opportunityKind,
    taskId: entry.taskId,
    sessionId: entry.sessionId,
    turnId: entry.turnId,
    ts: entry.ts,
    order: entry.id,
    retrievalOf: entry.retrievalOf,
    contradicts: entry.contradicts,
    supersedes: entry.supersedes,
  };
}

function normalize(value: string): string { return value.normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim(); }
function extractQuotes(value: string): string[] {
  const quotes: string[] = [];
  for (const match of value.matchAll(/[“"]([^”"]+)[”"]/g)) if (match[1]) quotes.push(match[1]);
  return quotes;
}
