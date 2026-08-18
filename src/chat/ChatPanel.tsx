import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Message } from './types';
import { normalizeLatexDelimiters } from './latex';
import 'katex/dist/katex.min.css';
import './ChatPanel.css';

export type MicState = 'idle' | 'recording' | 'transcribing';

interface ChatPanelProps {
  messages: Message[];
  disabled: boolean;
  thinking: boolean;
  soundOn: boolean;
  soundSupported: boolean;
  onToggleSound: () => void;
  onSubmit: (text: string) => void;
  width: number;
  onResizeStart: () => void;
  micSupported: boolean;
  micState: MicState;
  micError: string | null;
  onTalkStart: () => void;
  onTalkEnd: () => void;
}

export function ChatPanel({
  messages,
  disabled,
  thinking,
  soundOn,
  soundSupported,
  onToggleSound,
  onSubmit,
  width,
  onResizeStart,
  micSupported,
  micState,
  micError,
  onTalkStart,
  onTalkEnd,
}: ChatPanelProps) {
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

  function handleTalkDown(e: React.PointerEvent<HTMLButtonElement>) {
    // Capture so letting go anywhere on the page still ends the recording.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onTalkStart();
  }

  function handleTalkUp() {
    onTalkEnd();
  }

  // Hold to talk has to work from the keyboard too, so space and enter
  // behave like holding the button rather than firing a click.
  function handleTalkKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (e.repeat) return;
    onTalkStart();
  }

  function handleTalkKeyUp(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    onTalkEnd();
  }

  const talkLabel =
    micState === 'recording'
      ? 'Listening, let go when you are done'
      : micState === 'transcribing'
        ? 'Working out what you said'
        : 'Hold to talk to Seneca';

  const inputPlaceholder =
    micState === 'recording'
      ? 'Listening…'
      : micState === 'transcribing'
        ? 'One moment…'
        : 'Ask a question…';

  return (
    <div className="chat-panel" style={{ width }}>
      <div className="chat-panel__bar">
        <span className="chat-panel__title">Seneca</span>
        {soundSupported && (
          <button
            type="button"
            className="chat-panel__sound"
            onClick={onToggleSound}
            aria-pressed={soundOn}
            title={soundOn ? 'Turn the voice off' : 'Turn the voice on'}
          >
            {soundOn ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5 6 9H3v6h3l5 4z" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                <path d="M18.5 5.5a9 9 0 0 1 0 13" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5 6 9H3v6h3l5 4z" />
                <path d="m16 9 5 6M21 9l-5 6" />
              </svg>
            )}
            <span className="chat-panel__sound-label">{soundOn ? 'Voice on' : 'Voice off'}</span>
          </button>
        )}
      </div>

      <div className="chat-panel__history" ref={historyRef}>
        {messages.length === 0 && (
          <p className="chat-panel__hint">
            Ask your tutor anything. It will explain on the whiteboard as it
            works, one step at a time.
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
          <div className="chat-panel__status">
            <span className="chat-panel__dots" aria-hidden="true">
              <i></i><i></i><i></i>
            </span>
            {thinking ? 'thinking' : 'drawing'}
          </div>
        )}
      </div>
      {micError && <p className="chat-panel__mic-error">{micError}</p>}

      <form className="chat-panel__form" onSubmit={handleSubmit}>
        {micSupported && (
          <button
            type="button"
            className="chat-panel__talk"
            // Deliberately never disabled: interrupting the tutor while it is
            // talking is the whole point of push to talk.
            data-state={micState}
            aria-pressed={micState === 'recording'}
            aria-label={talkLabel}
            title={talkLabel}
            onPointerDown={handleTalkDown}
            onPointerUp={handleTalkUp}
            onPointerCancel={handleTalkUp}
            onKeyDown={handleTalkKeyDown}
            onKeyUp={handleTalkKeyUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v4" />
            </svg>
          </button>
        )}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={inputPlaceholder}
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
