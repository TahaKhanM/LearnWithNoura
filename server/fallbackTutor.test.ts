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

function toolRound(name: string, args: Record<string, unknown>, content = 'First provisional sentence.') {
  return { choices: [{ message: { role: 'assistant', content, tool_calls: [{
    id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] } }] };
}

const teachingMove = {
  rationale: 'A short deterministic test move.', microObjective: 'Compare fractions', strategy: 'Use one shared scale.',
  childFacingText: 'Compare the two marks.', questionOrTask: 'Which is farther right?', taskId: 'compare-task', proposedAction: 'question',
};

const semanticPlan = {
  schemaVersion: '1.0.0', planId: 'fractions-plan', intent: { objective: 'Compare fractions', domain: 'quantitative' },
  groups: [{ id: 'fraction-scale', label: 'Fraction number line', revealOrder: ['outline', 'label'], template: 'fraction_comparison', parameters: { values: [0.5, 0.75], labels: ['1/2', '3/4'] } }],
};

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

  it.each([
    ['assistant content', 'propose_teaching_move', teachingMove],
    ['semantic checkpoint', 'semantic_visual_plan', semanticPlan],
    ['lesson state', 'propose_teaching_move', teachingMove],
    ['evidence', 'record_evidence', {
      concept: 'fraction comparison', observation: 'The learner compared the marks.', verdict: 'progressing', classification: 'correct',
      confidence: 'medium', confidence_basis: 'Deterministic fixture.', task_id: 'compare-task', opportunity_kind: 'application', excerpt: 'question',
    }],
  ])('keeps provider failure after %s out of committed APIs', async (_label, toolName, args) => {
    const { repo, session } = fixture();
    let round = 0;
    const provider = client(async () => {
      round += 1;
      if (round === 1) return toolRound(String(toolName), args as Record<string, unknown>);
      throw new Error('provider failed mid-turn');
    });
    const streamed: FallbackEvent[] = [];
    await expect(new FallbackTurnCoordinator().run(provider, 'gpt-5.6-terra', repo, request(session.id, `failure-${toolName}`), (event) => streamed.push(event))).rejects.toThrow('provider failed mid-turn');

    expect(streamed.length).toBeGreaterThan(0);
    expect(repo.listEvents(session.id)).toEqual([]);
    expect(repo.listEvidence(session.id)).toEqual([]);
    const stagedEvents = repo.listEventsForInternalAudit(session.id);
    expect(stagedEvents.length).toBeGreaterThan(0);
    expect(stagedEvents.every((event) => !event.released)).toBe(true);
    if (toolName === 'record_evidence') expect(repo.listEvidenceForInternalAudit(session.id)).toHaveLength(1);
  });

  it('keeps partial output hidden after abort, supersession, and session end', async () => {
    async function partialThenWait(signal: AbortSignal): Promise<unknown> {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      return answer('unreachable');
    }

    const aborted = fixture();
    let abortRound = 0;
    const abortController = new AbortController();
    const abortProvider = client(async (_body, options) => {
      abortRound += 1;
      if (abortRound === 1) return toolRound('propose_teaching_move', teachingMove);
      return partialThenWait((options as { signal: AbortSignal }).signal);
    });
    const abortedRun = new FallbackTurnCoordinator().run(abortProvider, 'gpt-5.6-terra', aborted.repo, request(aborted.session.id, 'partial-abort'), () => {}, abortController.signal);
    await vi.waitFor(() => expect(abortRound).toBe(2));
    abortController.abort('navigation');
    await expect(abortedRun).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted.repo.listEvents(aborted.session.id)).toEqual([]);

    const superseded = fixture();
    const coordinator = new FallbackTurnCoordinator();
    let olderRound = 0;
    const supersedeProvider = client(async (body, options) => {
      const user = (body as { messages: Array<{ role: string; content: string }> }).messages.findLast((entry) => entry.role === 'user')?.content;
      if (user?.includes('older')) {
        olderRound += 1;
        if (olderRound === 1) return toolRound('propose_teaching_move', teachingMove, 'Old provisional sentence.');
        return partialThenWait((options as { signal: AbortSignal }).signal);
      }
      return answer('New committed sentence?');
    });
    const oldRun = coordinator.run(supersedeProvider, 'gpt-5.6-terra', superseded.repo, request(superseded.session.id, 'older'), () => {});
    await vi.waitFor(() => expect(olderRound).toBe(2));
    await coordinator.run(supersedeProvider, 'gpt-5.6-terra', superseded.repo, request(superseded.session.id, 'newer'), () => {});
    await expect(oldRun).rejects.toMatchObject({ name: 'AbortError' });
    expect(superseded.repo.listEvents(superseded.session.id).map((event) => (event.payload as { text?: string }).text).filter(Boolean)).toEqual(['question newer', 'New committed sentence?']);

    const ended = fixture();
    let endRound = 0;
    let releaseSecond!: () => void;
    const endProvider = client(async () => {
      endRound += 1;
      if (endRound === 1) return toolRound('propose_teaching_move', teachingMove);
      await new Promise<void>((resolve) => { releaseSecond = resolve; });
      return answer('Too late?');
    });
    const endedRun = new FallbackTurnCoordinator().run(endProvider, 'gpt-5.6-terra', ended.repo, request(ended.session.id, 'partial-end'), () => {});
    await vi.waitFor(() => expect(endRound).toBe(2));
    ended.repo.endSession(ended.session.id, null);
    releaseSecond();
    await expect(endedRun).rejects.toThrow();
    expect(ended.repo.listEvents(ended.session.id)).toEqual([]);
    expect(ended.repo.listEvidence(ended.session.id)).toEqual([]);
  });

  it('uses semantic checkpoints and never injects a question after a plain explanation', async () => {
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
      return answer('The marks share one scale.');
    });
    const events: FallbackEvent[] = [];
    await new FallbackTurnCoordinator().run(provider, 'gpt-5.6-terra', repo, request(session.id, 'semantic'), (event) => events.push(event));

    expect(events.some((event) => event.type === 'board_ops' && event.visualCueId && event.semanticObjectId === 'fraction-scale')).toBe(true);
    // The explanation is allowed to end without a forced question; the turn
    // simply waits for the learner.
    expect(events.filter((event) => event.type === 'fallback_caption').map((event) => event.payload.text)).toEqual([
      'The marks share one scale.',
    ]);
    expect(events.some((event) => event.type === 'safe_question')).toBe(false);
    expect(call).toBe(2);
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

  it('promotes evidence by exact idempotency key even if a retry reuses turn and generation identity', () => {
    const { repo, session } = fixture();
    const base = request(session.id, 'same-identity');
    const oldIdentity = { ...base, idempotencyKey: 'old-idempotency-key' };
    const newIdentity = { ...base, idempotencyKey: 'new-idempotency-key' };
    repo.claimFallbackTurn(oldIdentity);
    const oldSource = repo.addFallbackEvent(oldIdentity, 'learner_said', { text: 'old staged answer' });
    repo.addFallbackEvidence(oldIdentity, {
      concept: 'fractions', observation: 'old staged evidence', verdict: 'progressing', confidence: 'low', sourceEventIds: [oldSource],
    });
    repo.finishFallbackTurn(oldIdentity, 'failed');

    repo.claimFallbackTurn(newIdentity);
    const newSource = repo.addFallbackEvent(newIdentity, 'learner_said', { text: 'new committed answer' });
    repo.addFallbackEvidence(newIdentity, {
      concept: 'fractions', observation: 'new committed evidence', verdict: 'progressing', confidence: 'medium', sourceEventIds: [newSource],
    });
    repo.finishFallbackTurn(newIdentity, 'completed', []);

    expect(repo.listEvidence(session.id).map((entry) => entry.observation)).toEqual(['new committed evidence']);
    expect(repo.listEvidenceForInternalAudit(session.id)).toHaveLength(2);
  });
});
