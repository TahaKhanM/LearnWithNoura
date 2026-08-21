import type { LessonStep, WhiteboardAction } from '../whiteboard/types';
import { speak, whenIdle } from '../speech/speech';

// A beat after a sentence appears before its drawing lands, so the words
// arrive first and the mark follows, rather than both snapping in together.
const BEAT_AFTER_CHAT_MS = 380;
// Marks in the same round belong to one gesture, so they follow closely.
const BEAT_AFTER_MARK_MS = 220;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Holds steps that have arrived from the network but not yet been played.
 * The stream fills it as fast as the model produces; the player drains it
 * at the pace of the spoken lesson. Whichever is slower sets the rhythm,
 * which is what makes the tutor feel like it is working rather than
 * replaying something already finished.
 */
export class StepQueue {
  private items: LessonStep[] = [];
  private waiting: ((step: LessonStep | null) => void) | null = null;
  private closed = false;

  push(step: LessonStep): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(step);
      return;
    }
    this.items.push(step);
  }

  /** No more steps are coming. Pending and future reads return null. */
  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(null);
    }
  }

  /** Next step, or null once the queue is closed and drained. */
  next(): Promise<LessonStep | null> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift() as LessonStep);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

export interface StepRunnerHandlers {
  onChat: (text: string) => void;
  onWhiteboardAction: (action: WhiteboardAction) => void;
  onClear: () => void;
  /** True while the queue is empty and the model is still thinking. */
  onWaiting?: (waiting: boolean) => void;
  isStale?: () => boolean;
}

export async function playSteps(
  queue: StepQueue,
  handlers: StepRunnerHandlers,
): Promise<void> {
  for (;;) {
    if (handlers.isStale?.()) return;

    const pending = queue.next();
    // Only advertise thinking time if the step is not already sitting there.
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    if (!settled) handlers.onWaiting?.(true);

    const step = await pending;
    handlers.onWaiting?.(false);

    if (step === null) return;
    if (handlers.isStale?.()) return;

    if (step.type === 'chat') {
      // Let the previous sentence land before starting the next one.
      await whenIdle();
      if (handlers.isStale?.()) return;
      handlers.onChat(step.text);
      speak(step.text);
      await delay(BEAT_AFTER_CHAT_MS);
    } else if (step.type === 'clear') {
      handlers.onClear();
      await delay(BEAT_AFTER_MARK_MS);
    } else {
      handlers.onWhiteboardAction(step);
      await delay(BEAT_AFTER_MARK_MS);
    }
  }
}
