import type { Phase } from './realtimeSession';
import './Avatar.css';

interface AvatarProps {
  phase: Phase;
  /** 0..~0.5 — the tutor's voice loudness right now. */
  voiceEnergy: number;
  /** 0..~0.5 — the child's mic loudness right now. */
  micEnergy: number;
}

/**
 * Seneca itself: the same face as the brand mark, alive. The mouth rides
 * the actual output waveform; the ring breathes while listening to the
 * child; thinking shows as raised eyes. Deliberately calm — the board is
 * the show, the tutor is the presence beside it.
 */
export function Avatar({ phase, voiceEnergy, micEnergy }: AvatarProps) {
  const speaking = phase === 'speaking';
  const listening = phase === 'listening';
  const thinking = phase === 'thinking' || phase === 'connecting' || phase === 'reconnecting';

  const mouthOpen = speaking ? Math.min(9, 1.5 + voiceEnergy * 34) : 0;
  const ringScale = listening ? 1 + Math.min(0.18, micEnergy * 1.4) : 1;

  return (
    <div className={`avatar avatar--${phase}`} aria-hidden="true">
      <div
        className="avatar__ring"
        style={{ transform: `scale(${ringScale.toFixed(3)})` }}
      />
      <svg className="avatar__face" viewBox="0 0 54 54">
        <g transform="translate(-347,-252)">
          <path
            d="M348 296 c0 -25, 12 -41, 26 -41 s26 16, 26 41 c0 7 -6 9 -26 9 s-26 -2 -26 -9z"
            fill="var(--blue)"
          />
          <circle
            className="avatar__eye"
            cx="366"
            cy={thinking ? 267 : 269}
            r="3.1"
            fill="var(--board)"
          />
          <circle
            className="avatar__eye"
            cx="382"
            cy={thinking ? 267 : 269}
            r="3.1"
            fill="var(--board)"
          />
          {speaking && mouthOpen > 2.2 ? (
            <ellipse cx="373" cy="281.5" rx="5.2" ry={mouthOpen / 2} fill="var(--board)" />
          ) : (
            <path
              d="M367 280 c3 3, 9 3, 12 0"
              stroke="var(--board)"
              strokeWidth="2.2"
              strokeLinecap="round"
              fill="none"
            />
          )}
        </g>
      </svg>
      {thinking && (
        <span className="avatar__dots">
          <i /><i /><i />
        </span>
      )}
    </div>
  );
}
