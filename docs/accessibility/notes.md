# Noura accessibility and responsive notes

Target: WCAG 2.2 AA.

- Home and Parent Area use document scrolling; Lesson alone owns a `100dvh` fixed teaching viewport with safe-area insets.
- Parent setup uses visible labels, field-level errors, loading/error/retry states and explicit selected learner.
- Core child actions and board tools are at least 44px; other controls meet the 24px minimum and spacing rule in tested states.
- Focus indicators are visible. Parent session rows expose `aria-expanded`; board items can receive meaningful focus.
- Board has a short accessible name plus a live long description/object relationship list.
- Caption phrases are segmented instead of hidden with line-clamp. The full caption history remains programmatically available.
- Colour tokens were darkened for contrast, and line/equation associations use labels as well as colour.
- Mobile focus mode keeps the working board readable and pannable; the overview toggle fits the full scene.
- Reduced motion removes spatial character motion and progressive drawing while retaining ordered state/cue changes.
- Character phase is duplicated in status text and is never the only signal.

Automated axe checks cover Home and a canonical board state. Automated compact-layout coverage includes a 640×400 effective-viewport surrogate for 200% reflow, not browser UI zoom. Manual screen-reader, genuine 200% browser zoom and target-device touch review remain required before Production.
