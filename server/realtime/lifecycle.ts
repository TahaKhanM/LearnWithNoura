import type { ProxyLifecycle } from './proxy.js';

export const PROXY_SHUTDOWN_TIMEOUT_MS = 5_000;

export class ProxyLifecycleRegistry {
  private readonly active = new Set<ProxyLifecycle>();
  private accepting = true;

  register(lifecycle: ProxyLifecycle): void {
    if (!this.accepting) {
      void lifecycle.close().catch(() => {});
      return;
    }
    this.active.add(lifecycle);
    void lifecycle.completion.finally(() => this.active.delete(lifecycle)).catch(() => {});
  }

  async shutdown(timeoutMs = PROXY_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.accepting = false;
    const snapshot = [...this.active];
    const settled = await withDeadline(Promise.allSettled(
      snapshot.flatMap((lifecycle) => [
        lifecycle.close(),
        lifecycle.completion,
      ]),
    ), timeoutMs);
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

export async function runQuiescentShutdown(phases: {
  stopAccepting(): void;
  closeClients(): void;
  closeProxies(): Promise<void>;
  closeRepository(): Promise<void>;
  log(error: unknown): void;
}): Promise<void> {
  phases.stopAccepting();
  phases.closeClients();
  for (const phase of [phases.closeProxies, phases.closeRepository]) {
    try {
      await phase();
    } catch (error) {
      phases.log(error);
    }
  }
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Proxy lifecycle shutdown timed out.')),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
