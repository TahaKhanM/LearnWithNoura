import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatPanel } from './chat/ChatPanel';
import type { Message } from './chat/types';
import { Whiteboard } from './whiteboard/Whiteboard';
import type { WhiteboardAction } from './whiteboard/types';
import { requestLesson } from './agent/tutorClient';
import { runLessonSteps } from './agent/stepRunner';
import './App.css';

const CHAT_MIN_WIDTH = 260;
const CHAT_MAX_WIDTH = 800;
const CHAT_DEFAULT_WIDTH = 340;

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [whiteboardActions, setWhiteboardActions] = useState<WhiteboardAction[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
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
      const next = Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, e.clientX));
      setChatWidth(next);
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

  const handleSubmit = useCallback(
    async (text: string) => {
      const runId = ++runIdRef.current;
      const history = messagesRef.current;

      appendMessage({ role: 'user', text });
      setWhiteboardActions([]);
      setIsPlaying(true);

      try {
        const steps = await requestLesson(text, history);
        if (runIdRef.current !== runId) return;

        await runLessonSteps(steps, {
          onChat: (chatText) => {
            if (runIdRef.current !== runId) return;
            appendMessage({ role: 'tutor', text: chatText });
          },
          onWhiteboardAction: (action) => {
            if (runIdRef.current !== runId) return;
            setWhiteboardActions((prev) => [...prev, action]);
          },
          onClear: () => {
            if (runIdRef.current !== runId) return;
            setWhiteboardActions([]);
          },
        });
      } catch (err) {
        if (runIdRef.current !== runId) return;
        const detail = err instanceof Error ? err.message : 'Unknown error';
        appendMessage({ role: 'tutor', text: `Sorry, something went wrong: ${detail}` });
      } finally {
        if (runIdRef.current === runId) {
          setIsPlaying(false);
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
        onSubmit={handleSubmit}
        width={chatWidth}
        onResizeStart={handleResizeStart}
      />
      <Whiteboard actions={whiteboardActions} />
    </div>
  );
}

export default App;
