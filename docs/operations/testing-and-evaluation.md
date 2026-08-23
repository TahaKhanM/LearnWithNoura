# Noura testing and evaluation runbook

## Default offline gates

Run the commands in README. Unit/property coverage includes state transitions, response taxonomy, evidence projection, event identity, 1,000 reordered stale-event runs, storage cutoffs, owner-aware operations, render inspection, committed animation cancellation, character priority/smoothing, Postgres snapshot parity, summary citation validation, security capabilities and Production fail-closed configuration.

Browser suites use a dedicated synthetic SQLite directory and separate ports. Visual baselines cover Noura Home at 1440×900, 834×1112, 390×844 and 844×390 plus every canonical semantic scene at desktop, tablet and mobile-focus widths.

## Live-provider budget

Offline fixtures are the default. A pre-merge live smoke is limited to two short synthetic sessions. Record runtime model IDs, audio duration, token usage and provider-reported cost. Never loop paid calls for screenshots.

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

Camera scenarios are not applicable because camera support is not implemented.
