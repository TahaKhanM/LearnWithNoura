import { useCallback, useRef, useState } from 'react';
import { ChatPanel } from './chat/ChatPanel';
import type { Message } from './chat/types';
import { Whiteboard } from './whiteboard/Whiteboard';
import type { WhiteboardAction } from './whiteboard/types';
import { generateLesson } from './agent/mockAgent';
import { runLessonSteps } from './agent/stepRunner';
import './App.css';

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [whiteboardActions, setWhiteboardActions] = useState<WhiteboardAction[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const runIdRef = useRef(0);

  const handleSubmit = useCallback((text: string) => {
    const runId = ++runIdRef.current;

    setMessages((prev) => [...prev, { role: 'user', text }]);
    setWhiteboardActions([]);
    setIsPlaying(true);

    const steps = generateLesson(text);

    runLessonSteps(steps, {
      onChat: (chatText) => {
        if (runIdRef.current !== runId) return;
        setMessages((prev) => [...prev, { role: 'tutor', text: chatText }]);
      },
      onWhiteboardAction: (action) => {
        if (runIdRef.current !== runId) return;
        setWhiteboardActions((prev) => [...prev, action]);
      },
    }).finally(() => {
      if (runIdRef.current === runId) {
        setIsPlaying(false);
      }
    });
  }, []);

  return (
    <div className="app">
      <ChatPanel messages={messages} disabled={isPlaying} onSubmit={handleSubmit} />
      <Whiteboard actions={whiteboardActions} />
    </div>
  );
}

export default App;
