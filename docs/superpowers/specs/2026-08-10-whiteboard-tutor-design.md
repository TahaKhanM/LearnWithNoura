# Whiteboard Tutor — Design Spec

Date: 2026-08-10

## Purpose

A webapp where an AI tutor teaches via a whiteboard (drawing lines and text
annotations at specific coordinates) alongside a chat panel for supplemental
explanation. This prototype validates the UI/UX and the agent-tool interface
using a rule-based mock agent; a real LLM can later be wired in behind the
same action interface.

## Architecture

Single-page React + Vite + TypeScript app. Two-panel layout:

- **Left panel — Chat**: scrollable message history (user + tutor turns) and
  a text input box.
- **Right panel — Whiteboard**: an SVG canvas rendering a fixed logical
  coordinate grid, scaled to fill its container via `viewBox`.

## Coordinate System

- Logical grid: **1000 (width) × 600 (height)**, origin `(0,0)` at top-left,
  x increases rightward, y increases downward.
- The `<svg>` element uses `viewBox="0 0 1000 600"` with `preserveAspectRatio`
  so it scales responsively to the actual panel size without the agent (or
  its coordinate math) needing to know real pixel dimensions.

## Agent Tool Interface

The agent (mock or real) does not touch the DOM directly. It emits a
sequence of typed **whiteboard actions**, matching this shape:

```ts
type WhiteboardAction =
  | { type: 'drawLine'; x1: number; y1: number; x2: number; y2: number; color?: string; strokeWidth?: number }
  | { type: 'writeText'; str: string; x: number; y: number; color?: string; fontSize?: number }
  | { type: 'drawEllipse'; x: number; y: number; rx: number; ry: number; color?: string; strokeWidth?: number };
```

This corresponds to the primitives:

- `DrawLine(x1, y1, x2, y2)`
- `writeText(str, x, y)`
- `drawEllipse(x, y, rx, ry)` — `(x, y)` is the center, `rx`/`ry` are the
  horizontal/vertical radii (equal values draw a circle). Added because
  circles/ellipses are impractical to approximate with `DrawLine` (would
  require many short segments to look round).

Interleaved with these, the agent also emits **chat steps**:

```ts
type ChatStep = { type: 'chat'; text: string };
type LessonStep = WhiteboardAction | ChatStep;
```

A "lesson" is an ordered `LessonStep[]`. Keeping the action shape decoupled
from rendering means a future real-LLM agent only needs to produce the same
JSON shape (e.g. via tool-use) to work with this exact frontend.

## Mock Agent

`mockAgent.ts` exports `generateLesson(userInput: string): LessonStep[]`.

- Matches `userInput` against keywords for a small set of canned lessons
  (e.g. "pythagorean theorem", "slope of a line", "area of a circle").
- Each lesson is a hand-authored `LessonStep[]` mixing chat explanation with
  DrawLine/writeText calls that progressively build a diagram.
- If no keyword matches, returns a single chat-only fallback step listing
  the topics it does know, so the user isn't left staring at a blank board.

## Playback / Step Runner

- On submitting chat input: whiteboard actions from the *previous* lesson
  are cleared; the new user message is appended to chat history immediately.
- `generateLesson` produces the step list, and a step runner executes steps
  sequentially with a **600ms delay** between each.
- Each step is dispatched to the right piece of state as it executes:
  - `chat` steps append to the chat message list (rendered as a tutor
    message).
  - `drawLine` / `writeText` steps append to the whiteboard action list
    (rendered on the SVG).
- This produces the effect of the tutor "talking while drawing," since chat
  and board updates are interleaved in real execution order rather than
  batch-rendered.
- While a lesson is playing, the chat input is disabled to prevent
  overlapping playback runs.

## State Shape (in `App`)

```ts
messages: { role: 'user' | 'tutor'; text: string }[]
whiteboardActions: WhiteboardAction[]
isPlaying: boolean
```

## Components

- `App` — owns state, wires chat submission to the step runner.
- `ChatPanel` — renders `messages`, provides input box, disabled while
  `isPlaying`.
- `Whiteboard` — renders `whiteboardActions` as SVG `<line>` and `<text>`
  elements inside the fixed `viewBox`.
- `mockAgent.ts` — pure function, no React dependency, easily unit-testable
  and swappable for a real API call later.
- `stepRunner.ts` — small async helper that walks a `LessonStep[]` with
  delays, calling back into state setters.

## Error Handling

- Empty/whitespace-only chat input is ignored (no-op, no message sent).
- Unmatched topics get the fallback chat response (see Mock Agent) rather
  than an error state.
- No other failure modes exist in this prototype (no network calls).

## Testing

- Unit tests (Vitest) for:
  - `mockAgent.generateLesson` keyword matching (each known topic resolves
    to its lesson; unknown input resolves to fallback).
  - Any coordinate-scaling helper functions, if extracted.
- Manual browser verification of the golden path (ask about a known topic,
  watch it draw + narrate) and the fallback path (ask about an unknown
  topic).

## Out of Scope (YAGNI)

- Real LLM integration (future work; interface is designed to support it).
- Additional shape primitives (circles, arrows, freehand) beyond
  DrawLine/writeText.
- Persistence/save-load of whiteboard state.
- Multi-user/collaborative whiteboard.
- Undo/redo, manual drawing by the human user.
