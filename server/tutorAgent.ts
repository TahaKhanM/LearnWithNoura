import type OpenAI from 'openai';
import type { LessonStep } from '../src/whiteboard/types';
import { SYSTEM_PROMPT, TOOLS, toolCallToStep } from './tools';

const MAX_TOOL_ROUNDS = 12;

export interface HistoryTurn {
  role: 'user' | 'tutor';
  text: string;
}

export async function runTutorTurn(
  client: OpenAI,
  model: string,
  history: HistoryTurn[],
  userMessage: string,
): Promise<LessonStep[]> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(
      (turn): OpenAI.Chat.ChatCompletionMessageParam => ({
        role: turn.role === 'user' ? 'user' : 'assistant',
        content: turn.text,
      }),
    ),
    { role: 'user', content: userMessage },
  ];

  const steps: LessonStep[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      // gpt-5.6-terra is a reasoning model; function tools on the chat
      // completions endpoint require reasoning to be disabled.
      reasoning_effort: 'none',
    });

    const message = response.choices[0].message;

    if (message.content) {
      steps.push({ type: 'chat', text: message.content });
    }

    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      break;
    }

    for (const call of message.tool_calls) {
      if (call.type !== 'function') continue;

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        // malformed arguments from the model; skip this tool call
      }

      const step = toolCallToStep(call.function.name, args);
      if (step) steps.push(step);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: step ? 'ok' : 'error: could not execute this tool call',
      });
    }
  }

  return steps;
}
