import { describe, expect, it, vi } from 'vitest';
import {
  ProxyLifecycleRegistry,
  ShutdownGate,
  runQuiescentShutdown,
} from './lifecycle.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('ProxyLifecycleRegistry', () => {
  it('closes active sockets and awaits unresolved proxy producers', async () => {
    const completion = deferred();
    const close = vi.fn(async () => {});
    const registry = new ProxyLifecycleRegistry();
    registry.register({ close, completion: completion.promise });

    const shutdown = registry.shutdown(1_000);
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    let settled = false;
    void shutdown.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    completion.resolve();
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('surfaces lifecycle closure rejection after settling it', async () => {
    const failure = new Error('proxy close failed');
    const registry = new ProxyLifecycleRegistry();
    registry.register({
      close: async () => { throw failure; },
      completion: Promise.reject(failure),
    });
    await expect(registry.shutdown(1_000)).rejects.toThrow('proxy close failed');
  });

  it('repeatedly drains connections and lifecycles registered while closing', async () => {
    const first = deferred();
    const late = deferred();
    const releaseConnection = deferred();
    const lateCloseStarted = deferred();
    const lateClose = vi.fn(async () => { lateCloseStarted.resolve(); });
    const registry = new ProxyLifecycleRegistry();
    registry.register({ close: async () => {}, completion: first.promise });
    const connection = releaseConnection.promise.then(() => {
      registry.register({ close: lateClose, completion: late.promise });
    });
    registry.trackConnection(connection);

    const shutdown = registry.shutdown(1_000);
    releaseConnection.resolve();
    first.resolve();
    await lateCloseStarted.promise;
    expect(lateClose).toHaveBeenCalled();
    let settled = false;
    void shutdown.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    late.resolve();
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('rejects an authorized upgrade resumed after shutdown starts', async () => {
    const authorization = deferred();
    const active = deferred();
    const gate = new ShutdownGate();
    const registry = new ProxyLifecycleRegistry();
    registry.register({ close: async () => {}, completion: active.promise });
    const order: string[] = [];
    let accepted = false;
    let destroyed = false;
    const upgrade = authorization.promise.then(() => {
      if (!gate.allowsUpgrade()) {
        destroyed = true;
        return;
      }
      accepted = true;
    });
    const shutdown = runQuiescentShutdown({
      stopAccepting: () => {
        gate.begin();
        order.push('stop');
      },
      closeClients: () => { order.push('clients'); },
      closeProxies: () => registry.shutdown(1_000),
      closeRepository: async () => { order.push('repository'); },
      log: () => {},
    });
    authorization.resolve();
    await upgrade;
    expect({ accepted, destroyed }).toEqual({ accepted: false, destroyed: true });
    active.resolve();
    await shutdown;
    expect(order).toEqual(['stop', 'clients', 'repository']);
  });

  it('logs repository close rejection without escaping shutdown', async () => {
    const calls: string[] = [];
    const log = vi.fn();
    await expect(runQuiescentShutdown({
      stopAccepting: () => { calls.push('stop'); },
      closeClients: () => { calls.push('clients'); },
      closeProxies: async () => { calls.push('proxies'); },
      closeRepository: async () => {
        calls.push('repository');
        throw new Error('worker close failed');
      },
      log,
    })).resolves.toBeUndefined();
    expect(calls).toEqual(['stop', 'clients', 'proxies', 'repository']);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      message: 'worker close failed',
    }));
  });
});
