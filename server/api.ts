import { Router, type Request } from 'express';
import type OpenAI from 'openai';
import type { Repo } from './store/repo.js';
import { summarizeSession } from './summary.js';

/**
 * REST surface for the home screen, lesson lifecycle, and parent
 * dashboard. Everything here reads the same store the realtime proxy
 * writes, so the parent sees exactly what the lesson recorded.
 */

export interface ApiSecurity {
  parentId(request: Request): string | null;
  issueLessonCapability?(sessionId: string, childId: string, parentId: string): string;
}

const LOCAL_SECURITY: ApiSecurity = { parentId: () => 'local-synthetic-parent' };

export function createApi(
  repo: Repo,
  openai: OpenAI | null,
  summaryModel: string,
  security: ApiSecurity = LOCAL_SECURITY,
): Router {
  const router = Router();

  const parent = (request: Request): string | null => security.parentId(request);

  router.get('/config', (_req, res) => {
    const deploymentMode = process.env.NOURA_DEPLOYMENT_MODE ?? 'local-synthetic';
    const durableStorage = deploymentMode === 'local-synthetic';
    res.json({
      realtime: Boolean(process.env.OPENAI_API_KEY),
      lessonsAvailable: Boolean(process.env.OPENAI_API_KEY) && durableStorage,
      durableStorage,
      deploymentMode,
      syntheticOnly: process.env.NOURA_SYNTHETIC_ONLY !== 'false',
    });
  });

  router.get('/children', (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const children = repo.listChildren(parentId).map((child) => {
      const sessions = repo.listSessions(child.id);
      return {
        ...child,
        sessionCount: sessions.length,
        lastSession: sessions[0]
          ? { id: sessions[0].id, goal: sessions[0].goal, startedAt: sessions[0].startedAt, status: sessions[0].status }
          : null,
      };
    });
    res.json({ children });
  });

  router.post('/children', (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const { name, age } = req.body as { name?: unknown; age?: unknown };
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 60) : '';
    if (!cleanName) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const cleanAge =
      typeof age === 'number' && Number.isFinite(age) && age >= 3 && age <= 18
        ? Math.round(age)
        : null;
    res.status(201).json({ child: repo.createChild(cleanName, cleanAge, parentId) });
  });

  router.post('/sessions', (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const { childId, goal } = req.body as { childId?: unknown; goal?: unknown };
    const child = typeof childId === 'string' ? repo.getChildForParent(childId, parentId) : null;
    const cleanGoal = typeof goal === 'string' ? goal.trim().slice(0, 200) : '';
    if (!child) {
      res.status(404).json({ error: 'learner not found' });
      return;
    }
    if (!cleanGoal) {
      res.status(400).json({ error: 'goal is required' });
      return;
    }
    const session = repo.createSession(child.id, cleanGoal);
    res.status(201).json({
      session,
      ...(security.issueLessonCapability
        ? { lessonCapability: security.issueLessonCapability(session.id, child.id, parentId) }
        : {}),
    });
  });

  router.get('/sessions/:id', (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const session = repo.getSessionForParent(req.params.id, parentId);
    if (!session) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const child = repo.getChild(session.childId);
    res.json({
      session,
      child,
      evidence: repo.listEvidence(session.id),
      events: repo
        .listEvents(session.id, 1000)
        .filter((e) => ['tutor_said', 'learner_said', 'interrupted', 'lesson_state', 'evidence'].includes(e.type)),
    });
  });

  router.post('/sessions/:id/end', async (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const session = repo.getSessionForParent(req.params.id, parentId);
    if (!session) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const ended = session.status === 'ended' ? session : repo.endSession(session.id, null);
    if (!ended) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!ended.summary && openai) {
      try {
        const summary = await summarizeSession(openai, summaryModel, repo, session.id);
        if (summary) repo.setSessionSummary(session.id, summary, (ended.summaryVersion ?? 0) + 1);
      } catch (err) {
        console.error('Summary generation failed:', err);
      }
    }
    res.json({ session: repo.getSession(session.id) });
  });

  router.post('/sessions/:id/continue', (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const session = repo.getSessionForParent(req.params.id, parentId);
    if (!session) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (session.status !== 'ended') {
      res.status(409).json({ error: 'Only an ended lesson can be continued.' });
      return;
    }
    const continued = repo.createContinuation(session.id);
    res.status(201).json({
      session: continued,
      ...(security.issueLessonCapability
        ? { lessonCapability: security.issueLessonCapability(continued.id, continued.childId, parentId) }
        : {}),
    });
  });

  router.get('/children/:id/overview', (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const child = repo.getChildForParent(req.params.id, parentId);
    if (!child) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const sessions = repo.listSessions(child.id);
    res.json({
      child,
      sessions,
      evidence: repo.listEvidenceForChild(child.id),
    });
  });

  return router;
}
