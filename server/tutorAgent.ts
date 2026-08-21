import type OpenAI from 'openai';
import type { LessonStep } from '../src/whiteboard/types';
import { TOOLS, toolCallToStep } from './tools';
import { loadSystemPrompt } from './prompt';
import { boardContextForModel } from './boardContext';

const MAX_TOOL_ROUNDS = 12;

export interface HistoryTurn {
  role: 'user' | 'tutor';
  text: string;
}

/**
 * Runs one tutor turn, handing each step to `onStep` the moment the model
 * produces it rather than collecting them all first. The agent genuinely
 * works one round at a time: say a line, draw a line, look at the board,
 * decide what comes next. Emitting as we go lets the interface show that
 * real rhythm instead of replaying a finished lesson on a timer.
 */
export async function runTutorTurn(
  client: OpenAI,
  model: string,
  history: HistoryTurn[],
  userMessage: string,
  boardState: unknown,
  onStep: (step: LessonStep) => void,
): Promise<void> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: loadSystemPrompt() },
    ...history.map(
      (turn): OpenAI.Chat.ChatCompletionMessageParam => ({
        role: turn.role === 'user' ? 'user' : 'assistant',
        content: turn.text,
      }),
    ),
    {
      role: 'user',
      content: `${boardContextForModel(boardState)}\n\nLEARNER_QUESTION:\n${userMessage}`,
    },
  ];

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
      onStep({ type: 'chat', text: message.content });
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
      if (step) onStep(step);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: step ? 'ok' : 'error: could not execute this tool call',
      });
    }
  }
}
