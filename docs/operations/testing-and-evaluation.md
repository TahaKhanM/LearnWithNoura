# Noura testing and evaluation runbook

## Default offline gates

Run the commands in README. Unit/property coverage includes state transitions, response taxonomy, evidence projection, event identity, 1,000 reordered stale-event runs, storage cutoffs, owner-aware operations, render inspection, committed animation cancellation, character priority/smoothing, Postgres snapshot parity, summary citation validation, security capabilities and Production fail-closed configuration.

Browser suites use a dedicated synthetic SQLite directory and separate ports. Visual baselines cover Noura Home at 1440×900, 834×1112, 390×844 and 844×390 plus every canonical semantic scene at desktop, tablet and mobile-focus widths.

## Live-provider budget

Offline fixtures are the default. `npm run test:av` drives the production `ResponseCueTimeline` and `CharacterAttentionController`, derives silence from PCM windows, cue error from annotated versus observed release events, final correction from observed playback completion, frame p95 from captured timestamps, and stale writes from rejected post-cancel events. Each audiovisual gate has a negative source-trace fixture that must fail. The JSON report, WAV and MP4 are written under `artifacts/evaluation/`; they are deterministic offline evidence, not provider or target-hardware evidence.

A pre-merge live smoke is limited to two short synthetic sessions. Record runtime model IDs, audio duration, token usage and provider-reported cost. Never loop paid calls for screenshots.

## Target hardware

Record device, OS, browser, headphones/speakers, noise condition, autoplay, permission denial, single/repeated barge-in, portrait/landscape, touch/pointer/drawing gaze and reduced motion. Measure:

- child acoustic onset → detector;
- detector → stop scheduled;
- scheduled stop → recorded acoustic silence;
- provider cancellation confirmation;
- caption phrase and visual cue error;
- avatar mouth/gaze/pen timestamps;
- frame intervals and long tasks.

If loopback/recorded hardware evidence is absent, mark acoustic results UNVERIFIED. Synthetic PCM cannot substitute for target hardware.

Browser coverage includes a real Lesson component with deterministic fake WebSocket/PCM events for start, listening, thinking, speaking, semantic visual focus, question caption, highlight gaze and drawing interruption. It asserts stale future visual rejection, semantic view geometry, 44 px controls, focus visibility/order, reduced motion, 320 px, mobile landscape and a 200% zoom/reflow state. This proves browser integration without claiming live provider or physical-device behavior.

Camera scenarios are not applicable because camera support is not implemented.
