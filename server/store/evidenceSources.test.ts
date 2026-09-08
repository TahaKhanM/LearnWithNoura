import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { Pool } from 'pg';
import { openTestDb } from './db';
import type { DomainRepository } from './domain';
import { PostgresRepo } from './postgresRepo';
import { Repo, type EvidenceInput } from './repo';

const observation: EvidenceInput = {
  concept: 'fractions', observation: 'Compared two parts', verdict: 'progressing', confidence: 'medium',
};

const localSocket = process.env.NOURA_TEST_POSTGRES_SOCKET;
if (localSocket && !localSocket.startsWith('/tmp/noura-')) throw new Error('Evidence database tests require an explicit temporary local Unix socket.');
const localConfig = { host: localSocket, port: 55438, database: 'noura_evidence_test', user: 'noura_test' };
const adapters = ['sqlite', 'postgres', ...(localSocket ? ['local-postgres'] : [])];
for (const adapter of adapters) {
  describe(`${adapter} evidence source integrity`, () => {
    async function fixture() {
      const db = adapter === 'sqlite' ? openTestDb() : null;
      const pool = adapter === 'postgres' ? new (newDb().adapters.createPg().Pool)()
        : adapter === 'local-postgres' ? new Pool(localConfig) : null;
      const repo: DomainRepository = db ? new Repo(db) : new PostgresRepo(pool!);
      const child = await repo.createChild('Synthetic', 10, 'parent-a');
      const session = await repo.createSession(child.id, 'Fractions');
      return { repo, session, close: async () => { db?.close(); await pool?.end(); } };
    }

    it('rejects missing, foreign, non-integer and mixed valid/invalid source IDs without an excerpt', async () => {
      const { repo, session, close } = await fixture();
      try {
        const own = await repo.addEvent(session.id, 'learner_said', { text: 'one half' });
        const foreignChild = await repo.createChild('Other synthetic', 10, 'parent-b');
        const foreign = await repo.createSession(foreignChild.id, 'Geometry');
        const other = await repo.addEvent(foreign.id, 'learner_said', { text: 'private fixture' });
        for (const sourceEventIds of [[987654321], [other], [own, other], [own, 9999999], [-1], [1.5], [NaN]]) {
          await expect(async () => repo.addEvidence(session.id, { ...observation, sourceEventIds }))
            .rejects.toThrow(/source/i);
        }
        expect(await repo.listEvidence(session.id)).toEqual([]);
      } finally { await close(); }
    });

    it('validates every source even if one event matches the excerpt', async () => {
      const { repo, session, close } = await fixture();
      try {
        const own = await repo.addEvent(session.id, 'learner_said', { text: 'one half' });
        await expect(async () => repo.addEvidence(session.id, {
          ...observation, sourceEventIds: [own, 9999999], excerpt: 'one half',
        })).rejects.toThrow(/source/i);
      } finally { await close(); }
    });

    it('does not publish evidence from an unreleased scene', async () => {
      const { repo, session, close } = await fixture();
      try {
        const hidden = await repo.addEvent(session.id, 'semantic_scene', { text: 'one half' }, false);
        await expect(async () => repo.addEvidence(session.id, { ...observation, sourceEventIds: [hidden] }))
          .rejects.toThrow(/source|released/i);
        await repo.markEventReleased(session.id, hidden);
        expect((await repo.addEvidence(session.id, { ...observation, sourceEventIds: [hidden, hidden] })).sourceEventIds).toEqual([hidden]);
      } finally { await close(); }
    });

    it('stages only the matching fallback sources and releases them atomically', async () => {
      const { repo, session, close } = await fixture();
      try {
        const identity = { sessionId: session.id, idempotencyKey: 'fallback-key', connectionEpoch: 1, turnId: 'turn', generationId: 'generation' };
        await repo.claimFallbackTurn(identity);
        const source = await repo.addFallbackEvent(identity, 'learner_said', { text: 'one half' });
        const staged = await repo.addFallbackEvidence(identity, { ...observation, sourceEventIds: [source] });
        expect(await repo.listEvidenceForInternalAudit(session.id)).toHaveLength(1);
        expect(await repo.listEvidence(session.id)).toEqual([]);
        const unowned = await repo.addEvent(session.id, 'learner_said', { text: 'unrelated draft' }, false);
        await expect(async () => repo.addFallbackEvidence(identity, { ...observation, sourceEventIds: [unowned] }))
          .rejects.toThrow(/source|generation/i);
        await repo.finishFallbackTurn(identity, 'completed');
        expect((await repo.listEvidence(session.id)).map(row => row.evidenceId)).toEqual([staged.evidenceId]);
        expect((await repo.listEvents(session.id)).some(row => row.id === source)).toBe(true);
      } finally { await close(); }
    });

    it('does not stage evidence for an unacknowledged fallback visual', async () => {
      const { repo, session, close } = await fixture();
      try {
        const identity = { sessionId: session.id, idempotencyKey: 'fallback-key', connectionEpoch: 1, turnId: 'turn', generationId: 'generation' };
        await repo.claimFallbackTurn(identity);
        const hidden = await repo.addFallbackEvent(identity, 'semantic_scene', { text: 'one half' });
        await expect(async () => repo.addFallbackEvidence(identity, { ...observation, sourceEventIds: [hidden] }))
          .rejects.toThrow(/source|acknowledg/i);
        await repo.markFallbackEventReleased(identity, hidden);
        await repo.addFallbackEvidence(identity, { ...observation, sourceEventIds: [hidden] });
        await repo.finishFallbackTurn(identity, 'completed');
        expect(await repo.listEvidence(session.id)).toHaveLength(1);
      } finally { await close(); }
    });

    it('does not release staged events or evidence after the immutable end cutoff', async () => {
      const { repo, session, close } = await fixture();
      try {
        const identity = { sessionId: session.id, idempotencyKey: 'fallback-key', connectionEpoch: 1, turnId: 'turn', generationId: 'generation' };
        await repo.claimFallbackTurn(identity);
        const source = await repo.addFallbackEvent(identity, 'learner_said', { text: 'one half' });
        await repo.addFallbackEvidence(identity, { ...observation, sourceEventIds: [source] });
        await repo.endSession(session.id, null);
        expect(await repo.finishFallbackTurn(identity, 'completed')).toBe(false);
        expect(await repo.listEvents(session.id)).toEqual([]);
        expect(await repo.listEvidence(session.id)).toEqual([]);
      } finally { await close(); }
    });
  });
}


