import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatPanel } from './chat/ChatPanel';
import type { Message } from './chat/types';
import { Whiteboard } from './whiteboard/Whiteboard';
import { streamLesson } from './agent/tutorClient';
import { StepQueue, playSteps } from './agent/stepRunner';
import { cancelSpeech, isSpeechSupported, primeAudio, setSpeechEnabled } from './speech/speech';
import { MicRecorder, isMicSupported, transcribe } from './speech/mic';
import type { MicState } from './chat/ChatPanel';
import {
  createBoardObject,
  snapshotBoard,
  type BoardObject,
} from './whiteboard/scene';
import { captureBoardPng } from './whiteboard/boardImage';
import './App.css';

const CHAT_MIN_WIDTH = 260;
const CHAT_MAX_WIDTH = 800;
const CHAT_DEFAULT_WIDTH = 340;

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [boardObjects, setBoardObjects] = useState<BoardObject[]>([]);
  const [activeTutorObjectId, setActiveTutorObjectId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT_WIDTH);
  const [voiceReady, setVoiceReady] = useState(false);
  const [micState, setMicState] = useState<MicState>('idle');
  const [micError, setMicError] = useState<string | null>(null);
  const runIdRef = useRef(0);
  const messagesRef = useRef<Message[]>([]);
  const boardObjectsRef = useRef<BoardObject[]>([]);
  const visualRevisionRef = useRef(0);
  const sentVisualRevisionRef = useRef(0);
  const tutorCursorTimerRef = useRef<number | null>(null);
  const isResizingRef = useRef(false);
  const recorderRef = useRef<MicRecorder | null>(null);
  // True between press and release. The first press shows a permission
  // prompt, which can outlast the press itself, so the recorder has to know
  // whether the child is still holding by the time the microphone opens.
  const heldRef = useRef(false);

  // The server owns the ElevenLabs key, so it decides whether voice exists.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/voice/status')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((body: { enabled?: boolean }) => {
        if (!cancelled) setVoiceReady(Boolean(body.enabled));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const appendMessage = useCallback((message: Message) => {
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
  }, []);

  const replaceBoardObjects = useCallback(
    (update: BoardObject[] | ((current: BoardObject[]) => BoardObject[])) => {
      setBoardObjects((current) => {
        const next = typeof update === 'function' ? update(current) : update;
        boardObjectsRef.current = next;
        return next;
      });
    },
    [],
  );

  const upsertBoardObject = useCallback(
    (object: BoardObject) => {
      replaceBoardObjects((current) => {
        const index = current.findIndex((item) => item.id === object.id);
        if (index === -1) return [...current, object];
        const next = [...current];
        next[index] = object;
        return next;
      });
    },
    [replaceBoardObjects],
  );

  const removeBoardObject = useCallback(
    (id: string) => {
      replaceBoardObjects((current) => current.filter((object) => object.id !== id));
    },
    [replaceBoardObjects],
  );

  const upsertLearnerBoardObject = useCallback(
    (object: BoardObject) => {
      if (object.owner === 'learner' && object.action.type === 'drawPath') {
        visualRevisionRef.current += 1;
      }
      upsertBoardObject(object);
    },
    [upsertBoardObject],
  );

  const removeLearnerBoardObject = useCallback(
    (id: string) => {
      const object = boardObjectsRef.current.find((item) => item.id === id);
      // Removing geometry changes the visual interpretation too. Text-only
      // edits remain fully represented by the structured scene.
      if (object && object.action.type !== 'writeText') {
        visualRevisionRef.current += 1;
      }
      removeBoardObject(id);
    },
    [removeBoardObject],
  );

  const showTutorCursorFor = useCallback((id: string) => {
    setActiveTutorObjectId(id);
    if (tutorCursorTimerRef.current !== null) {
      window.clearTimeout(tutorCursorTimerRef.current);
    }
    tutorCursorTimerRef.current = window.setTimeout(() => {
      setActiveTutorObjectId(null);
      tutorCursorTimerRef.current = null;
    }, 460);
  }, []);

  const handleResizeStart = useCallback(() => {
    isResizingRef.current = true;
    document.body.classList.add('resizing-chat');
  }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isResizingRef.current) return;
      setChatWidth(Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, e.clientX)));
    }
    function onMouseUp() {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.classList.remove('resizing-chat');
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      const next = !on;
      setSpeechEnabled(next);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(
    async (text: string) => {
      const runId = ++runIdRef.current;
      const history = messagesRef.current;
      const board = snapshotBoard(boardObjectsRef.current);
      const isStale = () => runIdRef.current !== runId;

      primeAudio();
      cancelSpeech();
      appendMessage({ role: 'user', text });
      setIsPlaying(true);
      setIsThinking(true);

      const visualRevision = visualRevisionRef.current;
      let boardImage: string | undefined;
      if (visualRevision > sentVisualRevisionRef.current) {
        try {
          boardImage = await captureBoardPng(board);
        } catch (error) {
          // The exact scene still reaches the model. A failed raster should
          // degrade gracefully and be retried on the next learner turn.
          console.warn('Could not capture visual whiteboard context:', error);
        }
      }

      const queue = new StepQueue();

      // The stream fills the queue while the player drains it, so drawing
      // begins on the first step instead of waiting for the whole lesson.
      const player = playSteps(queue, {
        onChat: (chatText) => {
          if (isStale()) return;
          appendMessage({ role: 'tutor', text: chatText });
        },
        onWhiteboardAction: (action) => {
          if (isStale()) return;
          const object = createBoardObject('tutor', action);
          upsertBoardObject(object);
          showTutorCursorFor(object.id);
        },
        onClear: () => {
          if (isStale()) return;
          replaceBoardObjects([]);
          setActiveTutorObjectId(null);
        },
        onWaiting: (waiting) => {
          if (isStale()) return;
          setIsThinking(waiting);
        },
        isStale,
      });

      try {
        await streamLesson(text, history, board, boardImage, {
          onStep: (step) => {
            if (isStale()) return;
            queue.push(step);
          },
        });
        if (boardImage) {
          sentVisualRevisionRef.current = Math.max(
            sentVisualRevisionRef.current,
            visualRevision,
          );
        }
        queue.close();
        await player;
      } catch (err) {
        queue.close();
        await player.catch(() => undefined);
        if (isStale()) return;
        const detail = err instanceof Error ? err.message : 'Unknown error';
        appendMessage({ role: 'tutor', text: `Sorry, something went wrong: ${detail}` });
      } finally {
        if (!isStale()) {
          setIsPlaying(false);
          setIsThinking(false);
        }
      }
    },
    [appendMessage, replaceBoardObjects, showTutorCursorFor, upsertBoardObject],
  );

  const handleTalkStart = useCallback(async () => {
    if (recorderRef.current?.active || heldRef.current) return;
    heldRef.current = true;

    // The button is live during a lesson on purpose, so the first thing a
    // press does is stop the tutor talking. That keeps the tutor's own
    // voice out of the recording and lets the child cut in.
    primeAudio();
    cancelSpeech();
    setMicError(null);

    const recorder = recorderRef.current ?? new MicRecorder();
    recorderRef.current = recorder;

    try {
      await recorder.start();
      // Let go while the prompt was still up: drop the microphone rather
      // than leaving it open and recording with nothing to stop it.
      if (!heldRef.current) {
        recorder.release();
        setMicState('idle');
        return;
      }
      setMicState('recording');
    } catch {
      heldRef.current = false;
      setMicState('idle');
      setMicError('Seneca could not reach your microphone. Check the browser permission.');
    }
  }, []);

  const handleTalkEnd = useCallback(async () => {
    heldRef.current = false;
    const recorder = recorderRef.current;
    // Still waiting on the permission prompt, so there is nothing recorded
    // yet. handleTalkStart sees the released flag and cleans up.
    if (!recorder?.active) return;

    setMicState('transcribing');
    try {
      const clip = await recorder.stop();
      // A tap rather than a hold: nothing was said, so say nothing.
      if (!clip) {
        setMicState('idle');
        return;
      }
      const text = await transcribe(clip);
      setMicState('idle');
      if (text) await handleSubmit(text);
      else setMicError('That came through empty. Try holding the button a little longer.');
    } catch (err) {
      setMicState('idle');
      setMicError(err instanceof Error ? err.message : 'Could not hear that.');
    }
  }, [handleSubmit]);

  useEffect(
    () => () => {
      recorderRef.current?.release();
      if (tutorCursorTimerRef.current !== null) {
        window.clearTimeout(tutorCursorTimerRef.current);
      }
    },
    [],
  );

  return (
    <div className="app">
      <ChatPanel
        messages={messages}
        disabled={isPlaying}
        thinking={isThinking}
        soundOn={soundOn}
        soundSupported={isSpeechSupported() && voiceReady}
        onToggleSound={toggleSound}
        onSubmit={handleSubmit}
        width={chatWidth}
        onResizeStart={handleResizeStart}
        micSupported={isMicSupported() && voiceReady}
        micState={micState}
        micError={micError}
        onTalkStart={handleTalkStart}
        onTalkEnd={handleTalkEnd}
      />
      <Whiteboard
        objects={boardObjects}
        activeTutorObjectId={activeTutorObjectId}
        disabled={isPlaying}
        onUpsertObject={upsertLearnerBoardObject}
        onRemoveObject={removeLearnerBoardObject}
      />
    </div>
  );
}

export default App;
