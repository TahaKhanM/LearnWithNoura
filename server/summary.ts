import type OpenAI from 'openai';
import type { Repo, SessionSummary } from './store/repo';

/**
 * Turns a finished session's raw events and evidence into the parent-facing
 * summary. The summary may only describe what actually happened: the model
 * is given the transcript and the recorded evidence, and is told to stay
 * calibrated — no scores, no invented mastery.
 */

const SUMMARY_PROMPT = `You write short, honest session reports for a parent, based on a tutoring transcript and structured evidence entries recorded during the lesson.

Rules:
- Only claim things supported by the transcript or evidence entries. When evidence is thin, say so plainly.
- Never invent numeric scores or percentages.
- Quote or paraphrase what the child actually said where it helps.
- Plain, warm, specific language. No education jargon, no filler praise.
- The child is referred to by name.

Reply with JSON only, matching:
{
  "headline": "one sentence, what the session was about and how it went",
  "workedOn": ["short phrase", ...],
  "strengths": [{"concept": "...", "evidence": "what the child did/said that shows it"}],
  "struggles": [{"concept": "...", "evidence": "...", "kind": "misconception" | "gap" | "uncertain"}],
  "recommendation": "the single most useful next step, one or two sentences",
  "confidenceNote": "one sentence on how much evidence this session produced"
}
Keep strengths and struggles to at most 3 entries each; empty arrays are fine.`;

export async function summarizeSession(
  client: OpenAI,
  model: string,
  repo: Repo,
  sessionId: string,
): Promise<SessionSummary | null> {
  const session = repo.getSession(sessionId);
  const child = session ? repo.getChild(session.childId) : null;
  if (!session || !child) return null;

  const events = repo.listEvents(sessionId, 1000);
  const evidence = repo.listEvidence(sessionId);

  const transcript = events
    .filter((e) => ['tutor_said', 'learner_said', 'interrupted'].includes(e.type))
    .map((e) => {
      if (e.type === 'interrupted') return `[${child.name} interrupted]`;
      const text = (e.payload as { text?: string }).text ?? '';
      return `${e.type === 'tutor_said' ? 'Tutor' : child.name}: ${text}`;
    })
    .slice(-160)
    .join('\n');

  if (!transcript.trim()) return null;

  const evidenceBlock =
    evidence.length > 0
      ? evidence
          .map(
            (e) =>
              `- [${e.verdict}, ${e.confidence} confidence] ${e.concept}: ${e.observation}${e.excerpt ? ` ("${e.excerpt}")` : ''}`,
          )
          .join('\n')
      : '(none recorded)';

  const response = await client.chat.completions.create({
    model,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      {
        role: 'user',
        content: `Child: ${child.name}${child.age ? `, age ${child.age}` : ''}\nSession goal: ${session.goal}\n\nEvidence entries:\n${evidenceBlock}\n\nTranscript:\n${transcript}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as Partial<SessionSummary>;
    return {
      headline: String(parsed.headline ?? 'Session finished.'),
      workedOn: Array.isArray(parsed.workedOn) ? parsed.workedOn.map(String).slice(0, 6) : [],
      strengths: normalizeEntries(parsed.strengths),
      struggles: normalizeEntries(parsed.struggles).map((s) => ({
        ...s,
        kind: (['misconception', 'gap', 'uncertain'] as const).includes(
          (s as { kind?: string }).kind as 'misconception',
        )
          ? ((s as { kind?: string }).kind as 'misconception' | 'gap' | 'uncertain')
          : 'uncertain',
      })),
      recommendation: String(parsed.recommendation ?? ''),
      confidenceNote: String(parsed.confidenceNote ?? ''),
    };
  } catch {
    return null;
  }
}

function normalizeEntries(
  value: unknown,
): { concept: string; evidence: string; kind?: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({
      concept: String(v.concept ?? '').slice(0, 160),
      evidence: String(v.evidence ?? '').slice(0, 400),
      ...(typeof v.kind === 'string' ? { kind: v.kind } : {}),
    }))
    .filter((v) => v.concept)
    .slice(0, 3);
}
