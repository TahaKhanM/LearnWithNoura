import type OpenAI from 'openai';
import { validateOps, type BoardOp } from '../shared/boardOps';
import { buildInstructions } from './realtime/instructions';
import type { Repo } from './store/repo';

/**
 * Captions-only degraded mode: when the realtime voice connection is
 * unavailable, the lesson continues over plain HTTP with streamed text and
 * the same board language, recorded into the same session store. No fake
 * audio, no fake success — the UI says voice is off.
 */

const MAX_ROUNDS = 10;

export type FallbackStep =
  | { type: 'say'; text: string }
  | { type: 'board_ops'; ops: BoardOp[] }
  | { type: 'evidence' };

const FALLBACK_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'board_ops',
      description:
        'Draw on the shared whiteboard. Call right after the sentence the drawing belongs to.',
      parameters: {
        type: 'object',
        properties: { ops: { type: 'array', items: { type: 'object' } } },
        required: ['ops'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'record_evidence',
      description: 'Record what the learner just showed about their understanding.',
      parameters: {
        type: 'object',
        properties: {
          concept: { type: 'string' },
          observation: { type: 'string' },
          verdict: { type: 'string', enum: ['mastered', 'progressing', 'struggling', 'misconception'] },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          excerpt: { type: 'string' },
        },
        required: ['concept', 'observation', 'verdict', 'confidence'],
      },
    },
  },
];

export async function runFallbackTurn(
  client: OpenAI,
  model: string,
  repo: Repo,
  sessionId: string,
  userText: string,
  onStep: (step: FallbackStep) => void,
): Promise<void> {
  const session = repo.getSession(sessionId);
  const child = session ? repo.getChild(session.childId) : null;
  if (!session || !child) throw new Error('unknown session');

  repo.addEvent(sessionId, 'learner_said', { text: userText, via: 'text' });

  const instructions = buildInstructions({
    childName: child.name,
    childAge: child.age,
    goal: session.goal,
  });

  const history: OpenAI.Chat.ChatCompletionMessageParam[] = repo
    .listEvents(sessionId, 400)
    .filter((e) => ['tutor_said', 'learner_said'].includes(e.type))
    .slice(-40)
    .map((e) => ({
      role: e.type === 'tutor_said' ? ('assistant' as const) : ('user' as const),
      content: (e.payload as { text?: string }).text ?? '',
    }))
    .filter((m) => m.content);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        instructions +
        '\n\nNote: voice is unavailable right now, so your words appear as captions. Keep the same short spoken style.',
    },
    ...history,
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: FALLBACK_TOOLS,
      tool_choice: 'auto',
      reasoning_effort: 'none',
    });

    const message = response.choices[0].message;
    if (message.content) {
      repo.addEvent(sessionId, 'tutor_said', { text: message.content });
      onStep({ type: 'say', text: message.content });
    }
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) break;

    for (const call of message.tool_calls) {
      if (call.type !== 'function') continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        /* fall through with empty args */
      }

      let output = '{"ok":false}';
      if (call.function.name === 'board_ops') {
        const { ops, rejected } = validateOps(args.ops);
        if (ops.length > 0) {
          repo.addEvent(sessionId, 'board_ops', { ops });
          onStep({ type: 'board_ops', ops });
        }
        output = JSON.stringify({ ok: rejected.length === 0, applied: ops.length });
      } else if (call.function.name === 'record_evidence') {
        const concept = String(args.concept ?? '').slice(0, 120);
        const observation = String(args.observation ?? '').slice(0, 500);
        if (concept && observation) {
          repo.addEvidence(sessionId, {
            concept,
            observation,
            verdict: (['mastered', 'progressing', 'struggling', 'misconception'] as const).includes(
              args.verdict as 'mastered',
            )
              ? (args.verdict as 'mastered')
              : 'progressing',
            confidence: (['low', 'medium', 'high'] as const).includes(args.confidence as 'low')
              ? (args.confidence as 'low')
              : 'low',
            excerpt: args.excerpt ? String(args.excerpt).slice(0, 300) : undefined,
          });
          onStep({ type: 'evidence' });
          output = '{"ok":true}';
        }
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
}
