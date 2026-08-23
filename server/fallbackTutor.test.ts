import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { FallbackTurnCoordinator, type FallbackEvent, type FallbackTurnRequest } from './fallbackTutor';
import { openTestDb } from './store/db';
import { Repo } from './store/repo';

function fixture() {
  const repo = new Repo(openTestDb());
  const child = repo.createChild('Maya', 10);
  const session = repo.createSession(child.id, 'Compare fractions');
  return { repo, session };
}

function request(sessionId: string, suffix: string): FallbackTurnRequest {
  return {
    sessionId,
    userText: `question ${suffix}`,
    idempotencyKey: `fallback-key-${suffix}`,
    connectionEpoch: 1,
    turnId: `turn-${suffix}`,
    generationId: `generation-${suffix}`,
  };
}

function client(create: (...args: unknown[]) => Promise<unknown>): OpenAI {
  return { chat: { completions: { create: vi.fn(create) } } } as unknown as OpenAI;
}

function answer(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text, tool_calls: [] } }] };
}

describe('fallback generation coordinator', () => {
  it('aborts a superseded provider request and rejects every late write', async () => {
    const { repo, session } = fixture();
    const coordinator = new FallbackTurnCoordinator(5_000);
    let olderSignal: AbortSignal | undefined;
    const provider = client(async (body, options) => {
      const user = (body as { messages: Array<{ role: string; content: string }> }).messages.findLast((entry) => entry.role === 'user')?.content;
      if (user?.includes('older')) {
        olderSignal = (options as { signal?: AbortSignal }).signal;
        await new Promise((resolve, reject) => {
          olderSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          setTimeout(resolve, 2_000);
        });
        return answer('older reply?');
      }
      return answer('newer reply?');
    });
    const oldEvents: FallbackEvent[] = [];
    const oldRun = coordinator.run(provider, 'gpt-5.6-terra', repo, request(session.id, 'older'), (event) => oldEvents.push(event));
    await vi.waitFor(() => expect(olderSignal).toBeDefined());
    const newEvents: FallbackEvent[] = [];
    await coordinator.run(provider, 'gpt-5.6-terra', repo, request(session.id, 'newer'), (event) => newEvents.push(event));
    await expect(oldRun).rejects.toMatchObject({ name: 'AbortError' });

    expect(olderSignal?.aborted).toBe(true);
    expect(oldEvents).toEqual([]);
    expect(newEvents.map((event) => event.type)).toContain('fallback_caption');
    expect(repo.listEvents(session.id).filter((event) => event.type === 'tutor_said').map((event) => (event.payload as { text: string }).text)).toEqual(['newer reply?']);
  });

  it('replays a completed idempotency key without duplicate learner, tutor, evidence, or scene writes', async () => {
    const { repo, session } = fixture();
    const coordinator = new FallbackTurnCoordinator();
    const provider = client(async () => answer('Let us compare them. Which is farther right?'));
    const turn = request(session.id, 'duplicate');
    const first: FallbackEvent[] = [];
    const second: FallbackEvent[] = [];
    expect(await coordinator.run(provider, 'gpt-5.6-terra', repo, turn, (event) => first.push(event))).toBe('completed');
    const before = repo.listEvents(session.id);
    expect(await coordinator.run(provider, 'gpt-5.6-terra', repo, turn, (event) => second.push(event))).toBe('replayed');

    expect(repo.listEvents(session.id)).toEqual(before);
    expect(second).toEqual(first);
    expect((provider.chat.completions.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('does not write when the request is aborted, the provider fails, or the session has ended', async () => {
    const abortedFixture = fixture();
    const abortController = new AbortController();
    const waiting = client(async (_body, options) => new Promise((_resolve, reject) => {
      (options as { signal: AbortSignal }).signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const abortedRun = new FallbackTurnCoordinator().run(
      waiting,
      'gpt-5.6-terra',
      abortedFixture.repo,
      request(abortedFixture.session.id, 'aborted'),
      () => {},
      abortController.signal,
    );
    abortController.abort('navigation cleanup');
    await expect(abortedRun).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedFixture.repo.listEvents(abortedFixture.session.id)).toEqual([]);

    const failedFixture = fixture();
    const failed = client(async () => { throw new Error('provider failed'); });
    await expect(new FallbackTurnCoordinator().run(failed, 'gpt-5.6-terra', failedFixture.repo, request(failedFixture.session.id, 'failed'), () => {})).rejects.toThrow('provider failed');
    expect(failedFixture.repo.listEvents(failedFixture.session.id)).toEqual([]);

    const endedFixture = fixture();
    endedFixture.repo.endSession(endedFixture.session.id, null);
    await expect(new FallbackTurnCoordinator().run(client(async () => answer('never')), 'gpt-5.6-terra', endedFixture.repo, request(endedFixture.session.id, 'ended'), () => {})).rejects.toThrow(/ended/i);
    expect(endedFixture.repo.listEvents(endedFixture.session.id)).toEqual([]);
  });

  it('uses semantic checkpoints and the orchestrator wait guard', async () => {
    const { repo, session } = fixture();
    let call = 0;
    const provider = client(async () => {
      call += 1;
      if (call === 1) return {
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
          id: 'visual-1', type: 'function', function: { name: 'semantic_visual_plan', arguments: JSON.stringify({
            schemaVersion: '1.0.0', planId: 'fractions-plan', intent: { objective: 'Compare fractions', domain: 'quantitative' },
            groups: [{ id: 'fraction-scale', label: 'Fraction number line', revealOrder: ['outline', 'label'], template: 'fraction_comparison', parameters: { values: [0.5, 0.75], labels: ['1/2', '3/4'] } }],
          }) },
        }] } }],
      };
      if (call === 2) return answer('The marks share one scale.');
      return answer('Which mark is farther right?');
    });
    const events: FallbackEvent[] = [];
    await new FallbackTurnCoordinator().run(provider, 'gpt-5.6-terra', repo, request(session.id, 'semantic'), (event) => events.push(event));

    expect(events.some((event) => event.type === 'board_ops' && event.visualCueId && event.semanticObjectId === 'fraction-scale')).toBe(true);
    expect(events.filter((event) => event.type === 'fallback_caption').map((event) => event.payload.text)).toEqual([
      'The marks share one scale.',
      'Which mark is farther right?',
    ]);
    expect(call).toBe(3);
  });

  it('rejects a stale scoped mutation after a newer claim', () => {
    const { repo, session } = fixture();
    const older = request(session.id, 'old-write');
    const newer = request(session.id, 'new-write');
    repo.claimFallbackTurn({ ...older, idempotencyKey: older.idempotencyKey });
    repo.claimFallbackTurn({ ...newer, idempotencyKey: newer.idempotencyKey });
    expect(() => repo.addFallbackEvent({ ...older, idempotencyKey: older.idempotencyKey }, 'tutor_said', { text: 'stale' })).toThrow(/stale/i);
    expect(repo.listEvents(session.id)).toEqual([]);
  });
});
