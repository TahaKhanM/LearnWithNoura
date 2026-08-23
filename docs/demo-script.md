# Seneca — manual demo script (~4 minutes)

Prep: `npm run dev`, open http://localhost:5173 in Chrome, allow the
microphone when asked. Headphones recommended.

1. **Home.** Add a learner (name + age) or pick one. Type a goal — use
   something you haven't rehearsed, e.g. *"Why do heavier things not fall
   faster?"* — and press **Start lesson**.

2. **Live teaching.** Press **Start the lesson**. Seneca greets the child
   by name and begins the goal immediately, speaking short sentences and
   drawing as it goes. Point out: the pen follows the stroke being drawn,
   marks land in sync with the words about them, and the "Now:" chip
   tracks the concept.

3. **Interrupt it.** While it is mid-sentence, just start talking:
   *"Wait, stop — I don't get that part."* The voice stops instantly,
   the caption freezes exactly where the child stopped hearing, and
   Seneca answers the actual question — usually changing its visual
   approach rather than repeating itself.

4. **Answer a question (or answer it wrong).** Seneca asks small
   diagnostic questions as it teaches. Give a wrong answer on purpose.
   It should probe or re-teach differently, and quietly record evidence.

5. **Draw on the board.** Pick the pen (top right), sketch something
   near its diagram, then ask *"what could my drawing be in your
   picture?"* Seneca sees a description of the board, including your
   marks, and folds them in.

6. **Refresh the page** mid-lesson (optional but strong): the board
   replays exactly what was shown and Seneca resumes in context instead
   of starting over.

7. **End lesson.** Press **End lesson**. You land on the parent
   dashboard: a headline, what was worked on, strengths and struggles
   each backed by what the child actually said, a recommended next step,
   and an honest note about how much evidence the session produced.
   Open **Details** on the session for the full timeline — including the
   moments the child interrupted.

Failure-mode encores, if asked:

- Block the microphone in site settings and reload → typing still works,
  Seneca still speaks.
- Restart the backend with `OPENAI_REALTIME_MODEL=gpt-bogus-model` →
  the lesson announces text mode and keeps teaching with captions and
  live drawings.
