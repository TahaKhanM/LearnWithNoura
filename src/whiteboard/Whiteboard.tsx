import { BOARD_WIDTH, BOARD_HEIGHT, type WhiteboardAction } from './types';
import './Whiteboard.css';

interface WhiteboardProps {
  actions: WhiteboardAction[];
}

/**
 * Stroke length, so a mark can draw itself on rather than fade in. CSS
 * animates stroke-dashoffset from the full length down to zero, which
 * needs a real number rather than a percentage.
 */
function lineLength(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** Ramanujan's approximation, which is well inside a pixel at this size. */
function ellipsePerimeter(rx: number, ry: number): number {
  const h = ((rx - ry) * (rx - ry)) / ((rx + ry) * (rx + ry));
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

export function Whiteboard({ actions }: WhiteboardProps) {
  return (
    <div className="whiteboard">
      <div className="whiteboard__surface">
        {actions.length === 0 && (
          <p className="whiteboard__empty">Everything I draw shows up here.</p>
        )}

        <svg
          className="whiteboard__svg"
          viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Tutor whiteboard"
        >
          {actions.map((action, i) => {
            if (action.type === 'drawLine') {
              const length = lineLength(action.x1, action.y1, action.x2, action.y2);
              return (
                <line
                  key={i}
                  x1={action.x1}
                  y1={action.y1}
                  x2={action.x2}
                  y2={action.y2}
                  stroke={action.color ?? 'var(--ink)'}
                  strokeWidth={action.strokeWidth ?? 3}
                  strokeLinecap="round"
                  className="whiteboard__stroke"
                  style={{ '--stroke-length': length } as React.CSSProperties}
                />
              );
            }

            if (action.type === 'drawEllipse') {
              const length = ellipsePerimeter(action.rx, action.ry);
              return (
                <ellipse
                  key={i}
                  cx={action.x}
                  cy={action.y}
                  rx={action.rx}
                  ry={action.ry}
                  stroke={action.color ?? 'var(--ink)'}
                  strokeWidth={action.strokeWidth ?? 3}
                  fill="none"
                  className="whiteboard__stroke"
                  style={{ '--stroke-length': length } as React.CSSProperties}
                />
              );
            }

            return (
              <text
                key={i}
                x={action.x}
                y={action.y}
                fill={action.color ?? 'var(--ink)'}
                fontSize={action.fontSize ?? 20}
                className="whiteboard__text"
              >
                {action.str}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
