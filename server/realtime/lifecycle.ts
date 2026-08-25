import type { ProxyLifecycle } from './proxy.js';

export const PROXY_SHUTDOWN_TIMEOUT_MS = 5_000;

export class ProxyLifecycleRegistry {
  private readonly active = new Set<ProxyLifecycle>();
  private readonly connections = new Set<Promise<void>>();
  private state: 'open' | 'closing' | 'closed' = 'open';

  register(lifecycle: ProxyLifecycle): void {
    if (this.state === 'closed') throw new Error('Proxy lifecycle registry is closed.');
    this.active.add(lifecycle);
    void lifecycle.completion.finally(() => this.active.delete(lifecycle)).catch(() => {});
  }

  trackConnection(connection: Promise<void>): void {
    if (this.state === 'closed') throw new Error('Proxy lifecycle registry is closed.');
    this.connections.add(connection);
    void connection.finally(() => this.connections.delete(connection)).catch(() => {});
  }

  async shutdown(timeoutMs = PROXY_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.state = 'closing';
    const deadline = Date.now() + timeoutMs;
    const failures: unknown[] = [];
    while (this.active.size > 0 || this.connections.size > 0) {
      const snapshot = [...this.active];
      const settled = await withDeadline(Promise.allSettled([
        ...this.connections,
        ...snapshot.flatMap((lifecycle) => [
          lifecycle.close(),
          lifecycle.completion,
        ]),
      ]), Math.max(1, deadline - Date.now()));
      for (const result of settled) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
      await Promise.resolve();
    }
    this.state = 'closed';
    if (failures.length > 0) throw failures[0];
  }
}

export class ShutdownGate {
  private closing = false;

  begin(): void {
    this.closing = true;
  }

  allowsUpgrade(): boolean {
    return !this.closing;
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
