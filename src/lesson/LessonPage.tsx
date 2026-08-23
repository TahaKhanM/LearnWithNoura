import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { PALETTE, type BoardOp, type Vec } from '../../shared/boardOps';
import { applyOps, emptyScene, describeScene, type SceneState } from '../board/scene';
import { BoardCanvas, type BoardHighlight, type BoardTool } from '../board/BoardCanvas';
import type { BoardAnimator } from '../board/animator';
import { RealtimeSession } from './realtimeSession';
import { Avatar } from './Avatar';
import { useRouter } from '../router';
import './Lesson.css';

interface LessonPageProps {
  sessionId: string;
}

interface SessionInfo {
  child: { name: string };
  session: { goal: string; status: string };
}

export function LessonPage({ sessionId }: LessonPageProps) {
  const { navigate } = useRouter();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [scene, setScene] = useState<SceneState>(emptyScene);
  const [highlights, setHighlights] = useState<BoardHighlight[]>([]);
  const [tool, setTool] = useState<BoardTool>('pointer');
  const [penColor, setPenColor] = useState<string>(PALETTE.blue);
  const [draft, setDraft] = useState('');
  const [ending, setEnding] = useState(false);
  const [started, setStarted] = useState(false);
  const animator = useRef<BoardAnimator | null>(null);
  const sceneRef = useRef<SceneState>(emptyScene);
  const highlightNonce = useRef(0);
  const boardEventTimer = useRef<number | null>(null);
  const pendingBoardNote = useRef<string[]>([]);

  const session = useMemo(() => new RealtimeSession(sessionId), [sessionId]);
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

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

  const applyTutorOps = useCallback((ops: BoardOp[], animate: boolean) => {
    const result = applyOps(sceneRef.current, ops, 'tutor');
    sceneRef.current = result.scene;
    setScene(result.scene);
    if (result.highlighted.length > 0) {
      setHighlights(
        result.highlighted.map((id) => ({ id, nonce: ++highlightNonce.current })),
      );
    }
    if (!animate) {
      requestAnimationFrame(() => animator.current?.finishAll());
    }
  }, []);

  useEffect(() => {
    session.onBoardOps = applyTutorOps;
    return () => {
      session.end();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Interruption must also stop in-flight drawing instantly.
  useEffect(() => {
    if (snap.phase === 'listening') animator.current?.finishAll();
  }, [snap.phase]);

  const begin = useCallback(async () => {
    setStarted(true);
    await session.start();
  }, [session]);

  const handleLearnerStroke = useCallback(
    (points: Vec[]) => {
      const id = `sketch-${Date.now().toString(36)}`;
      const result = applyOps(
        sceneRef.current,
        [{ op: 'add', id, color: penColor, spec: { kind: 'path', points } }],
        'learner',
      );
      sceneRef.current = result.scene;
      setScene(result.scene);
      const [x, y] = points[Math.floor(points.length / 2)];
      pendingBoardNote.current.push(
        `a freehand stroke around (${Math.round(x)}, ${Math.round(y)})`,
      );
      scheduleBoardNote();
    },
    [penColor], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleLearnerErase = useCallback((id: string) => {
    const result = applyOps(sceneRef.current, [{ op: 'erase', id }], 'learner');
    sceneRef.current = result.scene;
    setScene(result.scene);
    pendingBoardNote.current.push('erased one of their own marks');
    scheduleBoardNote();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Batches learner board activity into one context note for the tutor. */
  const scheduleBoardNote = useCallback(() => {
    if (boardEventTimer.current !== null) window.clearTimeout(boardEventTimer.current);
    boardEventTimer.current = window.setTimeout(() => {
      const notes = pendingBoardNote.current;
      pendingBoardNote.current = [];
      if (notes.length === 0) return;
      session.sendBoardEvent(
        `${notes.join('; ')}. ${describeScene(sceneRef.current)}`,
      );
    }, 1600);
  }, [session]);

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
    navigate(`/parent?session=${sessionId}`);
  }, [ending, session, sessionId, navigate]);

  const lastChildLine = [...snap.captions].reverse().find((c) => c.role === 'child');
  const lastTutorLine = [...snap.captions].reverse().find((c) => c.role === 'tutor');

  const statusLabel =
    snap.phase === 'connecting'
      ? 'Waking Seneca up…'
      : snap.phase === 'reconnecting'
        ? 'Reconnecting…'
        : snap.phase === 'thinking'
          ? 'Thinking…'
          : snap.phase === 'listening'
            ? snap.micDenied || !snap.micAvailable
              ? 'Type below — Seneca is ready'
              : 'Listening — just talk, or interrupt any time'
            : snap.phase === 'speaking'
              ? 'Speaking'
              : snap.phase === 'fallback'
                ? 'Text mode — voice is unavailable'
                : '';

  if (infoError) {
    return (
      <div className="lesson lesson--error">
        <p>Could not open this lesson: {infoError}</p>
        <button className="lesson__button" onClick={() => navigate('/')}>Back home</button>
      </div>
    );
  }

  return (
    <div className="lesson">
      <header className="lesson__bar">
        <span className="lesson__brand">Seneca</span>
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
        <span className="lesson__spacer" />
        <button className="lesson__end" onClick={endLesson} disabled={ending}>
          {ending ? 'Wrapping up…' : 'End lesson'}
        </button>
      </header>

      <main className="lesson__board">
        <div className="lesson__surface">
          <BoardCanvas
            scene={scene}
            highlights={highlights}
            tool={tool}
            penColor={penColor}
            interactive={started}
            onLearnerStroke={handleLearnerStroke}
            onLearnerErase={handleLearnerErase}
            animatorRef={(a) => {
              animator.current = a;
            }}
          />
          {!started && (
            <div className="lesson__start">
              <Avatar phase="listening" voiceEnergy={0} micEnergy={0} />
              <h1>Ready when you are{info ? `, ${info.child.name}` : ''}.</h1>
              {info && <p className="lesson__start-goal">Today: {info.session.goal}</p>}
              <button className="lesson__button lesson__button--big" onClick={begin} data-testid="start-lesson">
                Start the lesson
              </button>
              <p className="lesson__hint">
                Seneca talks with you and draws while you learn. Interrupt whenever
                you like — that's the point.
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
              onClick={() => setTool('pointer')}
            >
              <svg viewBox="0 0 24 24"><path d="m5 3 14 7-6 2-2 6z" /></svg>
            </button>
            <button
              className="lesson__tool"
              aria-pressed={tool === 'draw'}
              title="Draw on the board"
              onClick={() => setTool('draw')}
            >
              <svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19zM14.5 6.5l3 3" /></svg>
            </button>
            <button
              className="lesson__tool"
              aria-pressed={tool === 'erase'}
              title="Erase your marks"
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
          </div>
        )}
      </main>

      {started && (
        <footer className="lesson__dock">
          <Avatar phase={snap.phase} voiceEnergy={snap.voiceEnergy} micEnergy={snap.micEnergy} />

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
                The microphone is blocked, so Seneca can't hear you — but typing works.
              </p>
            )}
          </div>

          <div className="lesson__controls">
            {snap.micAvailable && !snap.micDenied && snap.phase !== 'fallback' && (
              <button
                className="lesson__mic"
                aria-pressed={!snap.muted}
                title={snap.muted ? 'Unmute your microphone' : 'Mute your microphone'}
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
                placeholder={snap.phase === 'fallback' ? 'Type to Seneca…' : 'Or type a question…'}
                aria-label="Type to Seneca"
              />
              <button type="submit" disabled={!draft.trim()}>Ask</button>
            </form>
          </div>
        </footer>
      )}
    </div>
  );
}
