/**
 * Sequential draw-on animation for tutor marks. Paths draw along their
 * length, text wipes in, and a pen indicator follows the live stroke.
 * All animation is imperative (rAF + direct style writes) so cancelling a
 * turn can complete or drop pending work instantly without fighting React.
 */

export interface AnimTask {
  itemId: string;
  /** Element + geometry for each node of the item, in draw order. */
  nodes: {
    el: SVGElement;
    kind: 'path' | 'text' | 'katex' | 'image';
    length: number;
  }[];
}

export interface PenPosition {
  x: number;
  y: number;
}

const STROKE_SPEED = 1350; // board units per second
const MIN_NODE_MS = 90;
const MAX_NODE_MS = 900;
const TEXT_MS_PER_CHAR = 14;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function hideForAnimation(el: SVGElement, kind: 'path' | 'text' | 'katex' | 'image', length: number): void {
  if (kind === 'path') {
    el.style.strokeDasharray = `${length}`;
    el.style.strokeDashoffset = `${length}`;
    // Fills appear once the outline has been drawn.
    el.style.fillOpacity = '0';
  } else {
    el.style.opacity = '0';
  }
}

function revealNode(el: SVGElement, kind: 'path' | 'text' | 'katex' | 'image'): void {
  if (kind === 'path') {
    el.style.strokeDasharray = '';
    el.style.strokeDashoffset = '';
    el.style.fillOpacity = '';
    el.style.transition = 'fill-opacity 0.25s ease';
  } else {
    el.style.opacity = '';
    el.style.clipPath = '';
  }
}

export class BoardAnimator {
  private queue: AnimTask[] = [];
  private pendingTransactions = new Set<string>();
  private running = false;
  private raf = 0;
  private currentResolve: ((completed: boolean) => void) | null = null;
  private currentTask: AnimTask | null = null;
  private idleWaiters = new Set<(completed: boolean) => void>();
  onPen: (pos: PenPosition | null) => void = () => {};
  /** Called when the animation queue drains. */
  onIdle: () => void = () => {};

  /**
   * Keeps `whenIdle` pending while React commits and the canvas compiles a
   * released visual checkpoint. Without this hold, a fast caller can observe
   * an empty queue between `setScene` and the canvas layout effect.
   */
  beginTransaction(id: string): void {
    this.pendingTransactions.add(id);
  }

  /** Releases the pre-paint hold after every node in the checkpoint is queued. */
  commitTransaction(id: string): void {
    if (!this.pendingTransactions.delete(id)) return;
    if (!this.running && this.queue.length === 0 && !this.currentTask && this.pendingTransactions.size === 0) {
      this.onIdle();
      this.resolveIdle(true);
    }
  }

  enqueue(task: AnimTask): void {
    if (prefersReducedMotion()) {
      for (const node of task.nodes) revealNode(node.el, node.kind);
      return;
    }
    this.queue.push(task);
    if (!this.running) void this.run();
  }

  whenIdle(): Promise<boolean> {
    if (!this.running && this.queue.length === 0 && !this.currentTask && this.pendingTransactions.size === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  /** Drops the active transient checkpoint and every queued checkpoint. */
  cancelAll(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.running = false;
    if (this.currentTask) {
      for (const node of this.currentTask.nodes) hideForAnimation(node.el, node.kind, node.length);
      this.currentTask = null;
    }
    for (const task of this.queue) for (const node of task.nodes) hideForAnimation(node.el, node.kind, node.length);
    this.queue = [];
    this.pendingTransactions.clear();
    if (this.currentResolve) {
      const resolve = this.currentResolve;
      this.currentResolve = null;
      resolve(false);
    }
    this.onPen(null);
    this.resolveIdle(false);
  }

  /** Instantly completes everything queued or mid-draw. */
  finishAll(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.running = false;
    // The task being drawn right now must land whole, not frozen mid-stroke.
    if (this.currentTask) {
      for (const node of this.currentTask.nodes) revealNode(node.el, node.kind);
      this.currentTask = null;
    }
    if (this.currentResolve) {
      const resolve = this.currentResolve;
      this.currentResolve = null;
      resolve(true);
    }
    for (const task of this.queue) {
      for (const node of task.nodes) revealNode(node.el, node.kind);
    }
    this.queue = [];
    this.pendingTransactions.clear();
    this.onPen(null);
    this.resolveIdle(true);
  }

  private async run(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift() as AnimTask;
      this.currentTask = task;
      for (const node of task.nodes) {
        if (!this.running) break;
        const completed = await this.animateNode(node);
        if (!completed) break;
      }
      this.currentTask = null;
    }
    this.running = false;
    this.onPen(null);
    if (this.pendingTransactions.size === 0) {
      this.onIdle();
      this.resolveIdle(true);
    }
  }

  private animateNode(node: AnimTask['nodes'][number]): Promise<boolean> {
    const { el, kind, length } = node;
    if (!el.isConnected) {
      revealNode(el, kind);
      return Promise.resolve(true);
    }

    // When a backlog builds up (a big scene landing at once, or speech
    // running ahead), draw faster rather than falling behind the lesson.
    const hurry = 1 / (1 + this.queue.length * 0.4);
    const duration =
      (kind === 'path'
        ? Math.max(MIN_NODE_MS, Math.min(MAX_NODE_MS, (length / STROKE_SPEED) * 1000))
        : Math.max(160, Math.min(700, length * TEXT_MS_PER_CHAR))) * Math.max(0.22, hurry);

    return new Promise((resolve) => {
      this.currentResolve = resolve;
      const start = performance.now();
      const isPath = kind === 'path' && typeof (el as SVGPathElement).getPointAtLength === 'function';

      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        if (kind === 'path') {
          el.style.strokeDashoffset = `${length * (1 - t)}`;
          if (isPath) {
            try {
              const pt = (el as SVGPathElement).getPointAtLength(length * t);
              this.onPen({ x: pt.x, y: pt.y });
            } catch {
              // jsdom or detached node; skip pen tracking.
            }
          }
        } else {
          el.style.opacity = `${Math.min(1, t * 1.4)}`;
          el.style.clipPath = `inset(-20% ${Math.max(0, (1 - t) * 105)}% -20% -5%)`;
        }
        if (t < 1) {
          this.raf = requestAnimationFrame(tick);
        } else {
          revealNode(el, kind);
          this.currentResolve = null;
          resolve(true);
        }
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  private resolveIdle(completed: boolean): void {
    for (const resolve of this.idleWaiters) resolve(completed);
    this.idleWaiters.clear();
  }
}
