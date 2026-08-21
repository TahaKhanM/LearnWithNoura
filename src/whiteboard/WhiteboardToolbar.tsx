export type WhiteboardTool = 'pointer' | 'draw' | 'text' | 'erase';

interface WhiteboardToolbarProps {
  tool: WhiteboardTool;
  color: string;
  disabled: boolean;
  onToolChange: (tool: WhiteboardTool) => void;
  onColorChange: (color: string) => void;
}

const COLORS = [
  { value: '#2C5BE0', label: 'Blue' },
  { value: '#26231F', label: 'Black' },
  { value: '#E14B3C', label: 'Red' },
  { value: '#14A07A', label: 'Green' },
];

function ToolIcon({ tool }: { tool: WhiteboardTool }) {
  if (tool === 'pointer') {
    return (
      <path
        d="M5 3.5 17.5 15l-6.1.8-3.1 5.3z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    );
  }
  if (tool === 'draw') {
    return (
      <>
        <path d="m5 18 1.2-4.2L16.7 3.3l4 4L10.2 17.8z" fill="none" stroke="currentColor" />
        <path d="m14.8 5.2 4 4M6.2 13.8l4 4" fill="none" stroke="currentColor" />
      </>
    );
  }
  if (tool === 'text') {
    return (
      <>
        <path d="M5 5h14M12 5v15M8.5 20h7" fill="none" stroke="currentColor" />
      </>
    );
  }
  return (
    <>
      <path
        d="m4.5 15.5 9.8-11a2.3 2.3 0 0 1 3.4-.1l2 2a2.3 2.3 0 0 1-.1 3.4l-9.1 9.7H7.8z"
        fill="none"
        stroke="currentColor"
      />
      <path d="m11 8.2 5.1 4.7M10.5 19.5h10" fill="none" stroke="currentColor" />
    </>
  );
}

const TOOLS: { value: WhiteboardTool; label: string }[] = [
  { value: 'pointer', label: 'Pointer' },
  { value: 'draw', label: 'Draw' },
  { value: 'text', label: 'Add text' },
  { value: 'erase', label: 'Erase an object' },
];

export function WhiteboardToolbar({
  tool,
  color,
  disabled,
  onToolChange,
  onColorChange,
}: WhiteboardToolbarProps) {
  return (
    <div className="whiteboard-toolbar" role="toolbar" aria-label="Whiteboard tools">
      <div className="whiteboard-toolbar__tools">
        {TOOLS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className="whiteboard-toolbar__button"
            aria-label={label}
            aria-pressed={tool === value}
            title={label}
            disabled={disabled}
            onClick={() => onToolChange(value)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <ToolIcon tool={value} />
            </svg>
          </button>
        ))}
      </div>

      <span className="whiteboard-toolbar__divider" aria-hidden="true" />

      <div className="whiteboard-toolbar__colors" aria-label="Marker color">
        {COLORS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className="whiteboard-toolbar__color"
            style={{ '--marker-color': value } as React.CSSProperties}
            aria-label={`${label} marker`}
            aria-pressed={color.toLowerCase() === value.toLowerCase()}
            title={`${label} marker`}
            disabled={disabled || tool === 'erase' || tool === 'pointer'}
            onClick={() => onColorChange(value)}
          />
        ))}
      </div>
    </div>
  );
}
