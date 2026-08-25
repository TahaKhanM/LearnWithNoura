import type { ProxyLifecycle } from './proxy.js';

export const PROXY_SHUTDOWN_TIMEOUT_MS = 5_000;
export type ShutdownDisposition = 'graceful' | 'forced' | 'fatal';

export class FatalProxyShutdownError extends Error {
  readonly code = 'FATAL_PROXY_SHUTDOWN';

  constructor(message: string) {
    super(message);
    this.name = 'FatalProxyShutdownError';
  }
}

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

  async shutdown(
    timeoutMs = PROXY_SHUTDOWN_TIMEOUT_MS,
  ): Promise<Exclude<ShutdownDisposition, 'fatal'>> {
    this.state = 'closing';
    const deadline = Date.now() + timeoutMs;
    const failures: unknown[] = [];
    try {
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
    } catch {
      return this.forceTerminalize(timeoutMs);
    }
    this.state = 'closed';
    if (failures.length > 0) throw failures[0];
    return 'graceful';
  }

  private async forceTerminalize(timeoutMs: number): Promise<'forced'> {
    this.state = 'closing';
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0) {
      const snapshot = [...this.active];
      const settled = await withDeadline(
        Promise.allSettled(snapshot.map((lifecycle) => lifecycle.forceTerminal())),
        Math.max(1, deadline - Date.now()),
      ).catch((error: unknown) => {
        throw new FatalProxyShutdownError(
          `Proxy force-terminal deadline failed: ${String(error).slice(0, 160)}`,
        );
      });
      for (let index = 0; index < settled.length; index += 1) {
        const result = settled[index];
        const lifecycle = snapshot[index];
        if (result?.status === 'fulfilled' && lifecycle) {
          this.active.delete(lifecycle);
        } else {
          throw new FatalProxyShutdownError('A proxy could not be force-terminalized.');
        }
      }
      await Promise.resolve();
    }
    if (this.connections.size > 0) {
      throw new FatalProxyShutdownError(
        'Connection setup remained live after proxy force-terminalization.',
      );
    }
    this.state = 'closed';
    return 'forced';
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
  closeProxies(): Promise<Exclude<ShutdownDisposition, 'fatal'>>;
  closeRepository(): Promise<void>;
  log(error: unknown): void;
  fatal?(error: unknown): void;
}): Promise<ShutdownDisposition> {
  phases.stopAccepting();
  phases.closeClients();
  let disposition: Exclude<ShutdownDisposition, 'fatal'>;
  try {
    disposition = await phases.closeProxies();
  } catch (error) {
    phases.log(error);
    phases.fatal?.(error);
    return 'fatal';
  }
  try {
    await phases.closeRepository();
  } catch (error) {
    phases.log(error);
    phases.fatal?.(error);
    return 'fatal';
  }
  return disposition;
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