if (localSocket) {
  it('rejects an evidence write that races a committed Postgres session end', async () => {
    const writerPool = new Pool({ ...localConfig, application_name: 'noura-evidence-write-race' });
    const controlPool = new Pool(localConfig);
    const repo = new PostgresRepo(writerPool);
    const child = await repo.createChild('Synthetic race', 10, 'parent-race');
    const session = await repo.createSession(child.id, 'Fractions');
    const source = await repo.addEvent(session.id, 'learner_said', { text: 'one half' });
    const ending = await controlPool.connect();
    let result: Promise<string> | undefined;
    try {
      await ending.query('BEGIN');
      // Hold the same row modified by endSession, but delay COMMIT so the other
      // connection must serialize its active-session check against this end.
      await ending.query("UPDATE noura.sessions SET status = 'ended', ended_at = $1, ended_event_id = $2 WHERE id = $3", [Date.now(), source, session.id]);
      let settled = false;
      result = repo.addEvidence(session.id, { ...observation, sourceEventIds: [source] })
        .then(() => { settled = true; return 'stored'; }, () => { settled = true; return 'rejected'; });
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !settled; attempt++) {
        const status = await controlPool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = 'noura-evidence-write-race' AND wait_event_type = 'Lock'",
        );
        if (status.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked, 'the evidence writer must wait for the concurrent session end').toBe(true);
      await ending.query('COMMIT');
      expect(await result).toBe('rejected');
      expect(await repo.listEvidence(session.id)).toEqual([]);
      expect((await repo.getSession(session.id))?.status).toBe('ended');
    } finally {
      await ending.query('ROLLBACK');
      ending.release();
      await result;
      await writerPool.end();
      await controlPool.end();
    }
  });
}
