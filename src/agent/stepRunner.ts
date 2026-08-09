import type { LessonStep, WhiteboardAction } from '../whiteboard/types';

const STEP_DELAY_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StepRunnerHandlers {
  onChat: (text: string) => void;
  onWhiteboardAction: (action: WhiteboardAction) => void;
  onClear: () => void;
}

export async function runLessonSteps(
  steps: LessonStep[],
  handlers: StepRunnerHandlers,
): Promise<void> {
  for (const step of steps) {
    if (step.type === 'chat') {
      handlers.onChat(step.text);
    } else if (step.type === 'clear') {
      handlers.onClear();
    } else {
      handlers.onWhiteboardAction(step);
    }
    await delay(STEP_DELAY_MS);
  }
}
