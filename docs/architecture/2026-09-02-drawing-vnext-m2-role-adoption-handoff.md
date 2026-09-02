# Drawing vNext M2 role-adoption handoff

**Date:** 2026-09-02  
**Implementation status:** complete and offline-verified  
**Live-smoke status:** accepted for adopted-role and second-board-change scope after corrected rerun

## Adopted role boundary

Drawing roles now have independent OpenAI Chat Completions adapters:

- `SceneModelPort.streamPropose` owns strict vNext scene-step composition.
- `VisionAuditPort.inspect` owns the bounded first-reveal semantic audit.
- `NOURA_DIRECTOR_MODEL` and `NOURA_DIRECTOR_REASONING_EFFORT` configure only
  composition.
- `NOURA_VISION_AUDIT_MODEL` and
  `NOURA_VISION_AUDIT_REASONING_EFFORT` configure only audit.
- `OPENAI_MODEL` remains the legacy text/compiler default and no longer selects
  either drawing role.

Both ports retain the existing OpenAI Chat Completions path. No provider,
credential, SDK or endpoint was added. The production step response uses the
exact strict vNext `json_schema`, whose schema SHA-256 is
`5ea4e1f0bedc3c0d24279ce548024d815f54674c3cdcec56e7f2755d435e666f`.

## Evidence-backed defaults

| Role | Default | Basis |
|---|---|---|
| Composition primary | `gpt-5.6-terra`, low | Interim composition path; it is not called an M0 winner. |
| Vision audit | `gpt-5.6-luna`, low, 3,000 ms budget | M0 audit-role evidence: 100% seeded-defect catch, 8.33% false reject, 0% invalid, p95 2,398 ms. |
| Recovery | Terra-medium whole-scene escalation | Corrected-gate F9 evidence: 350/360 delivered, 97.2222%, mean blind grade 3.9643. |
| Hedge | off | M0 hedge was less valid and lower quality at greater cost. |

The low-effort targeted placement correction remains available as an explicit
study path, but it is not production default: it recovered only 2/13 F9 rows,
and correction-then-escalation did not improve on medium escalation alone.
Pre-commit provider/parse/validity failure receives at most one medium retry;
failure after any presented step remains terminal so visible work is permanent.

## Privacy and rollback

Contract tests inject a private identity/transcript sentinel into source
objects and prove it is absent from composition, correction and audit messages.
Only teaching intent fields, closed board context, operations and transient
board rasters cross those role boundaries. Free-form audit text is reduced to
closed outcome codes before telemetry or upstream context.

Local and Preview default to streaming. Explicit
`NOURA_DIRECTOR_PIPELINE=classic` is the rollback; Production remains classic
until the live smoke below is authorized and passes. Classic constructs no
audit surface.

## Retained evidence

`server/board/eval/results/2026-09-02-drawing-m2-role-adoption.json` has
SHA-256 `0235f1cfde95421ac27f02252b6b12286282134e7fd973ff6edcb216ed4e4db3`.
`npm run test:role-adoption` reproduces it from the immutable M0 and F9 hashes
plus current runtime contracts. The report made zero provider calls and says
`not_live_verified`; it does not convert earlier offline evidence into a new
live claim.

## Authorized live-smoke result and quality rejection

The user authorized one synthetic lesson under a $1.25 hard ceiling: at most one
Realtime connection, two Terra-low compositions, two Luna-low audits and two
conditional Terra-medium retries, with zero compiler/image calls. A first local
origin check stopped before the provider and consumed zero calls. The corrected
journey then passed the automated gate in 57,199 ms: first and second board
changes were observed, there were no browser errors, telemetry gaps, reconnects
or tutor-object disappearances, and the audit returned `approved`.

Actual paid operations were one Realtime connection, one Terra-low composition
(3,602 input / 294 output tokens), one Luna-low audit (860 input / 113 output),
and no retry: three calls total. Realtime reported 20,465 input-text tokens
(3,008 cached), 596 output-text tokens and 886 output-audio tokens. At published
rates the token-meter estimate is $0.1530788; the conservative accounted upper
bound is $0.68, leaving $0.57 beneath the authorized ceiling. No billing-surface
amount was available, so the estimate is not called an invoice.

Manual rendering rejected the result despite those green automated signals:
the two opposite connector labels overlapped one another and the asset labels.
This exposed a real compiler/preflight/audit blind spot. The exact live scene is
retained by hash, a failing compiler test now reproduces it, and deterministic
label placement was corrected. Its provider-free browser replay passes and the
inspected corrected screenshot SHA-256 is
`fb863df21e4b24e1fc0d9233b42ede75fa174df65e375240dc73445e33ad79c1`.

The negative live report is
`server/board/eval/results/2026-09-02-drawing-m2-live-smoke.json` (SHA-256
`8293830bc09e5ef2581883aaeba3612897dc6f231f5d98a565e52b24e3ad8a93`).
That first authorization was exhausted by its one Realtime connection and did
not authorize a rerun.

## Corrected authorized rerun

The user separately authorized one corrected rerun under a $0.85 ceiling: one
Realtime connection, one Terra-low composition, one Luna-low audit and at most
one conditional Terra-medium retry, with zero compiler, image or targeted-
correction calls. The provider guard reserved at most $0.80 and rejected any
extra call before the provider boundary.

The rerun passed the adopted-role/second-board-change scope with three calls and
no retry. The Luna-low audit approved in 1,850 ms, within its 3,000 ms budget;
the second section was created and opened on the real Lesson page; two live
incremental frames were manually inspected with no overlap; and there were no
browser errors, telemetry gaps, reconnects or tutor-object disappearances.
Measured token usage estimates $0.1412604; the conservative upper bound is
$0.68, leaving $0.17 under the fresh ceiling.

The observer ended before the third storyboard reveal, so that reveal is not
claimed live. The terminal six-object provider scene is retained and its full
corrected-browser replay was inspected offline: both directions and all labels
are clear. Corrected rerun result SHA-256:
`80f9cc3d50467e9a36be7cf6dd27d2bbb17d3ddb52ad7d2fdc0df397f339bf63`.
This closes M2’s required short smoke for the stated scope while preserving the
third-live-reveal and target-hardware boundaries as unverified.
