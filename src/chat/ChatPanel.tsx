import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Message } from './types';
import { normalizeLatexDelimiters } from './latex';
import 'katex/dist/katex.min.css';
import './ChatPanel.css';

interface ChatPanelProps {
  messages: Message[];
  disabled: boolean;
  onSubmit: (text: string) => void;
  width: number;
  onResizeStart: () => void;
}

export function ChatPanel({ messages, disabled, onSubmit, width, onResizeStart }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight });
  }, [messages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setDraft('');
  }

  return (
    <div className="chat-panel" style={{ width }}>
      <div className="chat-panel__history" ref={historyRef}>
        {messages.length === 0 && (
          <p className="chat-panel__hint">
            Ask your tutor about the pythagorean theorem, slope of a line, or
            the area of a circle.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-panel__message chat-panel__message--${m.role}`}>
            <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
              {normalizeLatexDelimiters(m.text)}
            </ReactMarkdown>
          </div>
        ))}
        {disabled && (
          <div className="chat-panel__message chat-panel__message--tutor chat-panel__message--typing">
            drawing…
          </div>
        )}
      </div>
      <form className="chat-panel__form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask a question…"
          disabled={disabled}
        />
        <button type="submit" disabled={disabled || !draft.trim()}>
          Send
        </button>
      </form>
      <div
        className="chat-panel__resizer"
        onMouseDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
      />
    </div>
  );
}
