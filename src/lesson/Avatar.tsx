import { useEffect, useRef } from 'react';
import { BOARD_H, BOARD_W } from '../../shared/boardOps';
import type { Phase } from './realtimeSession';
import { gazeTowardScreen, type CharacterAttentionController } from './characterAttention';
import './Avatar.css';

interface AvatarProps {
  phase: Phase;
  voiceEnergy: number;
  micEnergy: number;
  attentionController?: CharacterAttentionController;
}

/** Noura's familiar mark, rigged from real lesson, audio, pen, and learner signals. */
export function Avatar({ phase, voiceEnergy, micEnergy, attentionController }: AvatarProps) {
  const root = useRef<HTMLDivElement>(null);
  const speaking = phase === 'speaking';
  const listening = phase === 'listening';
  const thinking = phase === 'thinking' || phase === 'connecting';
  const mouthOpen = speaking ? Math.min(8, 1.4 + voiceEnergy * 32) : 0;
  const ringScale = listening ? 1 + Math.min(0.12, micEnergy * 1.1) : 1;

  useEffect(() => {
    if (!attentionController) return;
    let frame = 0;
    const tick = (now: number) => {
      const gaze = attentionController.frame(now);
      if (root.current) {
        const projected = gaze.boardCoordinates
          ? projectBoardGaze(gaze.boardCoordinates, root.current)
          : null;
        const x = projected?.[0] ?? gaze.x;
        const y = projected?.[1] ?? gaze.y;
        root.current.style.setProperty('--gaze-x', x.toFixed(3));
        root.current.style.setProperty('--gaze-y', y.toFixed(3));
        root.current.dataset.attentionTarget = gaze.targetType;
        root.current.dataset.semanticObject = gaze.semanticObjectId ?? '';
      }
      frame = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    if (!document.hidden) frame = requestAnimationFrame(tick);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [attentionController]);

  return (
    <div
      ref={root}
      className={`avatar avatar--${phase}`}
      style={{ '--ring-scale': ringScale.toFixed(3) } as React.CSSProperties}
      aria-hidden="true"
    >
      <div className="avatar__ring" />
      <svg className="avatar__face" viewBox="0 0 54 54">
        <g transform="translate(-347,-252)">
          <g className="avatar__rig">
            <path d="M348 296 c0 -25, 12 -41, 26 -41 s26 16, 26 41 c0 7 -6 9 -26 9 s-26 -2 -26 -9z" fill="var(--blue)" />
            <g className="avatar__eyes">
              <circle cx="366" cy={thinking ? 267 : 269} r="4.2" fill="var(--board)" />
              <circle cx="382" cy={thinking ? 267 : 269} r="4.2" fill="var(--board)" />
              <g className="avatar__pupils">
                <circle cx="366" cy={thinking ? 267 : 269} r="1.65" fill="var(--blue-deep)" />
                <circle cx="382" cy={thinking ? 267 : 269} r="1.65" fill="var(--blue-deep)" />
              </g>
              <path className="avatar__brow avatar__brow--left" d="M361 261.5 q5 -2 9 0" />
              <path className="avatar__brow avatar__brow--right" d="M378 261.5 q5 -2 9 0" />
            </g>
            {speaking && mouthOpen > 2.2 ? (
              <ellipse cx="374" cy="281.5" rx="5.2" ry={mouthOpen / 2} fill="var(--board)" />
            ) : (
              <path d={phase === 'failed' ? 'M368 283 q6 -3 12 0' : 'M368 280 q6 5 12 0'} stroke="var(--board)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
            )}
          </g>
        </g>
      </svg>
      {(thinking || phase === 'reconnecting') && <span className="avatar__dots"><i /><i /><i /></span>}
    </div>
  );
}

function projectBoardGaze(
  boardCoordinates: [number, number],
  avatarEl: HTMLElement,
): [number, number] | null {
  const boardEl = avatarEl.closest('.lesson')?.querySelector('.board__svg')
    ?? document.querySelector('.board__svg');
  if (!(boardEl instanceof Element)) return null;
  const boardRect = boardEl.getBoundingClientRect();
  const avatarRect = avatarEl.getBoundingClientRect();
  if (boardRect.width < 8 || boardRect.height < 8 || avatarRect.width < 4) return null;
  return gazeTowardScreen(
    [
      boardRect.left + (boardCoordinates[0] / BOARD_W) * boardRect.width,
      boardRect.top + (boardCoordinates[1] / BOARD_H) * boardRect.height,
    ],
    [avatarRect.left + avatarRect.width / 2, avatarRect.top + avatarRect.height / 2],
    [boardRect.width * 0.5, boardRect.height * 0.5],
  );
}
