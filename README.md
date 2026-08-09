# Seneca

An AI tutor that teaches on a whiteboard instead of purely through chat. A
left-hand chat panel carries narration and supplemental explanation, while
the tutor draws on a coordinate-based whiteboard alongside it.

This prototype ships with a rule-based mock agent (no API key required) that
recognizes a few keywords and plays back a scripted lesson step-by-step. The
agent's output is a plain JSON action list, so a real LLM can be wired in
later behind the same interface.

## Whiteboard tool interface

The whiteboard is a fixed 1000×600 logical coordinate grid (origin
top-left), scaled responsively to fill the panel. An agent draws on it with:

- `DrawLine(x1, y1, x2, y2)`
- `writeText(str, x, y)`
- `drawEllipse(x, y, rx, ry)`: `(x, y)` is the center; equal `rx`/`ry`
  draws a circle.

See `docs/superpowers/specs/2026-08-10-whiteboard-tutor-design.md` for the
full design.

## Try it

```bash
npm install
npm run dev
```

Ask the tutor about "the pythagorean theorem", "slope of a line" or "area
of a circle" in the chat box.

## Scripts

- `npm run dev`: start the dev server
- `npm run build`: typecheck and build for production
- `npm test`: run the unit test suite
- `npm run lint`: run oxlint
