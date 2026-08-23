import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { PALETTE, type AddOp, type BoardOp, type Vec } from '../../shared/boardOps';
import type { GenerationIdentity } from '../../shared/runtimeProtocol';
import { emptyScene, describeScene, type SceneState } from '../board/scene';
import { BoardCanvas, type BoardAnimationRequest, type BoardHighlight, type BoardTool } from '../board/BoardCanvas';
import type { BoardAnimator } from '../board/animator';
import { BoardSceneCoordinator } from '../board/sceneCoordinator';
import { groupItemCount, sceneForGroup } from '../board/sceneGroups';
import { analyzeLearnerBoardChange, analysisFocusBox } from '../board/learnerSketch';
import { deriveSemanticViewports } from '../board/semanticViewport';
import { renderSceneImage } from '../board/snapshot';
import { RealtimeSession } from './realtimeSession';
import { LearnerDraftController } from './learnerDraft';
import { Avatar } from './Avatar';
import { attentionPriority, CharacterAttentionController, type AttentionTargetType } from './characterAttention';
import { centerForItemIds, centerForSemanticObject } from './attentionIntegration';
import type { VisualCueMetadata } from './realtimeSession';
import { useRouter } from '../routerContext';
import './Lesson.css';

interface LessonPageProps {
  sessionId: string;
}

interface SessionInfo {
  child: { id: string; name: string };
  session: { goal: string; status: string };
}

