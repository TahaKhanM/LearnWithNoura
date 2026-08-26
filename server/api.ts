import { Router, type Request } from 'express';
import type OpenAI from 'openai';
import { CompiledLessonSchema, type CompiledLessonRecord } from '../shared/compiledLesson.js';
import type { DomainRepository } from './store/domain.js';
import { createFixtureCompilationService, type LessonCompilationService } from './lesson/compilationService.js';
import { readRuntimeConfig, type RuntimeConfig } from './runtimeConfig.js';
import { summarizeSession } from './summary.js';
import {
  SESSION_TELEMETRY_LOG_EVENT_LIMIT,
  buildSessionTelemetryLog,
} from './session/sessionLog.js';

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

/** The compilation view a session response carries; null means a legacy
 * session created before compiled lessons existed. */
function compilationView(record: CompiledLessonRecord | null) {
  if (!record) return null;
  return {
    status: record.status,
    objective: record.lesson?.objective ?? null,
    failureReason: record.status === 'failed' ? record.failureReason : null,
  };
}

export function createApi(
  repo: DomainRepository,
  openai: OpenAI | null,
  summaryModel: string,
  security: ApiSecurity = LOCAL_SECURITY,
  runtime: RuntimeConfig = readRuntimeConfig(),
  // The default keeps unit tests self-contained; app.ts always wires the
  // service explicitly, and production readiness forbids running without a
  // configured provider, so the fixture service cannot reach production.
  compilation: LessonCompilationService = createFixtureCompilationService(repo),
): Router {
  const router = Router();

  const parent = (request: Request): string | null => security.parentId(request);

  async function startCompilation(sessionId: string, goal: string, objective: string, child: { name: string; age: number | null }): Promise<CompiledLessonRecord> {
    try {
      return await compilation.start({ sessionId, goal, objective, learnerName: child.name, learnerAge: child.age });
    } catch (error) {
      console.error('Lesson compilation could not start:', error);
      return repo.upsertCompiledLesson(sessionId, {
        status: 'failed',
        failureReason: 'Lesson preparation could not start. Try creating the lesson again.',
      });
    }
  }

  router.get('/config', (_req, res) => {
    const durableStorage = runtime.deploymentMode === 'local-synthetic' || runtime.durableStorageConfigured;
    res.json({
      realtime: runtime.providerConfigured,
      lessonsAvailable: runtime.providerConfigured && durableStorage,
      durableStorage,
      deploymentMode: runtime.deploymentMode,
      syntheticOnly: runtime.syntheticOnly,
    });
  });

  router.get('/children', async (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const childRows = await repo.listChildren(parentId);
    const children = await Promise.all(childRows.map(async (child) => {
      const sessions = await repo.listSessions(child.id);
      return {
        ...child,
        sessionCount: sessions.length,
        lastSession: sessions[0]
          ? { id: sessions[0].id, goal: sessions[0].goal, startedAt: sessions[0].startedAt, status: sessions[0].status }
          : null,
      };
    }));
    res.json({ children });
  });

  router.post('/children', async (req, res) => {
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
    res.status(201).json({ child: await repo.createChild(cleanName, cleanAge, parentId) });
  });

  router.post('/sessions', async (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const { childId, goal, objective } = req.body as { childId?: unknown; goal?: unknown; objective?: unknown };
    const child = typeof childId === 'string' ? await repo.getChildForParent(childId, parentId) : null;
    const cleanGoal = typeof goal === 'string' ? goal.trim().slice(0, 200) : '';
    if (!child) {
      res.status(404).json({ error: 'learner not found' });
      return;
    }
    if (!cleanGoal) {
      res.status(400).json({ error: 'goal is required' });
      return;
    }
    // Either the parent already confirmed a candidate objective, or the goal
    // is normalized now: a concrete goal compiles directly; a vague one
    // returns candidates and no session is created until the second call.
    let cleanObjective = typeof objective === 'string' ? objective.trim().slice(0, 240) : '';
    if (!cleanObjective) {
      try {
        const normalized = await compilation.normalize({ goal: cleanGoal, learnerName: child.name, learnerAge: child.age });
        if (normalized.kind === 'candidates') {
          res.json({ goal: cleanGoal, candidates: normalized.candidates });
          return;
        }
        cleanObjective = normalized.objective;
      } catch (error) {
        console.error('Goal normalization failed:', error);
        res.status(502).json({ error: 'Noura could not prepare this lesson right now. Try again in a moment.' });
        return;
      }
    }
    const session = await repo.createSession(child.id, cleanGoal);
    const record = await startCompilation(session.id, cleanGoal, cleanObjective, child);
    res.status(201).json({
      session,
      compilation: compilationView(record),
      ...(security.issueLessonCapability
        ? { lessonCapability: security.issueLessonCapability(session.id, child.id, parentId) }
        : {}),
    });
  });

  router.get('/sessions/:id', async (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const session = await repo.getSessionForParent(req.params.id, parentId);
    if (!session) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const child = await repo.getChild(session.childId);
    const evidence = await repo.listEvidence(session.id);
    const events = await repo.listEvents(session.id, 1000);
    const compiled = await repo.getCompiledLesson(session.id);
    res.json({
      session,
      child,
      compilation: compilationView(compiled),
      evidence,
      events: events
        .filter((e) => ['tutor_said', 'learner_said', 'interrupted', 'lesson_state', 'evidence'].includes(e.type)),
    });
  });

  router.get('/sessions/:id/log', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parentId = parent(req);
    if (!parentId) {
      res.status(401).json({ error: 'Parent authentication required.' });
      return;
    }
    const session = await repo.getSessionForParent(req.params.id, parentId);
    if (!session) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const events = await repo.listEvents(session.id, SESSION_TELEMETRY_LOG_EVENT_LIMIT);
    res.json(buildSessionTelemetryLog(
      session.id,
      events,
      SESSION_TELEMETRY_LOG_EVENT_LIMIT,
    ));
  });

  router.post('/sessions/:id/end', async (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const session = await repo.getSessionForParent(req.params.id, parentId);
    if (!session) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const ended = session.status === 'ended' ? session : await repo.endSession(session.id, null);
    if (!ended) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!ended.summary && openai) {
      try {
        const summary = await summarizeSession(openai, summaryModel, repo, session.id);
        if (summary) await repo.setSessionSummary(session.id, summary, (ended.summaryVersion ?? 0) + 1);
      } catch (err) {
        console.error('Summary generation failed:', err);
      }
    }
    res.json({ session: await repo.getSession(session.id) });
  });

  router.post('/sessions/:id/continue', async (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const session = await repo.getSessionForParent(req.params.id, parentId);
    if (!session) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (session.status !== 'ended') {
      res.status(409).json({ error: 'Only an ended lesson can be continued.' });
      return;
    }
    const continued = await repo.createContinuation(session.id);
    const parentCompiled = await repo.getCompiledLesson(session.id);
    let record: CompiledLessonRecord | null = null;
    if (parentCompiled?.status === 'ready' && parentCompiled.lesson) {
      // A continuation reuses the already-validated lesson, re-keyed to the
      // new session and restarted at the first stage.
      const lesson = CompiledLessonSchema.parse({
        ...parentCompiled.lesson,
        compiledLessonId: `compiled-${continued.id}`,
        blueprint: {
          ...parentCompiled.lesson.blueprint,
          blueprintId: `blueprint-${continued.id}`,
          currentStageIndex: 0,
          detourStack: [],
        },
      });
      record = await repo.upsertCompiledLesson(continued.id, { status: 'ready', lesson });
    } else {
      const child = await repo.getChild(continued.childId);
      record = await startCompilation(
        continued.id,
        continued.goal,
        parentCompiled?.lesson?.objective ?? continued.goal,
        child ?? { name: '', age: null },
      );
    }
    res.status(201).json({
      session: continued,
      compilation: compilationView(record),
      ...(security.issueLessonCapability
        ? { lessonCapability: security.issueLessonCapability(continued.id, continued.childId, parentId) }
        : {}),
    });
  });

  router.get('/children/:id/overview', async (req, res) => {
    const parentId = parent(req);
    if (!parentId) { res.status(401).json({ error: 'Parent authentication required.' }); return; }
    const child = await repo.getChildForParent(req.params.id, parentId);
    if (!child) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const sessions = await repo.listSessions(child.id);
    const evidence = await repo.listEvidenceForChild(child.id);
    res.json({
      child,
      sessions,
      evidence,
    });
  });

  return router;
}
