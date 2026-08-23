# Board Intelligence v2

Date: 2026-08-23. Status: active.

## Objective

Make the board a pedagogical instrument rather than a stream of model-drawn SVG commands. The system must decide whether a visual is relevant, compose it without cross-topic collisions, keep the learner oriented, understand learner marks with calibrated uncertainty, preserve what was actually seen, and give the agent actionable feedback when a proposed visual fails.

## Research translated into engineering constraints

- OpenAI Realtime sessions support state updates, image input and function-call results in the same conversation. Realtime prompting guidance recommends explicit trigger/action/exception rules, long-session state, and tool-level policies. Noura therefore updates authoritative board state in session instructions, exposes `inspect_board`, supplies structured tool outputs, and sends a full-board/detail image for learner marks. Sources: [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), [Realtime model prompting](https://developers.openai.com/api/docs/guides/realtime-models-prompting), [GPT-Realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1).
- Mature layout systems treat nodes, labels, edges, ports and components as distinct spacing classes; layered layouts separate cycle breaking, rank assignment, crossing minimization, node placement and edge routing. Noura mirrors those principles with section-scoped composition, node/label/edge spacing, hierarchy ranks, stable ordering, routed connectors, crossing checks and density budgets. Sources: [ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html), [ELK spacing](https://eclipse.dev/elk/documentation/tooldevelopers/graphdatastructure/spacingdocumentation.html).
- Educational signaling is useful when it identifies the specific text–diagram correspondence rather than amplifying the whole picture. Noura therefore uses synchronized item-level highlights and temporarily de-emphasizes unrelated tutor marks. Source: [Richter, Scheiter & Eitel, 2015](https://doi.org/10.1016/j.learninstruc.2014.11.002).
- Simple vector gesture recognition is useful as a geometric hint but is not semantic understanding. Noura derives shape, closure, straightness, bounds and proximity from vectors, then combines those hints with Realtime vision and asks for clarification when intent is ambiguous. Source: [$1 recognizer project and paper](https://depts.washington.edu/acelab/proj/dollar/index.html).
- Board changes are conveyed through one atomic status message without moving focus; sections remain keyboard-selectable and compact views expose every required label/equation. Source: [WCAG 2.2 Understanding](https://www.w3.org/WAI/WCAG22/Understanding/).

## Pipeline

`Learner need → Visual Plan 2.0 relevance decision → inspect/reuse/replace/create → semantic grammar → section-scoped exact BoardOps → geometry layout → quality budget → heard checkpoint → visible section → replay acknowledgement → authoritative board ledger`

Learner marks follow a parallel path:

`Vector stroke → learner-owned BoardOp → deterministic stroke features → full-board + detail composite → Realtime image input → calibrated response/adaptation`

## Invariants

1. Distinct semantic groups are pages/sections, never layers painted into the same coordinate plane.
2. Learner marks belong to the active section and survive tutor replacement or clear operations.
3. Only heard and acknowledged tutor checkpoints enter durable replay and agent board state.
4. Visual Plan 2.0 states relevance, the concrete question answered, action, target section and density.
5. `reuse` and `skip` create no section. `replace` is one atomic checkpoint: the section-scoped clear and the replacement content commit in a single visible frame (no standalone clear, no draw-on gap). If the learner has marks in the target section, the replacement is forked into a new section version (`…-v2`) instead of changing the geometry under their work, and a replacement is refused entirely while a learner drawing draft is open. Raw model-issued `clear` is rejected.
6. Minimal sections contain at most 14 proposed operations; standard sections at most 30. The rendered section also has a 30-item, 720-character and crossing budget.
7. A failed client quality check is reported to the agent; rejected marks are never described as visible.
8. Vector learner analysis is explicitly a spatial hint. Vision or learner clarification supplies meaning.
9. User-facing board awareness uses one atomic status, named sections and specific signaling; it never steals focus.

## General visual grammar

In addition to exact subject templates, Plan 2.0 provides:

- `relationship_map`: flow, hierarchy or cycle with typed nodes/edges;
- `worked_steps`: ordered derivation/procedure with routed continuation;
- `comparison`: aligned two-column evidence;
- `part_whole`: proportional strip plus exact total equation.

The model specifies meaning and relationships. Code owns geometry, spacing, routing, density and acceptance.

## Evaluation boundary

Deterministic tests cover schema policy, reuse/replace behavior, section isolation, learner ownership, vector features, board context, exact redraw suppression, density rejection, client rejection feedback, geometry collision, connector crossings, compact traversal, status semantics and composite image dimensions. Visual baselines cover every subject template and general grammar at desktop/tablet/mobile focus plus the real Lesson board-awareness surface.

Live-provider semantic interpretation and physical-device drawing remain evaluation tasks rather than facts inferred from deterministic fixtures.
