import type OpenAI from 'openai';
import { z } from 'zod';
import type { EvidenceRow, Repo, SessionSummary } from './store/repo.js';

const ClaimSchema = z.object({
  concept: z.string().min(1).max(160),
  evidence: z.string().min(1).max(500),
  evidenceIds: z.array(z.string().min(1)).min(1).max(6),
});

const SessionSummarySchema = z.object({
  headline: z.string().min(1).max(320),
  workedOn: z.array(z.string().min(1).max(120)).max(6),
  strengths: z.array(ClaimSchema).max(3),
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
- One correct answer is not demonstrated understanding.
- Preserve contradiction, uncertainty, earlier difficulty, and later improvement.
- If evidence is thin, use empty claim arrays and say so plainly.
- Plain, warm, specific language. Refer to the learner by name.

Reply with JSON only:
{
  "headline": "one evidence-calibrated sentence",
  "workedOn": ["short phrase"],
  "strengths": [{"concept":"...","evidence":"...","evidenceIds":["uuid"]}],
  "struggles": [{"concept":"...","evidence":"...","kind":"misconception|gap|uncertain","evidenceIds":["uuid"]}],
  "recommendation": "one useful next action",
  "recommendationEvidenceIds": ["uuid"],
  "confidenceNote": "how much independent evidence exists"
}`;

export async function summarizeSession(client: OpenAI, model: string, repo: Repo, sessionId: string): Promise<SessionSummary | null> {
  const session = repo.getSession(sessionId);
  const child = session ? repo.getChild(session.childId) : null;
  if (!session || !child || session.status !== 'ended') return null;
  const throughEventId = session.endedEventId;
  const events = repo.listEvents(sessionId, 1000, throughEventId);
  const evidence = repo.listEvidence(sessionId);
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
  if (!content) return deterministicEvidenceFallback(child.name, session.goal, evidence, throughEventId);
  try {
    const parsed = SessionSummarySchema.parse(JSON.parse(content));
    if (!validateSummaryCitations(parsed, evidence, transcript)) return deterministicEvidenceFallback(child.name, session.goal, evidence, throughEventId);
    return { version: 1, throughEventId, ...parsed };
  } catch {
    return deterministicEvidenceFallback(child.name, session.goal, evidence, throughEventId);
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
  const normalizedTranscript = normalize(transcript);
  for (const text of [...claims.map((claim) => claim.evidence), summary.recommendation]) {
    for (const quote of extractQuotes(text)) if (!normalizedTranscript.includes(normalize(quote))) return false;
  }
  return true;
}

function deterministicEvidenceFallback(name: string, goal: string, evidence: EvidenceRow[], throughEventId: number | null): SessionSummary {
  const latest = evidence[evidence.length - 1];
  const misconception = [...evidence].reverse().find((entry) => entry.taxonomy === 'confident_misconception');
  const positive = [...evidence].reverse().find((entry) => ['correct', 'self_corrected'].includes(entry.taxonomy));
  return {
    version: 1,
    throughEventId,
    headline: `${name} worked on ${goal}; this report is limited to directly recorded evidence.`,
    workedOn: [...new Set(evidence.map((entry) => entry.concept))].slice(0, 6),
    strengths: positive ? [{ concept: positive.concept, evidence: positive.observation, evidenceIds: [positive.evidenceId] }] : [],
    struggles: misconception
      ? [{ concept: misconception.concept, evidence: misconception.observation, kind: 'misconception', evidenceIds: [misconception.evidenceId] }]
      : latest && ['incorrect', 'confusion', 'missing_prerequisite'].includes(latest.taxonomy)
        ? [{ concept: latest.concept, evidence: latest.observation, kind: latest.taxonomy === 'missing_prerequisite' ? 'gap' : 'uncertain', evidenceIds: [latest.evidenceId] }]
        : [],
    recommendation: `Use another independent opportunity on ${latest?.concept ?? goal} before drawing a stronger conclusion.`,
    recommendationEvidenceIds: latest ? [latest.evidenceId] : [],
    confidenceNote: evidence.length < 2 ? 'This session produced only thin evidence.' : 'This summary preserves all recorded evidence, including uncertainty.',
  };
}

function thinEvidenceFallback(name: string, goal: string, throughEventId: number | null): SessionSummary {
  return {
    version: 1,
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

function normalize(value: string): string { return value.normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim(); }
function extractQuotes(value: string): string[] {
  const quotes: string[] = [];
  for (const match of value.matchAll(/[“"]([^”"]+)[”"]/g)) if (match[1]) quotes.push(match[1]);
  return quotes;
}
