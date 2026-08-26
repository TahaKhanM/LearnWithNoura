import { REALTIME_TOOLS } from './tools.js';
import { semanticTurnDetection } from './turnFloor.js';
import type { CoordinatorContext } from './coordinatorContext.js';

/** Provider session configuration for one lesson. */

export const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
export const OUTPUT_AUDIO_SAMPLES_PER_MS = 24;

/** The sideband control channel for an existing WebRTC call. */
export function realtimeCallUrl(callId: string): string {
  return `${REALTIME_URL}?call_id=${encodeURIComponent(callId)}`;
}

function currentInstructions(ctx: CoordinatorContext): string {
  return `${ctx.baseInstructions}\n\n${ctx.state.boardContext.prompt()}`;
}

export function refreshBoardInstructions(ctx: CoordinatorContext): void {
  ctx.sendUpstream({ type: 'session.update', session: { type: 'realtime', instructions: currentInstructions(ctx) } });
}

/**
 * The complete lesson session configuration. Applied once at call bootstrap
 * (before the browser answer is returned, so provider defaults never own a
 * turn) and re-applied idempotently when a sideband reattaches to the call.
 */
export function sessionUpdatePayload(instructions: string): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      reasoning: { effort: 'low' },
      instructions,
      tools: REALTIME_TOOLS,
      tool_choice: 'auto',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: semanticTurnDetection('medium'),
          // The learner is a child close to the device microphone.
          noise_reduction: { type: 'near_field' },
        },
        output: { voice: 'marin', format: { type: 'audio/pcm', rate: 24000 } },
      },
    },
  };
}

export function initialSessionUpdate(ctx: CoordinatorContext): Record<string, unknown> {
  return sessionUpdatePayload(currentInstructions(ctx));
}
