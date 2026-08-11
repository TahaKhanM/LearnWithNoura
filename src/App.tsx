import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatPanel } from './chat/ChatPanel';
import type { Message } from './chat/types';
import { Whiteboard } from './whiteboard/Whiteboard';
import type { WhiteboardAction } from './whiteboard/types';
import { streamLesson } from './agent/tutorClient';
import { StepQueue, playSteps } from './agent/stepRunner';
import { cancelSpeech, isSpeechSupported, setSpeechEnabled } from './speech/speech';
import './App.css';

const CHAT_MIN_WIDTH = 260;
const CHAT_MAX_WIDTH = 800;
const CHAT_DEFAULT_WIDTH = 340;

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [whiteboardActions, setWhiteboardActions] = useState<WhiteboardAction[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT_WIDTH);
  const runIdRef = useRef(0);
  const messagesRef = useRef<Message[]>([]);
  const isResizingRef = useRef(false);

  const appendMessage = useCallback((message: Message) => {
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
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
      const isStale = () => runIdRef.current !== runId;

      cancelSpeech();
      appendMessage({ role: 'user', text });
      setWhiteboardActions([]);
      setIsPlaying(true);
      setIsThinking(true);

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
          setWhiteboardActions((prev) => [...prev, action]);
        },
        onClear: () => {
          if (isStale()) return;
          setWhiteboardActions([]);
        },
        onWaiting: (waiting) => {
          if (isStale()) return;
          setIsThinking(waiting);
        },
        isStale,
      });

      try {
        await streamLesson(text, history, {
          onStep: (step) => {
            if (isStale()) return;
            queue.push(step);
          },
        });
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
    [appendMessage],
  );

  return (
    <div className="app">
      <ChatPanel
        messages={messages}
        disabled={isPlaying}
        thinking={isThinking}
        soundOn={soundOn}
        soundSupported={isSpeechSupported()}
        onToggleSound={toggleSound}
        onSubmit={handleSubmit}
        width={chatWidth}
        onResizeStart={handleResizeStart}
      />
      <Whiteboard actions={whiteboardActions} />
    </div>
  );
}

export default App;
