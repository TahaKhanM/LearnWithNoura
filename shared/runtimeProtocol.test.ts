import { describe, expect, it } from 'vitest';
import { createRuntimeEvent, RuntimeEventGate, type GenerationIdentity } from './runtimeProtocol';
import fc from 'fast-check';

const identity: GenerationIdentity = { sessionId: 'session-1', connectionEpoch: 2, turnId: 'turn-3', generationId: 'generation-4' };
// Deliberate high-workload contract: tolerate machine load while still detecting hangs.
const HEAVY_CONTRACT_TIMEOUT_MS = 15_000;

describe('runtime event protocol', () => {
  it('accepts only current monotonic events once', () => {
    const gate = new RuntimeEventGate(identity);
    const first = createRuntimeEvent(identity, 0, 'caption.cue', { text: 'hello' });
    expect(gate.accept(first)).toBe(true);
    expect(gate.accept(first)).toBe(false);
    expect(gate.accept(createRuntimeEvent(identity, 0, 'caption.cue', {}))).toBe(false);
    expect(gate.accept(createRuntimeEvent({ ...identity, generationId: 'stale' }, 1, 'caption.cue', {}))).toBe(false);
    expect(gate.accept(createRuntimeEvent(identity, 1, 'caption.cue', {}))).toBe(true);
  });

  it('rejects malformed envelopes and invalid audio offsets', () => {
    const gate = new RuntimeEventGate(identity);
    expect(gate.accept({ type: 'caption.cue' })).toBe(false);
    expect(() => createRuntimeEvent(identity, 0, 'audio.delta', {}, { audioSampleOffsets: { start: 5, end: 2 } })).toThrow();
  });

  it('has zero stale mutations across at least 1,000 reordered event sequences', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ sequence: fc.integer({ min: 0, max: 40 }), stale: fc.boolean() }), { minLength: 1, maxLength: 80 }),
      (items) => {
        const gate = new RuntimeEventGate(identity);
        let lastAccepted = -1;
        for (const item of items) {
          const eventIdentity = item.stale ? { ...identity, generationId: 'stale-generation' } : identity;
          const event = createRuntimeEvent(eventIdentity, item.sequence, 'mutation', {});
          if (gate.accept(event)) {
            expect(item.stale).toBe(false);
            expect(item.sequence).toBeGreaterThan(lastAccepted);
            lastAccepted = item.sequence;
          }
        }
      },
    ), { numRuns: 1000 });
  }, HEAVY_CONTRACT_TIMEOUT_MS);
});
