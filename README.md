# Seneca

An AI tutor that teaches on a whiteboard instead of purely through chat. A
left-hand chat panel carries narration and supplemental explanation, while
the tutor draws on a coordinate-based whiteboard alongside it.

A real LLM (OpenAI's `gpt-5.6-terra` by default) drives the tutor via
function calling, deciding what to say and what to draw on the fly. A small
Express backend holds the API key server-side and proxies requests: the
key never reaches the browser.

## Whiteboard tool interface

The whiteboard is a fixed 1000×600 logical coordinate grid (origin
top-left), scaled responsively to fill the panel. The agent draws on it
with:

- `DrawLine(x1, y1, x2, y2)`
- `writeText(str, x, y)`
- `drawEllipse(x, y, rx, ry)`: `(x, y)` is the center; equal `rx`/`ry`
  draws a circle.
- `clearWhiteboard()`: erases everything currently drawn.

The board is shared with the learner. Its toolbar supports freehand marker
strokes, placed text and object-level erasing. Agent and learner marks live
in one scene with stable IDs and ownership metadata. A compact snapshot of
that scene is sent with each question. Long freehand paths are sampled before
they enter model context.

When the learner changes visual geometry, the next question also carries a
PNG rendered from the canonical scene. That lets the multimodal model
interpret what freehand strokes depict while the structured snapshot grounds
it with exact coordinates, text, colours and ownership. Text-only turns do
not resend an unchanged image.

See `docs/superpowers/specs/2026-08-10-whiteboard-tutor-design.md` (UI/
coordinate system) and
`docs/superpowers/specs/2026-08-10-real-agent-backend-design.md` (agent/
backend) for the full design.

## Setup

```bash
npm install
cp .env.example .env   # then fill in OPENAI_API_KEY
```

## Run it

```bash
npm run dev
```

This starts the Vite frontend and the Express backend together. Open the
printed frontend URL and ask the tutor about anything: it decides what to
explain and draw itself.

## Scripts

- `npm run dev`: start frontend + backend together
- `npm run client`: frontend only
- `npm run server`: backend only
- `npm run build`: typecheck and build the frontend for production
- `npm run typecheck:server`: typecheck the backend
- `npm test`: run the unit test suite
- `npm run lint`: run oxlint
