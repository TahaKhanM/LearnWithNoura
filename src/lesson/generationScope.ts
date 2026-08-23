import type { GenerationIdentity } from '../../shared/runtimeProtocol';

export type GenerationStatus = 'active' | 'cancelled' | 'completed' | 'failed';

/**
 * Owns every cancellable resource created for one tutor generation. A stale
 * generation has one exit: cancel(), which aborts fetch work and clears every
 * registered timer, frame, listener, caption/visual queue, and provider id.
 */
export class GenerationScope {
  readonly identity: GenerationIdentity;
  readonly controller = new AbortController();
  readonly providerResponseIds = new Set<string>();
  readonly provisionalCaptionIds = new Set<string>();
  readonly transientVisualCueIds = new Set<string>();
  readonly characterTaskIds = new Set<string>();
  readonly pcmTimelineIds = new Set<string>();
  status: GenerationStatus = 'active';
  cancelReason: string | null = null;

  private timeouts = new Set<number>();
  private intervals = new Set<number>();
  private frames = new Set<number>();
  private cleanups = new Set<() => void>();

  constructor(identity: GenerationIdentity) {
    this.identity = identity;
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get active(): boolean { return this.status === 'active' && !this.signal.aborted; }

  timeout(callback: () => void, delayMs: number): number {
    const id = window.setTimeout(() => {
      this.timeouts.delete(id);
      if (this.active) callback();
    }, delayMs);
    this.timeouts.add(id);
    return id;
  }

  interval(callback: () => void, delayMs: number): number {
    const id = window.setInterval(() => { if (this.active) callback(); }, delayMs);
    this.intervals.add(id);
    return id;
  }

  frame(callback: FrameRequestCallback): number {
    const id = requestAnimationFrame((time) => {
      this.frames.delete(id);
      if (this.active) callback(time);
    });
    this.frames.add(id);
    return id;
  }

  addCleanup(cleanup: () => void): () => void {
    this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }

  complete(): void {
    if (!this.active) return;
    this.status = 'completed';
    this.clearResources();
  }

  fail(reason: string): void {
    if (!this.active) return;
    this.status = 'failed';
    this.cancelReason = reason;
    this.controller.abort(reason);
    this.clearResources();
  }

  cancel(reason: string): void {
    if (!this.active) return;
    this.status = 'cancelled';
    this.cancelReason = reason;
    this.controller.abort(reason);
    this.clearResources();
  }

  private clearResources(): void {
    for (const id of this.timeouts) window.clearTimeout(id);
    for (const id of this.intervals) window.clearInterval(id);
    for (const id of this.frames) cancelAnimationFrame(id);
    this.timeouts.clear();
    this.intervals.clear();
    this.frames.clear();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
    this.provisionalCaptionIds.clear();
    this.transientVisualCueIds.clear();
    this.characterTaskIds.clear();
    this.pcmTimelineIds.clear();
  }
}