export function LessonPage({ sessionId }: LessonPageProps) {
  const { navigate } = useRouter();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [scene, setScene] = useState<SceneState>(emptyScene);
  const [highlights, setHighlights] = useState<BoardHighlight[]>([]);
  const [boardAnimation, setBoardAnimation] = useState<BoardAnimationRequest | null>(null);
  const [tool, setTool] = useState<BoardTool>('pointer');
  const [boardOverview, setBoardOverview] = useState(false);
  const [visualGroups, setVisualGroups] = useState<Array<{ id: string; label: string }>>([]);
  const [activeVisualGroupId, setActiveVisualGroupId] = useState<string | undefined>();
  const [focusIndex, setFocusIndex] = useState(0);
  const [penColor, setPenColor] = useState<string>(PALETTE.blue);
  const [draft, setDraft] = useState('');
  const [ending, setEnding] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [started, setStarted] = useState(false);
  const animator = useRef<BoardAnimator | null>(null);
  const boardState = useRef(new BoardSceneCoordinator());
  const visualChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const highlightNonce = useRef(0);
  const animationNonce = useRef(0);
  const boardSignalTimer = useRef<number | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const draftHintTimer = useRef<number | null>(null);
  const [draftHint, setDraftHint] = useState(false);
  const [boardActivity, setBoardActivity] = useState<'idle' | 'noura' | 'learner'>('idle');
  const [sectionNotice, setSectionNotice] = useState<{ id: string; label: string } | null>(null);
  const sectionNoticeTimer = useRef<number | null>(null);
  const activeVisualGroupRef = useRef<string | undefined>(undefined);
  const visualGroupsRef = useRef<Array<{ id: string; label: string }>>([]);

  const session = useMemo(() => new RealtimeSession(sessionId), [sessionId]);
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const draftController = useMemo(() => new LearnerDraftController(`noura.draft.${sessionId}`), [sessionId]);
  const draftSnap = useSyncExternalStore(draftController.subscribe, draftController.getSnapshot);
  const draftRef = useRef(draftController);
  draftRef.current = draftController;
  const attention = useMemo(
    () => new CharacterAttentionController(
      session.getIdentity(),
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    ),
    [session],
  );

  useEffect(() => {
    activeVisualGroupRef.current = activeVisualGroupId;
    visualGroupsRef.current = visualGroups;
  }, [activeVisualGroupId, visualGroups]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then((body: SessionInfo) => {
        if (!cancelled) setInfo(body);
      })
      .catch((err: Error) => {
        if (!cancelled) setInfoError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const registerVisualGroup = useCallback((cue?: VisualCueMetadata) => {
    if (!cue?.semanticObjectId) return;
    setVisualGroups((current) => current.some((group) => group.id === cue.semanticObjectId)
      ? current.map((group) => group.id === cue.semanticObjectId ? { ...group, label: cue.groupLabel ?? group.label } : group)
      : [...current, { id: cue.semanticObjectId as string, label: cue.groupLabel ?? cue.semanticObjectId as string }].slice(-12));
    if (activeVisualGroupRef.current === cue.semanticObjectId) return;
    // Only the first anchor section may take the view automatically. A later
    // section never silently hides what the learner is looking at: it is
    // announced and reachable, and the view switches only when the learner
    // (or an explicit navigation action) chooses it.
    if (!activeVisualGroupRef.current && !draftRef.current.isOpen) {
      activeVisualGroupRef.current = cue.semanticObjectId;
      setActiveVisualGroupId(cue.semanticObjectId);
      setFocusIndex(0);
      setBoardOverview(false);
      return;
    }
    setSectionNotice({ id: cue.semanticObjectId, label: cue.groupLabel ?? cue.semanticObjectId });
    if (sectionNoticeTimer.current !== null) window.clearTimeout(sectionNoticeTimer.current);
    sectionNoticeTimer.current = window.setTimeout(() => setSectionNotice(null), 12_000);
  }, []);

  const openSection = useCallback((groupId: string) => {
    activeVisualGroupRef.current = groupId;
    setActiveVisualGroupId(groupId);
    setFocusIndex(0);
    setBoardOverview(false);
    setSectionNotice((current) => current?.id === groupId ? null : current);
  }, []);

  const signalBoardActivity = useCallback((kind: 'noura' | 'learner', durationMs = 1_500) => {
    setBoardActivity(kind);
    if (boardSignalTimer.current !== null) window.clearTimeout(boardSignalTimer.current);
    boardSignalTimer.current = window.setTimeout(() => setBoardActivity('idle'), durationMs);
  }, []);

  const applyTutorOps = useCallback((ops: BoardOp[], animate: boolean, identity: GenerationIdentity, cue?: VisualCueMetadata) => {
    if (!animate) {
      const result = boardState.current.applyReplay(ops, 'tutor', cue?.semanticObjectId, cue?.replacesGroup);
      if (!result) return Promise.resolve(false);
      // Replays are already-committed board truth, never a new performance.
      animator.current?.finishAll();
      setBoardAnimation(null);
      setScene(result.scene);
      registerVisualGroup(cue);
      return Promise.resolve(true);
    }
    const transaction = visualChain.current.then(async () => {
      if (!sameIdentity(session.getIdentity(), identity)) return false;
      // The cue has crossed the heard-audio boundary, so it is now true on the
      // visible board. Promote it before animation; learner input and ordinary
      // re-renders must build on this state rather than an older checkpoint.
      const applied = boardState.current.applyTutorCheckpoint(ops, cue?.semanticObjectId, cue?.replacesGroup);
      if (!applied) return false;
      const candidate = applied.scene;
      const expectedGroup = cue?.semanticObjectId ?? activeVisualGroupRef.current;
      const visibleIds = new Set(sceneForGroup(candidate, expectedGroup).items.map((item) => item.id));
      // A section replacement is an atomic swap: the new content appears in
      // the same committed frame that retires the old, with no draw-on gap
      // during which the board would look blank.
      const animatedItemIds = cue?.replacesGroup ? [] : applied.added.filter((id) => visibleIds.has(id));
      const request: BoardAnimationRequest | null = animatedItemIds.length > 0 ? {
        id: `${identity.generationId}:${++animationNonce.current}`,
        itemIds: animatedItemIds,
      } : null;
      if (request) {
        animator.current?.beginTransaction(request.id);
        setBoardAnimation(request);
      }
      setScene(candidate);
      if (applied.highlighted.length > 0) {
        const center = centerForItemIds(candidate, applied.highlighted);
        if (center) offerAttention(attention, identity, 'focused_object', center);
        setHighlights(applied.highlighted.map((id) => ({ id, nonce: ++highlightNonce.current })));
        if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
        highlightTimer.current = window.setTimeout(() => setHighlights([]), 1_300);
      }
      if (cue?.semanticObjectId) {
        registerVisualGroup(cue);
        signalBoardActivity('noura');
        const center = centerForSemanticObject(candidate, cue.semanticObjectId);
        offerAttention(attention, identity, 'semantic_object', center, cue.semanticObjectId);
      }
      await nextPaint();
      // Completion acknowledges durable replay. It no longer decides whether
      // an already-visible checkpoint remains on screen.
      const completed = request
        ? await finishBoardAnimationWithin(animator.current, 3_600)
        : true;
      if (request) {
        setBoardAnimation((current) => current?.id === request.id ? null : current);
      }
      return completed;
    });
    visualChain.current = transaction.catch(() => false);
    return transaction;
  }, [session, attention, registerVisualGroup, signalBoardActivity]);

  useEffect(() => {
    session.onBoardOps = applyTutorOps;
    session.onLearnerBoardReplay = (ops, semanticGroupId) => {
      const result = boardState.current.applyReplay(ops, 'learner', semanticGroupId);
      if (!result) return;
      setScene(result.scene);
    };
    // Complete-plan preflight: the model only hears "accepted" for visuals
    // whose entire final scene compiles and passes quality checks offscreen.
    session.onVisualPreflight = (ops, semanticGroupId, replacesGroup) =>
      boardState.current.preflightTutorOps(ops, semanticGroupId, replacesGroup);
    session.onSubmissionResult = (submissionId, accepted, error) => {
      if (accepted) {
        draftRef.current.submitSucceeded();
        signalBoardActivity('learner', 1_800);
      } else {
        draftRef.current.submitFailed(error ?? 'Your drawing did not reach Noura. It is still on the board — press Done to try again.');
        // The drawing is still composable, so re-arm the server-side
        // "learner is drawing" guard for the retry.
        const draftId = draftRef.current.getSnapshot().draftId;
        if (draftId) session.notifyDraftState(true, draftId);
      }
      void submissionId;
    };
    session.onGenerationCancelled = (identity) => {
      // A checkpoint reaches this surface only after its audio cue is heard.
      // Finish that visible checkpoint instead of making it disappear.
      animator.current?.finishAll();
      setBoardAnimation(null);
      attention.cancelGeneration(identity);
      setHighlights([]);
    };
    session.onGenerationActivated = (identity, reason) => {
      attention.replaceGeneration(identity);
      offerAttention(attention, identity, reason === 'interruption' ? 'interruption' : 'neutral_learner');
    };
    session.onCaptionQuestion = (identity) => offerAttention(attention, identity, 'caption_question');
    return () => {
      session.end();
      if (boardSignalTimer.current !== null) window.clearTimeout(boardSignalTimer.current);
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
      if (draftHintTimer.current !== null) window.clearTimeout(draftHintTimer.current);
      if (sectionNoticeTimer.current !== null) window.clearTimeout(sectionNoticeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, applyTutorOps, attention]);

  useEffect(() => {
    attention.replaceGeneration(snap.identity);
    if (snap.phase === 'thinking') {
      const center = snap.lessonState.activeSemanticObjectId
        ? centerForSemanticObject(boardState.current.current, snap.lessonState.activeSemanticObjectId)
        : undefined;
      offerAttention(attention, snap.identity, 'semantic_object', center, snap.lessonState.activeSemanticObjectId);
    }
    else if (snap.phase === 'listening') offerAttention(attention, snap.identity, 'neutral_learner');
    else if (snap.phase === 'reconnecting' || snap.phase === 'failed') offerAttention(attention, snap.identity, 'neutral_learner');
  }, [attention, snap.identity, snap.phase, snap.lessonState.activeSemanticObjectId]);

  const begin = useCallback(async () => {
    if (!info || info.session.status !== 'active') return;
    setStarted(true);
    await session.start();
    // A reload never loses an unsubmitted drawing: restore the draft
    // locally and re-arm the server's "learner is composing" guard.
    const restored = draftRef.current.restore();
    if (restored) {
      const result = boardState.current.applyLearner(restored.ops, restored.semanticGroupId);
      setScene(result.scene);
      if (restored.semanticGroupId) openSection(restored.semanticGroupId);
      setTool('draw');
      session.notifyDraftState(true, restored.draftId);
    }
  }, [info, session, openSection]);

  /** Opens the draft on the first edit; later edits join the same draft. */
  const ensureDraftOpen = useCallback((): string => {
    const controller = draftRef.current;
    if (controller.isOpen && controller.getSnapshot().draftId) return controller.getSnapshot().draftId as string;
    const draftId = controller.begin({
      ...(session.getSnapshot().task?.taskId ? { taskId: session.getSnapshot().task?.taskId } : {}),
      ...(activeVisualGroupRef.current ? { semanticGroupId: activeVisualGroupRef.current } : {}),
    });
    session.notifyDraftState(true, draftId);
    return draftId;
  }, [session]);

  const handleLearnerStroke = useCallback(
    (points: Vec[]) => {
      ensureDraftOpen();
      const id = `sketch-${crypto.randomUUID()}`;
      const op: AddOp = { op: 'add', id, color: penColor, spec: { kind: 'path', points } };
      const result = boardState.current.applyLearner([op], activeVisualGroupId);
      setScene(result.scene);
      signalBoardActivity('learner', 1_800);
      const [x, y] = points[Math.floor(points.length / 2)];
      draftRef.current.addStroke(op, `a freehand stroke around (${Math.round(x)}, ${Math.round(y)})`);
    },
    [penColor, activeVisualGroupId, signalBoardActivity, ensureDraftOpen],
  );

  const handleLearnerErase = useCallback((id: string) => {
    // Erase follows the same draft lifecycle as drawing: it can interrupt,
    // it is undoable, and it is only shared when the learner presses Done.
    session.beginLearnerActivity();
    ensureDraftOpen();
    const existing = boardState.current.current.items.find((item) => item.id === id && item.owner === 'learner');
    const original: AddOp | null = existing && existing.spec.kind === 'path'
      ? { op: 'add', id: existing.id, spec: existing.spec, ...(existing.color ? { color: existing.color } : {}) }
      : null;
    const op: BoardOp = { op: 'erase', id };
    const result = boardState.current.applyLearner([op]);
    setScene(result.scene);
    draftRef.current.addErase(op, original, 'erased one of their own marks');
  }, [session, ensureDraftOpen]);

  const applyDraftOps = useCallback((ops: BoardOp[]) => {
    if (ops.length === 0) return;
    const result = boardState.current.applyLearner(ops, activeVisualGroupRef.current);
    setScene(result.scene);
  }, []);

  const undoDraft = useCallback(() => {
    const op = draftRef.current.undo();
    if (op) applyDraftOps([op]);
  }, [applyDraftOps]);

  const redoDraft = useCallback(() => {
    const op = draftRef.current.redo();
    if (op) applyDraftOps([op]);
  }, [applyDraftOps]);

  const clearDraft = useCallback(() => {
    applyDraftOps(draftRef.current.clear());
  }, [applyDraftOps]);

  const cancelDraft = useCallback(() => {
    const controller = draftRef.current;
    const draftId = controller.getSnapshot().draftId;
    applyDraftOps(controller.cancel());
    if (draftId) session.notifyDraftState(false, draftId);
  }, [applyDraftOps, session]);

  /**
   * Done: freeze exactly what is on the board now, render the canonical
   * revision-bound snapshot from immutable scene data, and send one
   * idempotent submission. Nothing was sent before this moment.
   */
  const submitDraft = useCallback(async () => {
    const controller = draftRef.current;
    const frozen = controller.beginSubmit();
    if (!frozen) return;
    const draftSnapshot = controller.getSnapshot();
    const semanticGroupId = draftSnapshot.semanticGroupId ?? activeVisualGroupRef.current;
    const submittedScene = boardState.current.current;
    const visible = sceneForGroup(submittedScene, semanticGroupId);
    const analysis = analyzeLearnerBoardChange(visible, frozen.ops, semanticGroupId);
    const imageDataUrl = await renderSceneImage(visible, { focusBox: analysisFocusBox(analysis) });
    const semanticGroupLabel = visualGroupsRef.current.find((group) => group.id === semanticGroupId)?.label;
    session.notifyDraftState(false, frozen.draftId);
    session.submitBoardSubmission({
      submissionId: frozen.submissionId,
      draftId: frozen.draftId,
      description: `${frozen.notes.join('; ')}. ${describeScene(visible)}`,
      ops: frozen.ops,
      analysis,
      imageDataUrl,
      baseBoardRevision: submittedScene.epoch,
      submittedBoardRevision: submittedScene.epoch,
      ...(draftSnapshot.taskId ? { taskId: draftSnapshot.taskId } : {}),
      ...(semanticGroupId ? { semanticGroupId } : {}),
      ...(semanticGroupLabel ? { semanticGroupLabel } : {}),
    });
  }, [session]);

  // A gentle reminder is allowed; auto-submission never is.
  useEffect(() => {
    if (draftHintTimer.current !== null) window.clearTimeout(draftHintTimer.current);
    setDraftHint(false);
    if (draftSnap.status === 'open' && draftSnap.entryCount > 0) {
      draftHintTimer.current = window.setTimeout(() => setDraftHint(true), 20_000);
    }
    return () => {
      if (draftHintTimer.current !== null) window.clearTimeout(draftHintTimer.current);
    };
  }, [draftSnap.status, draftSnap.entryCount]);

  const handleTutorPen = useCallback((position: { x: number; y: number } | null) => {
    if (position) offerAttention(attention, session.getIdentity(), 'tutor_pen', [position.x, position.y]);
  }, [attention, session]);

  const handleLearnerAttention = useCallback((position: Vec, kind: 'drawing' | 'pointer' | 'focus') => {
    const target = kind === 'drawing' ? 'learner_drawing' : kind === 'focus' ? 'focused_object' : 'learner_pointer';
    offerAttention(attention, session.getIdentity(), target, position);
  }, [attention, session]);

  const handleAnimatorReady = useCallback((value: BoardAnimator) => {
    animator.current = value;
  }, []);

  const submitText = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!draft.trim()) return;
      session.sendText(draft);
      setDraft('');
    },
    [draft, session],
  );

  const endLesson = useCallback(async () => {
    if (ending) return;
    setEnding(true);
    session.end();
    try {
      await fetch(`/api/sessions/${sessionId}/end`, { method: 'POST' });
    } catch {
      /* summary can fail without blocking the exit */
    }
    navigate(`/parent?session=${sessionId}${info ? `&selectedChildId=${encodeURIComponent(info.child.id)}` : ''}`);
  }, [ending, session, sessionId, navigate, info]);

  const continueLesson = useCallback(async () => {
    if (continuing) return;
    setContinuing(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/continue`, { method: 'POST' });
      const body = (await response.json()) as { session?: { id: string }; lessonCapability?: string };
      if (!response.ok || !body.session) throw new Error('continue failed');
      if (body.lessonCapability) window.sessionStorage.setItem(`noura.lessonCapability.${body.session.id}`, body.lessonCapability);
      navigate(`/lesson/${body.session.id}${info ? `?selectedChildId=${encodeURIComponent(info.child.id)}` : ''}`);
    } catch {
      setInfoError('Could not create a continuation lesson.');
      setContinuing(false);
    }
  }, [continuing, info, navigate, sessionId]);

  const lastChildLine = [...snap.captions].reverse().find((c) => c.role === 'child');
  const lastTutorLine = [...snap.captions].reverse().find((c) => c.role === 'tutor');
  const visibleScene = useMemo(() => sceneForGroup(scene, activeVisualGroupId), [scene, activeVisualGroupId]);
  const activeVisualGroup = visualGroups.find((group) => group.id === activeVisualGroupId);
  const semanticViewCount = deriveSemanticViewports(visibleScene, activeVisualGroupId).length;
  const activeBoardItemCount = groupItemCount(scene, activeVisualGroupId);
  const draftActive = draftSnap.status === 'open' || draftSnap.status === 'submitting' || draftSnap.status === 'error';

  const statusLabel =
    draftSnap.status === 'submitting'
      ? 'Sending your drawing…'
      : draftActive && draftSnap.entryCount > 0
        ? 'Drawing — press Done when you’re ready'
        : snap.phase === 'connecting'
          ? 'Waking Noura up…'
          : snap.phase === 'reconnecting'
            ? 'Reconnecting…'
            : snap.phase === 'thinking'
              ? 'Thinking…'
              : snap.phase === 'listening'
                ? snap.muted
                  ? 'Microphone muted — type below or unmute'
                  : snap.micDenied || !snap.micAvailable
                    ? 'Type below — Noura is ready'
                    : 'Listening — just talk, or interrupt any time'
                : snap.phase === 'speaking'
                  ? 'Speaking'
                  : snap.phase === 'fallback'
                    ? 'Text mode — voice is unavailable'
                    : '';

  if (infoError) {
    return (
      <div className="lesson lesson--error" id="main-content">
        <p>Could not open this lesson: {infoError}</p>
        <button className="lesson__button" onClick={() => navigate('/')}>Back home</button>
      </div>
    );
  }

  if (info?.session.status === 'ended') {
    return (
      <main className="lesson lesson--ended" id="main-content">
        <div className="lesson__ended-card">
          <Avatar phase="ended" voiceEnergy={0} micEnergy={0} />
          <p className="lesson__ended-eyebrow">Noura · lesson complete</p>
          <h1>This session is read-only.</h1>
          <p>{info.child.name}’s finished transcript and evidence will not change.</p>
          <div className="lesson__ended-actions">
            <button className="lesson__button" onClick={continueLesson} disabled={continuing}>{continuing ? 'Creating…' : 'Continue in a new session'}</button>
            <button className="lesson__secondary" onClick={() => navigate(`/parent?session=${sessionId}&selectedChildId=${encodeURIComponent(info.child.id)}`)}>Open Parent Area</button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className="lesson" id="main-content">
      <header className="lesson__bar">
        <span className="lesson__brand">Noura</span>
        {info && (
          <span className="lesson__goal" title={info.session.goal}>
            {info.child.name} · {info.session.goal}
          </span>
        )}
        {snap.lessonState.activeConcept && (
          <span className="lesson__concept" data-testid="active-concept">
            Now: {snap.lessonState.activeConcept}
          </span>
        )}
        {activeVisualGroup && (
          <span className={`lesson__board-context lesson__board-context--${boardActivity}`} role="status" aria-live="polite" aria-atomic="true">
            <span className="lesson__board-context-dot" aria-hidden="true" />
            <strong>Board</strong>
            <span>{activeVisualGroup.label}</span>
            <span className="lesson__board-context-activity">
              {boardActivity === 'noura' ? 'Noura is adding' : boardActivity === 'learner' ? 'Sharing your mark' : `${activeBoardItemCount} ${activeBoardItemCount === 1 ? 'object' : 'objects'}`}
            </span>
          </span>
        )}
        <span className="lesson__spacer" />
        <button className="lesson__end" onClick={endLesson} disabled={ending}>
          {ending ? 'Wrapping up…' : 'End lesson'}
        </button>
      </header>

      <main className="lesson__board">
        {started && snap.task && (
          <div className="lesson__task" data-testid="task-banner" role="status" aria-live="polite">
            <strong>
              {snap.task.responseMode === 'draw'
                ? 'Your turn — draw on the board'
                : snap.task.responseMode === 'mixed'
                  ? 'Your turn — draw and explain'
                  : 'Your turn'}
            </strong>
            <span className="lesson__task-prompt">{snap.task.prompt}</span>
            {snap.task.submitPolicy === 'explicit' && (
              <span className="lesson__task-hint">Press Done when you finish.</span>
            )}
          </div>
        )}
        <div className={`lesson__surface${boardOverview ? ' lesson__surface--overview' : ''}`}>
          <BoardCanvas
            scene={visibleScene}
            highlights={highlights}
            animationRequest={boardAnimation}
            tool={tool}
            penColor={penColor}
            interactive={started}
            onLearnerStroke={handleLearnerStroke}
            onLearnerErase={handleLearnerErase}
            onLearnerActivityStart={() => session.beginLearnerActivity()}
            onTutorPen={handleTutorPen}
            onLearnerAttention={handleLearnerAttention}
            longDescription={describeScene(visibleScene)}
            animatorRef={handleAnimatorReady}
            focusSemanticObjectId={activeVisualGroupId}
            focusIndex={focusIndex}
            overview={boardOverview}
          />
          {!started && (
            <div className="lesson__start">
              <Avatar phase="listening" voiceEnergy={0} micEnergy={0} attentionController={attention} />
              <h1>{info ? `Hi ${info.child.name} — tap Begin when you’re ready` : 'Preparing your lesson…'}</h1>
              {info && <p className="lesson__start-goal">Today: {info.session.goal}</p>}
              <button className="lesson__button lesson__button--big" onClick={begin} disabled={!info} data-testid="start-lesson">
                Begin
              </button>
              <p className="lesson__hint">
                This tap enables sound and asks for microphone permission. Noura can still teach by text if you choose not to use the microphone.
              </p>
            </div>
          )}
        </div>

        {started && (
          <div className="lesson__tools" role="toolbar" aria-label="Your pen">
            <button
              className="lesson__tool"
              aria-pressed={tool === 'pointer'}
              title="Just watch"
              aria-label="Pointer: watch the board"
              onClick={() => setTool('pointer')}
            >
              <svg viewBox="0 0 24 24"><path d="m5 3 14 7-6 2-2 6z" /></svg>
            </button>
            {visualGroups.length > 0 && (
              <label className="lesson__group-picker">
                <span>Board section</span>
                <select
                  aria-label="Board section"
                  value={activeVisualGroupId}
                  onChange={(event) => openSection(event.target.value)}
                >
                  {visualGroups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
                </select>
              </label>
            )}
            {activeVisualGroupId && !boardOverview && (
              <>
                <button className="lesson__tool lesson__pan-control" aria-label="Previous part of this board section" disabled={focusIndex <= 0} onClick={() => setFocusIndex((value) => Math.max(0, value - 1))}>
                  <svg viewBox="0 0 24 24"><path d="m15 5-7 7 7 7" /></svg>
                </button>
                <span className="lesson__part" data-testid="board-part">
                  Part {Math.min(focusIndex + 1, semanticViewCount)} of {semanticViewCount}
                </span>
                <button className="lesson__tool lesson__pan-control" aria-label="Next part of this board section" disabled={focusIndex >= semanticViewCount - 1} onClick={() => setFocusIndex((value) => Math.min(semanticViewCount - 1, value + 1))}>
                  <svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" /></svg>
                </button>
              </>
            )}
            <button
              className="lesson__tool lesson__overview-toggle"
              aria-pressed={boardOverview}
              aria-label={boardOverview ? 'Focus the active board area' : 'Fit the full board overview'}
              title={boardOverview ? 'Focus board' : 'Fit overview'}
              onClick={() => setBoardOverview((value) => !value)}
            >
              <svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5M9 9h6v6H9z" /></svg>
            </button>
            <button
              className="lesson__tool"
              aria-pressed={tool === 'draw'}
              title="Draw on the board"
              aria-label="Draw on the board"
              onClick={() => setTool('draw')}
            >
              <svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19zM14.5 6.5l3 3" /></svg>
            </button>
            <button
              className="lesson__tool"
              aria-pressed={tool === 'erase'}
              title="Erase your marks"
              aria-label="Erase your marks"
              onClick={() => setTool('erase')}
            >
              <svg viewBox="0 0 24 24"><path d="M7 20h10M5 15 15 5l4 4-8 8H7z" /></svg>
            </button>
            {tool === 'draw' && (
              <span className="lesson__colors">
                {[PALETTE.blue, PALETTE.red, PALETTE.green, PALETTE.amber].map((hex) => (
                  <button
                    key={hex}
                    className="lesson__color"
                    style={{ background: hex }}
                    aria-pressed={penColor === hex}
                    aria-label={`Pen colour ${hex}`}
                    onClick={() => setPenColor(hex)}
                  />
                ))}
              </span>
            )}
            {draftActive && (
              <span className="lesson__draft-controls" role="group" aria-label="Your drawing draft">
                <button
                  className="lesson__tool"
                  aria-label="Undo your last mark"
                  title="Undo"
                  disabled={!draftSnap.canUndo}
                  onClick={undoDraft}
                >
                  <svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
                </button>
                <button
                  className="lesson__tool"
                  aria-label="Redo your last undone mark"
                  title="Redo"
                  disabled={!draftSnap.canRedo}
                  onClick={redoDraft}
                >
                  <svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" /></svg>
                </button>
                <button
                  className="lesson__tool"
                  aria-label="Clear your draft"
                  title="Clear my draft"
                  disabled={draftSnap.entryCount === 0 || draftSnap.status === 'submitting'}
                  onClick={clearDraft}
                >
                  <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" /></svg>
                </button>
                <button
                  className="lesson__tool"
                  aria-label="Cancel your drawing"
                  title="Cancel drawing"
                  disabled={draftSnap.status === 'submitting'}
                  onClick={cancelDraft}
                >
                  <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>
                <button
                  className="lesson__done"
                  data-testid="draft-done"
                  disabled={draftSnap.entryCount === 0 || draftSnap.status === 'submitting'}
                  onClick={() => void submitDraft()}
                >
                  {draftSnap.status === 'submitting' ? 'Sending…' : 'Done'}
                </button>
              </span>
            )}
          </div>
        )}
        {started && (draftSnap.error || (draftHint && draftSnap.status === 'open')) && (
          <p className={`lesson__draft-note${draftSnap.error ? ' lesson__draft-note--error' : ''}`} role={draftSnap.error ? 'alert' : 'status'}>
            {draftSnap.error ?? 'Take your time — press Done when you’re ready.'}
          </p>
        )}
        {started && sectionNotice && (
          <p className="lesson__section-notice" role="status" data-testid="section-notice">
            Noura added a new board section: <strong>{sectionNotice.label}</strong>. Your current board stays put.
            <button className="lesson__section-open" onClick={() => openSection(sectionNotice.id)}>
              Open it
            </button>
          </p>
        )}
      </main>

      {started && (
        <footer className="lesson__dock">
          <Avatar phase={snap.phase} voiceEnergy={snap.voiceEnergy} micEnergy={snap.micEnergy} attentionController={attention} />

          <div className="lesson__dialogue" aria-live="polite">
            {lastChildLine && (
              <p className="lesson__child-line">{lastChildLine.text}</p>
            )}
            {lastTutorLine ? (
              <p className={`lesson__caption${lastTutorLine.live ? ' lesson__caption--live' : ''}`}>
                {lastTutorLine.text}
              </p>
            ) : (
              <p className="lesson__caption lesson__caption--placeholder">{statusLabel}</p>
            )}
            {lastTutorLine && <p className="lesson__status">{statusLabel}</p>}
            {snap.error && <p className="lesson__error">{snap.error}</p>}
            {snap.micDenied && (
              <p className="lesson__notice">
                The microphone is blocked, so Noura can’t hear you — but typing works.
              </p>
            )}
          </div>

          <div className="lesson__controls">
            {snap.micAvailable && !snap.micDenied && snap.phase !== 'fallback' && (
              <button
                className="lesson__mic"
                aria-pressed={!snap.muted}
                title={snap.muted ? 'Unmute your microphone' : 'Mute your microphone'}
                aria-label={snap.muted ? 'Unmute your microphone' : 'Mute your microphone'}
                onClick={() => session.setMuted(!snap.muted)}
              >
                {snap.muted ? (
                  <svg viewBox="0 0 24 24"><path d="M9 5a3 3 0 0 1 6 0v5m-1.5 4.6A3 3 0 0 1 9 12v-1M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" /></svg>
                )}
              </button>
            )}
            <form className="lesson__ask" onSubmit={submitText}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={snap.phase === 'fallback' ? 'Type to Noura…' : 'Or type a question…'}
                aria-label="Type to Noura"
              />
              <button type="submit" disabled={!draft.trim()}>Ask</button>
            </form>
          </div>
        </footer>
      )}
    </div>
  );
}

function sameIdentity(left: GenerationIdentity, right: GenerationIdentity): boolean {
  return left.sessionId === right.sessionId &&
    left.connectionEpoch === right.connectionEpoch &&
    left.turnId === right.turnId &&
    left.generationId === right.generationId;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function offerAttention(
  controller: CharacterAttentionController,
  identity: GenerationIdentity,
  targetType: AttentionTargetType,
  boardCoordinates?: [number, number],
  semanticObjectId?: string,
): void {
  const now = performance.now();
  controller.offer({
    ...identity,
    targetType,
    ...(boardCoordinates ? { boardCoordinates } : {}),
    ...(semanticObjectId ? { semanticObjectId } : {}),
    priority: attentionPriority(targetType),
    startTime: now,
    expiryTime: now + (targetType === 'semantic_object' ? 3_000 : targetType === 'interruption' ? 900 : targetType.includes('learner') || targetType === 'focused_object' || targetType === 'caption_question' ? 700 : 420),
    smoothingProfile: targetType === 'interruption' ? 'immediate' : targetType === 'learner_pointer' ? 'gentle' : 'responsive',
    permittedInReducedMotion: ['interruption', 'semantic_object', 'neutral_learner', 'focused_object'].includes(targetType),
  });
}

function finishBoardAnimationWithin(boardAnimator: BoardAnimator | null, timeoutMs: number): Promise<boolean> {
  if (!boardAnimator) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      boardAnimator.finishAll();
      settled = true;
      resolve(true);
    }, timeoutMs);
    void boardAnimator.whenIdle().then((completed) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(completed);
    });
  });
}
