# Noura testing and evaluation runbook

## Default offline gates

Run the commands in README, including `npm run test:smoke-report` before `npm test`. The deterministic Node reporter suite checks the explicit authorization boundary, structured configuration failures, truncation/provider-usage gates, and privacy redaction without opening a browser or claiming live evidence. Unit/property coverage includes state transitions, response taxonomy, evidence projection, event identity, 1,000 reordered stale-event runs, storage cutoffs, owner-aware operations, render inspection, committed animation cancellation, character priority/smoothing, Postgres snapshot parity, summary citation validation, security capabilities and Production fail-closed configuration.

Browser suites use a dedicated synthetic SQLite directory and separate ports. Visual baselines cover Noura Home at 1440×900, 834×1112, 390×844 and 844×390 plus every canonical semantic scene at desktop, tablet and mobile-focus widths.

Voice-interruption unit/integration rows cover short loud noise plus server VAD, sustained local energy without server confirmation, adaptive room-noise calibration, sustained speech with both detectors, one-turn high-eagerness endpointing with medium restoration, the `speech_stopped → thinking` phase, and speech-end-to-response/audio metrics. These deterministic checks prevent false cancellation and turn-latency lifecycle regressions but do not replace physical-room microphone testing.

The actual Lesson browser rows require an animated tutor object to survive callback/phase re-renders and mid-animation learner interruption, finish visibly, emit replay acknowledgement after identity replacement, retain the learner stroke, and send a board-only response request with sanitized path operations plus a size-bounded JPEG board context. Another adversarial browser row reconstructs the reported triangle/text overlap, requires the annotation coordinate to move, samples the rendered triangle path every two board units and fails if any stroke enters the padded text box. A separate row verifies the visible thinking state at speech stop before reply audio.

Board Intelligence v2 tests reconstruct released tutor and learner objects while excluding unheard events; require reusable section/object IDs in Realtime/fallback context; enforce relevance/action/density policy; suppress exact raw redraws and mostly equivalent semantic scenes; preserve learner marks across section clear/replace; and feed client quality rejection back to the agent. Learner-sketch tests cover line/underline/circle features, bounds, nearest/touched tutor objects, section ownership and the 960×576 full-board/detail composite. These features do not prove learner intent.

Canonical geometry includes every exact subject template plus relationship-map, worked-step, comparison and proportional part–whole grammars at desktop, tablet and mobile-focus sizes. Compact traversal must expose every required annotation/equation without clipping. The real Lesson has desktop/mobile board-awareness baselines; adversarial browser coverage verifies section isolation, section-bound learner marks, specific highlight de-emphasis, status semantics and the original triangle/text stroke collision.

## Prepared live-provider smoke

Offline fixtures are the default. `npm run test:av` drives the production `ResponseCueTimeline` and `CharacterAttentionController`; it derives one caption-cue error and one visual-cue error from observed scheduler releases, final correction from observed playback completion, pending/stale cues from post-cancel scheduler state, interruption attention from controller output, and audio resumption/silence from PCM windows. It retains seven non-redundant gates and publishes a full 7×7 negative-control matrix. Every row mutates captured trace or PCM input, must make its named gate false, and must leave all six unrelated gates at the passing baseline; the evaluator exits nonzero if isolation fails. It does not report distribution percentiles from single observations. The JSON report and WAV are written under `artifacts/evaluation/`; they are deterministic offline production-module evidence, not provider, rendered-browser, frame-performance or target-hardware evidence. The former generic drawbox MP4 and assigned mobile-frame/render-phase metrics were removed because they did not observe a Noura application surface.

The synthetic live reporter is prepared but remains unexecuted:

```bash
# DO NOT RUN without explicit deployment and live-provider authorization.
NOURA_BASE_URL=https://authorized-origin.example npm run e2e:live -- --authorized-live-run --text-only
```

The WAV form supplies one synthetic capture path instead of `--text-only`. The script captures the created lesson session ID, then uses the still-authenticated browser context to read `/api/version` and `GET /api/sessions/:id/log`; it never queries SQLite directly. A WAV report exits nonzero when speech-end-to-response-start, speech-end-to-first-audio, tutor-audio-duration, or provider-usage observations are absent. Text-only mode requires its text-ask first-audio boundary and does not require either speech-end metric.

The one JSON report contains:

- preparation/evidence mode, configured base URL, actual navigated origin, git SHA, runtime model IDs, scenario, session ID, and elapsed smoke duration;
- the exact sum of logged `tutor_audio_output_duration` rows;
- provider-reported token-usage totals projected from `response.done.response.usage`;
- optional `NOURA_PROVIDER_REPORTED_COST_USD`, explicitly identified as user-supplied from the provider billing surface;
- the complete Phase 0 duration/count summary and truncation state;
- bounded tutor-caption, learner-line, board-item, and browser-console-error counts plus hardcoded milestone labels, never raw caption, learner, or console strings;
- smoke-gate missing observations plus `requiresAuthorizedLiveVerification` entries for acoustic onset/silence and target hardware.

The smoke gate fails if the parent-scoped log is truncated or provider usage is missing. `response.done` does not contain a per-response currency charge. After an authorized run, any currency amount must be manually reconciled from the provider billing surface. A local rate-card multiplication is allowed only when labelled **estimate**, with the rate-card source and source date; it is never “provider-reported cost.” `--report-fixture <path>` and `npm run test:smoke-report` are offline deterministic report checks and remain explicitly non-provider evidence even if a fixture contains token counts.

A future authorized pre-merge live smoke remains limited to two short synthetic sessions. Never loop paid calls for screenshots. Until that authorization and run occur, live-provider behavior, live latency, billed currency, acoustic silence, and target-hardware results remain UNVERIFIED.

## Target hardware

Record device, OS, browser, headphones/speakers, noise condition, autoplay, permission denial, single/repeated barge-in, portrait/landscape, touch/pointer/drawing gaze and reduced motion. Measure:

- child acoustic onset → detector;
- detector → stop scheduled;
- scheduled stop → recorded acoustic silence;
- provider cancellation confirmation;
- provider speech end → response start;
- provider speech end → first reply audio;
- caption phrase and visual cue error;
- avatar mouth/gaze/pen timestamps;
- frame intervals and long tasks.

If loopback/recorded hardware evidence is absent, mark acoustic results UNVERIFIED. Synthetic PCM cannot substitute for target hardware.

Browser coverage includes a real Lesson component with deterministic fake WebSocket/PCM events for start, listening, thinking, speaking, semantic visual focus, question caption, highlight gaze and drawing interruption. It asserts stale future visual rejection, semantic view geometry, 44 px controls, focus visibility/order, reduced motion, 320 px, mobile landscape and a 640×400 effective-viewport reflow surrogate for a 1280×800 page at 200%. The surrogate exercises the compact width/height media-query path and checks labelled section/previous/next/overview controls, 2 px focus appearance, full required-text containment, at least 16 px active educational text, at least 44 px controls and no two-dimensional document overflow. Playwright does not automate browser UI zoom here, so genuine browser zoom remains UNVERIFIED. This proves browser integration without claiming live provider or physical-device behavior.

Camera scenarios are not applicable because camera support is not implemented.
