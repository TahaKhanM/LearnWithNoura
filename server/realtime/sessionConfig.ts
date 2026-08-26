import { REALTIME_TOOLS } from './tools.js';
import { semanticTurnDetection } from './turnFloor.js';
import type { CoordinatorContext } from './coordinatorContext.js';

/** Provider session configuration for one lesson. */

export const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
export const OUTPUT_AUDIO_SAMPLES_PER_MS = 24;

function currentInstructions(ctx: CoordinatorContext): string {
  return `${ctx.baseInstructions}\n\n${ctx.state.boardContext.prompt()}`;
}

export function refreshBoardInstructions(ctx: CoordinatorContext): void {
  ctx.sendUpstream({ type: 'session.update', session: { type: 'realtime', instructions: currentInstructions(ctx) } });
}

export function initialSessionUpdate(ctx: CoordinatorContext): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      reasoning: { effort: 'low' },
      instructions: currentInstructions(ctx),
      tools: REALTIME_TOOLS,
      tool_choice: 'auto',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: semanticTurnDetection('medium'),
        },
        output: { voice: 'marin', format: { type: 'audio/pcm', rate: 24000 } },
      },
    },
  };
}
