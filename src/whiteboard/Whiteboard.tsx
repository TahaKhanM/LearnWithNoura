import { useRef, useState } from 'react';
import { BOARD_WIDTH, BOARD_HEIGHT, drawPath, writeText, type BoardPoint } from './types';
import { createBoardObject, nextBoardObjectId, type BoardObject } from './scene';
import { pointsToPath } from './geometry';
import { WhiteboardToolbar, type WhiteboardTool } from './WhiteboardToolbar';
import './Whiteboard.css';

interface WhiteboardProps {
  objects: BoardObject[];
  disabled?: boolean;
  onUpsertObject: (object: BoardObject) => void;
  onRemoveObject: (id: string) => void;
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

function eventPoint(
  svg: SVGSVGElement,
  event: Pick<React.PointerEvent<SVGSVGElement>, 'clientX' | 'clientY'>,
): BoardPoint {
  const ctm = typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
  if (ctm) {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const transformed = point.matrixTransform(ctm.inverse());
    return {
      x: Math.max(0, Math.min(BOARD_WIDTH, transformed.x)),
      y: Math.max(0, Math.min(BOARD_HEIGHT, transformed.y)),
    };
  }

  const rect = svg.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(BOARD_WIDTH, ((event.clientX - rect.left) / rect.width) * BOARD_WIDTH)),
    y: Math.max(
      0,
      Math.min(BOARD_HEIGHT, ((event.clientY - rect.top) / rect.height) * BOARD_HEIGHT),
    ),
  };
}

interface BoardMarkProps {
  object: BoardObject;
  erasing: boolean;
  onErase: (id: string) => void;
}

function BoardMark({ object, erasing, onErase }: BoardMarkProps) {
  const action = object.action;
  const animated = object.owner === 'tutor';
  const strokeClass = animated
    ? 'whiteboard__stroke whiteboard__stroke--animated'
    : 'whiteboard__stroke';

  const erase = (event: React.PointerEvent<SVGElement>) => {
    if (!erasing) return;
    event.preventDefault();
    event.stopPropagation();
    onErase(object.id);
  };

  if (action.type === 'drawLine') {
    const length = lineLength(action.x1, action.y1, action.x2, action.y2);
    return (
      <g data-board-object={object.id}>
        <line
          x1={action.x1}
          y1={action.y1}
          x2={action.x2}
          y2={action.y2}
          stroke={action.color ?? 'var(--ink)'}
          strokeWidth={action.strokeWidth ?? 3}
          strokeLinecap="round"
          className={strokeClass}
          style={{ '--stroke-length': length } as React.CSSProperties}
        />
        <line
          x1={action.x1}
          y1={action.y1}
          x2={action.x2}
          y2={action.y2}
          className="whiteboard__hit-target"
          onPointerDown={erase}
        />
      </g>
    );
  }

  if (action.type === 'drawEllipse') {
    const length = ellipsePerimeter(action.rx, action.ry);
    return (
      <g data-board-object={object.id}>
        <ellipse
          cx={action.x}
          cy={action.y}
          rx={action.rx}
          ry={action.ry}
          stroke={action.color ?? 'var(--ink)'}
          strokeWidth={action.strokeWidth ?? 3}
          fill="none"
          className={strokeClass}
          style={{ '--stroke-length': length } as React.CSSProperties}
        />
        <ellipse
          cx={action.x}
          cy={action.y}
          rx={action.rx}
          ry={action.ry}
          className="whiteboard__hit-target"
          onPointerDown={erase}
        />
      </g>
    );
  }

  if (action.type === 'drawPath') {
    const path = pointsToPath(action.points);
    return (
      <g data-board-object={object.id}>
        <path
          d={path}
          stroke={action.color ?? 'var(--blue)'}
          strokeWidth={action.strokeWidth ?? 4}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          className="whiteboard__stroke"
        />
        <path d={path} className="whiteboard__hit-target" onPointerDown={erase} />
      </g>
    );
  }

  const fontSize = action.fontSize ?? 28;
  const width = Math.max(fontSize, action.str.length * fontSize * 0.52);
  return (
    <g data-board-object={object.id}>
      <text
        x={action.x}
        y={action.y}
        fill={action.color ?? 'var(--ink)'}
        fontSize={fontSize}
        className={animated ? 'whiteboard__text whiteboard__text--animated' : 'whiteboard__text'}
      >
        {action.str}
      </text>
      <rect
        x={action.x - 5}
        y={action.y - fontSize}
        width={width + 10}
        height={fontSize + 10}
        className="whiteboard__hit-target whiteboard__hit-target--fill"
        onPointerDown={erase}
      />
    </g>
  );
}

