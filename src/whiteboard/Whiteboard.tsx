import { BOARD_WIDTH, BOARD_HEIGHT, type WhiteboardAction } from './types';
import './Whiteboard.css';

interface WhiteboardProps {
  actions: WhiteboardAction[];
}

export function Whiteboard({ actions }: WhiteboardProps) {
  return (
    <div className="whiteboard">
      <svg
        className="whiteboard__svg"
        viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Tutor whiteboard"
      >
        {actions.map((action, i) => {
          if (action.type === 'drawLine') {
            return (
              <line
                key={i}
                x1={action.x1}
                y1={action.y1}
                x2={action.x2}
                y2={action.y2}
                stroke={action.color ?? '#1e293b'}
                strokeWidth={action.strokeWidth ?? 3}
                strokeLinecap="round"
                className="whiteboard__line"
              />
            );
          }

          if (action.type === 'drawEllipse') {
            return (
              <ellipse
                key={i}
                cx={action.x}
                cy={action.y}
                rx={action.rx}
                ry={action.ry}
                stroke={action.color ?? '#1e293b'}
                strokeWidth={action.strokeWidth ?? 3}
                fill="none"
                className="whiteboard__ellipse"
              />
            );
          }

          return (
            <text
              key={i}
              x={action.x}
              y={action.y}
              fill={action.color ?? '#1e293b'}
              fontSize={action.fontSize ?? 20}
              className="whiteboard__text"
            >
              {action.str}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
