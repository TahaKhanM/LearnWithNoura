import { Router } from 'express';
import type OpenAI from 'openai';
import type { Repo } from './store/repo';
import { summarizeSession } from './summary';

/**
 * REST surface for the home screen, lesson lifecycle, and parent
 * dashboard. Everything here reads the same store the realtime proxy
 * writes, so the parent sees exactly what the lesson recorded.
 */

export function createApi(repo: Repo, openai: OpenAI | null, summaryModel: string): Router {
  const router = Router();

  router.get('/config', (_req, res) => {
    res.json({ realtime: Boolean(process.env.OPENAI_API_KEY) });
  });

  router.get('/children', (_req, res) => {
    const children = repo.listChildren().map((child) => {
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
    res.json({ child: repo.createChild(cleanName, cleanAge) });
  });

  router.post('/sessions', (req, res) => {
    const { childId, goal } = req.body as { childId?: unknown; goal?: unknown };
    const child = typeof childId === 'string' ? repo.getChild(childId) : null;
    const cleanGoal = typeof goal === 'string' ? goal.trim().slice(0, 200) : '';
    if (!child) {
      res.status(400).json({ error: 'childId is required' });
      return;
    }
    if (!cleanGoal) {
      res.status(400).json({ error: 'goal is required' });
      return;
    }
    const session = repo.createSession(child.id, cleanGoal);
    res.json({ session });
  });

  router.get('/sessions/:id', (req, res) => {
    const session = repo.getSession(req.params.id);
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
    const session = repo.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (session.status === 'ended') {
      res.json({ session });
      return;
    }
    let summary = null;
    if (openai) {
      try {
        summary = await summarizeSession(openai, summaryModel, repo, session.id);
      } catch (err) {
        console.error('Summary generation failed:', err);
      }
    }
    repo.endSession(session.id, summary);
    res.json({ session: repo.getSession(session.id) });
  });

  router.get('/children/:id/overview', (req, res) => {
    const child = repo.getChild(req.params.id);
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