interface TextEditor {
  id: string;
  x: number;
  y: number;
  left: number;
  top: number;
}

export function Whiteboard({
  objects,
  disabled = false,
  onUpsertObject,
  onRemoveObject,
}: WhiteboardProps) {
  const [tool, setTool] = useState<WhiteboardTool>('pointer');
  const [color, setColor] = useState('#2C5BE0');
  const [textEditor, setTextEditor] = useState<TextEditor | null>(null);
  const [textDraft, setTextDraft] = useState('');
  const activeStroke = useRef<{ id: string; points: BoardPoint[] } | null>(null);
  const cancelText = useRef(false);

  const startInteraction = (event: React.PointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0) return;
    const svg = event.currentTarget;
    const point = eventPoint(svg, event);

    if (tool === 'draw') {
      event.preventDefault();
      svg.setPointerCapture?.(event.pointerId);
      const stroke = { id: nextBoardObjectId('learner'), points: [point] };
      activeStroke.current = stroke;
      onUpsertObject(
        createBoardObject(
          'learner',
          drawPath(stroke.points, { color, strokeWidth: 4 }),
          stroke.id,
        ),
      );
    }
  };

  const placeText = (event: React.MouseEvent<SVGSVGElement>) => {
    if (disabled || tool !== 'text') return;
    const svg = event.currentTarget;
    const point = eventPoint(svg, event);
    const rect = svg.getBoundingClientRect();
    cancelText.current = false;
    setTextDraft('');
    setTextEditor({
      id: nextBoardObjectId('learner'),
      x: Math.max(12, Math.min(BOARD_WIDTH - 260, point.x)),
      y: Math.max(45, Math.min(BOARD_HEIGHT - 12, point.y)),
      left: Math.max(10, Math.min(rect.width - 250, event.clientX - rect.left)),
      top: Math.max(54, Math.min(rect.height - 48, event.clientY - rect.top - 36)),
    });
  };

  const continueStroke = (event: React.PointerEvent<SVGSVGElement>) => {
    const stroke = activeStroke.current;
    if (!stroke) return;
    const point = eventPoint(event.currentTarget, event);
    const previous = stroke.points.at(-1) as BoardPoint;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 3) return;
    stroke.points = [...stroke.points, point];
    onUpsertObject(
      createBoardObject(
        'learner',
        drawPath(stroke.points, { color, strokeWidth: 4 }),
        stroke.id,
      ),
    );
  };

  const finishStroke = (event: React.PointerEvent<SVGSVGElement>) => {
    const stroke = activeStroke.current;
    if (!stroke) return;
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      stroke.points = [point, { x: point.x + 0.01, y: point.y + 0.01 }];
      onUpsertObject(
        createBoardObject(
          'learner',
          drawPath(stroke.points, { color, strokeWidth: 4 }),
          stroke.id,
        ),
      );
    }
    activeStroke.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const commitText = () => {
    if (!textEditor || cancelText.current) {
      setTextEditor(null);
      return;
    }
    const text = textDraft.trim();
    if (text) {
      onUpsertObject(
        createBoardObject(
          'learner',
          writeText(text, textEditor.x, textEditor.y, { color, fontSize: 28 }),
          textEditor.id,
        ),
      );
    }
    setTextEditor(null);
    setTextDraft('');
  };

  return (
    <div className="whiteboard">
      <div className="whiteboard__surface">
        <WhiteboardToolbar
          tool={tool}
          color={color}
          disabled={disabled}
          onToolChange={(nextTool) => {
            setTool(nextTool);
            setTextEditor(null);
          }}
          onColorChange={setColor}
        />

        {objects.length === 0 && (
          <p className="whiteboard__empty">This board belongs to both of you.</p>
        )}

        <svg
          className={`whiteboard__svg whiteboard__svg--${tool}`}
          viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Shared tutor whiteboard"
          onPointerDown={startInteraction}
          onClick={placeText}
          onPointerMove={continueStroke}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
        >
          {objects.map((object) => (
            <BoardMark
              key={object.id}
              object={object}
              erasing={!disabled && tool === 'erase'}
              onErase={onRemoveObject}
            />
          ))}

        </svg>

        {textEditor && (
          <input
            autoFocus
            className="whiteboard__text-editor"
            style={{ left: textEditor.left, top: textEditor.top }}
            value={textDraft}
            aria-label="Whiteboard text"
            placeholder="Type, then press Enter"
            maxLength={240}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => setTextDraft(event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                cancelText.current = true;
                setTextDraft('');
                event.currentTarget.blur();
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
