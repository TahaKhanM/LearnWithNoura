# Real Agent Backend — Design Spec

Date: 2026-08-10

## Purpose

Replace the rule-based mock agent with a real LLM (OpenAI `gpt-5.6-terra`
by default, configurable) that decides what to say and draw via function
calling, using the same `LessonStep[]` interface the frontend already
consumes. Also adds a `clear_whiteboard()` tool so the agent can erase the
board itself instead of only relying on the frontend's clear-on-new-prompt
behavior.

## Why a backend proxy

The OpenAI API key must never reach the browser — any code shipped to the
client is visible to anyone who opens dev tools. A small Express backend
holds the key server-side, calls OpenAI, and returns only the resulting
`LessonStep[]` to the frontend. The frontend's Vite dev server proxies
`/api/*` to this backend so there's no CORS configuration needed.

## New Whiteboard Primitive

```ts
interface ClearStep { type: 'clear' }
function clearWhiteboard(): ClearStep
```

`LessonStep` is now `WhiteboardAction | ChatStep | ClearStep`. `ClearStep`
is intentionally not part of `WhiteboardAction` — it's not a drawable mark,
it's an instruction to reset the board's action list. The step runner gets
a third handler, `onClear`, alongside `onChat` and `onWhiteboardAction`.

## Backend (`server/`)

- **`server/index.ts`** — Express app. Loads `OPENAI_API_KEY`/`OPENAI_MODEL`
  from `.env` via `dotenv`. Exposes `POST /api/tutor`, accepting
  `{ message: string, history: { role: 'user'|'tutor', text: string }[] }`
  and returning `{ steps: LessonStep[] }`. Refuses to start if
  `OPENAI_API_KEY` is missing.
- **`server/tools.ts`** — OpenAI function-calling tool schemas for
  `draw_line`, `write_text`, `draw_ellipse`, `clear_whiteboard`; the system
  prompt describing the coordinate system and the "explain, then draw"
  teaching pattern; and `toolCallToStep(name, args)`, a pure function
  mapping a tool call to a `LessonStep` (or `null` for malformed/unknown
  calls) — this is the unit-tested core of the mapping logic.
- **`server/tutorAgent.ts`** — `runTutorTurn(client, model, history,
  userMessage)`: the agentic loop. Sends the system prompt + prior turns +
  new user message to the model with tools available. Each response's text
  content becomes a `chat` step; each tool call is executed via
  `toolCallToStep` and appended as a step, then a synthetic `tool` result
  message is added to the conversation so the model knows the call
  "succeeded" and can continue. Loops (bounded to `MAX_TOOL_ROUNDS = 12`)
  until the model responds with no tool calls, then returns the accumulated
  `LessonStep[]`.

This design keeps the "explain a bit, draw a bit" interleaving that the
mock agent hand-authored, but now driven by the model's own turn-by-turn
choices rather than a fixed script — the system prompt instructs it to
alternate one short explanation with one tool call per round.

## Frontend Changes

- **`src/agent/tutorClient.ts`** replaces `mockAgent.ts`. `requestLesson
  (userMessage, history)` POSTs to `/api/tutor` and returns the parsed
  `LessonStep[]`. Unlike the mock agent, this is async and can fail (network
  error, non-2xx response) — callers must handle rejection.
- **`App.tsx`**: `handleSubmit` is now async. It keeps a `messagesRef`
  alongside `messages` state so it can synchronously read the full prior
  conversation (needed to send `history` to the backend without a stale
  closure). On request failure, an error is appended to chat as a tutor
  message rather than crashing. Added an `onClear` handler wired to
  `runLessonSteps`, which empties `whiteboardActions`.

## Conversation Memory

Each `/api/tutor` call is stateless on the server — the frontend sends the
full prior chat history (`{ role, text }` pairs, no tool-call detail) as
context on every request. The backend reconstructs OpenAI chat messages
from this history and runs a fresh tool-calling loop for just the new
turn. This keeps the backend simple (no session storage) while still
giving the model conversational context across turns.

## Error Handling

- Missing/invalid `message` in the request body → `400`.
- OpenAI API failure (bad key, model error, network) → `502`, generic
  message; the underlying error is logged server-side, not leaked to the
  client.
- Malformed tool-call arguments from the model (bad JSON, missing required
  fields) → `toolCallToStep` returns `null`; that call is skipped and the
  model is told (via the synthetic tool result) that the call errored, so
  it can retry or move on within the same turn.
- Frontend network/HTTP errors surface as a chat message rather than a
  silent failure or crash.

## Testing

- `server/tools.test.ts` — unit tests for `toolCallToStep` covering all
  four tool names, optional-styling passthrough, missing required
  arguments, and unknown tool names.
- `src/whiteboard/types.test.ts` — extended with a `clearWhiteboard()`
  test.
- The agentic loop itself (`runTutorTurn`) is not unit tested with a mocked
  OpenAI client in this pass — it's thin orchestration over already-tested
  `toolCallToStep`, and is instead verified via live manual testing against
  the real API (see below).
- Manual verification: run both servers, send a real prompt through the
  live OpenAI API, confirm interleaved chat/drawing and a `clear_whiteboard`
  call render correctly.

## Out of Scope (YAGNI)

- Persisting conversation history server-side (frontend resends full
  history each turn instead).
- Streaming responses (tool calls currently resolve as a full round-trip
  per model turn).
- Retry/backoff on transient OpenAI errors.
- Auth on the `/api/tutor` endpoint (single-user local prototype).
