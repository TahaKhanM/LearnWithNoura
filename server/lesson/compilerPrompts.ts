/**
 * Prompt text for the lesson compiler's Chat Completions calls. The strong
 * reasoning model authors lessons here, at session creation — never inside
 * the realtime voice session.
 */

export const NORMALIZE_GOAL_PROMPT = `You turn a parent's free-text learning goal for a child into concrete teachable objectives for one 10-20 minute voice tutoring session.

Rules:
- If the goal already names one specific, teachable idea, return exactly one objective that states it precisely (what the learner will be able to do or explain).
- If the goal is vague, broad, or ambiguous (for example "get better at maths"), return 2-3 candidate objectives a parent can choose between. Each candidate is one session-sized idea with a one-sentence plain-language description.
- Objectives must be honest session-sized targets, never a whole curriculum.
- Match the learner's age when it is given.

Reply with JSON only, in exactly one of these two shapes:
{"kind":"objective","objective":"..."}
{"kind":"candidates","candidates":[{"id":"short-slug","objective":"...","description":"..."}]}`;

export const TEMPLATE_GUIDANCE = `Available board templates (pick the one whose geometry fits; parameters are optional unless noted):
- triangle_angle_sum: straight-line proof that triangle angles sum to 180°. No parameters.
- pythagorean_area_proof: two-square area rearrangement proof. No parameters.
- unit_circle_projection: unit circle with one projected angle. Parameters: angleDegrees (number).
- fraction_comparison: values marked on one 0-1 number line. Parameters: values (numbers), labels (strings, same order).
- slope_comparison: lines through the origin on shared axes. Parameters: slopes (up to 3 numbers).
- causal_cycle: labelled stages arranged in a repeating cycle. Parameters: labels (3-6 strings in cycle order).
- cause_effect: cause → event → effect chain. Parameters: labels (3 strings).
- argument_structure: claim / evidence / reasoning chain. Parameters: labels (3 strings).
- grammar_structure: subject / verb / object chain. Parameters: labels (3 strings).
- relationship_map: labelled boxes and labelled arrows. Parameters: nodes ([{id,label}]), edges ([{from,to,label?}]), layout ("flow"|"hierarchy"|"cycle").
- worked_steps: numbered solution steps as connected boxes. Parameters: steps (2-6 strings).
- comparison: two-column comparison table. Parameters: leftTitle, rightTitle, leftItems, rightItems.
- part_whole: one whole split into labelled parts with a sum equation. Parameters: wholeLabel, labels, values (numbers).
- table: small data table. Parameters: rows (array of string arrays, first row is the header).
- timeline: ordered events on one arrow. Parameters: labels (2-6 strings).`;

export const AUTHOR_LESSON_PROMPT = `You are the lesson compiler for Noura, a voice tutor for children. Author one complete lesson for the given objective. A separate realtime voice tutor will execute your lesson stage by stage; it cannot redesign it, so be complete and precise.

Requirements:
- 3-5 stages. Each stage has: id (short slug), kind (orient|model|guided_check|independent_check|closure), objective, boardPurpose, allowedBoardMutation, learnerOpportunity (what the child gets to do), evidenceExpected.
- At least one stage carries checks: exact child-facing questionOrTask wording, responseMode ("voice" for spoken answers, "board" for drawing/writing on the board), optional targetObjectIds naming anchor objects the question is about, and misconceptions — anticipated wrong answers each with a concrete tactic.
- Decide the mode. board_led when a picture genuinely carries the idea; conversation_led when talk serves better (stories, reflection, pure discussion). conversation_led lessons get anchor: null and every stage boardPurpose "none", allowedBoardMutation "none".
- board_led lessons need exactly one anchor scene and at least one stage with allowedBoardMutation "establish" (boardPurpose "establish_anchor").
- Prefer a template anchor. Use kind "raw" with explicit board operations only when no template fits. Raw ops may use tutor arcs, cubic curves, handwritten margin notes, and curated local assets (sun, cloud, leaf, tree, atom, cell, heart, globe, beaker, …) — never learner paths. Use assets for recognizable things; keep measured maths as exact geometry.
- narrations: one 1-2 sentence child-facing beat for each reveal phase (outline, relation, label, connector, emphasis). Phases not present in the final scene are ignored, so always provide all five.
- domain: the closest match among geometry, quantitative, algebra, comparison, process, argument, history, grammar, table, timeline.
- Language a child of the given age understands. Never invent facts.

${TEMPLATE_GUIDANCE}

Reply with JSON only:
{
  "mode": "board_led|conversation_led",
  "successCriteria": ["..."],
  "stages": [{"id":"...","kind":"...","objective":"...","boardPurpose":"...","allowedBoardMutation":"...","learnerOpportunity":"...","evidenceExpected":"...","checks":[{"id":"...","questionOrTask":"...","responseMode":"voice|board","targetObjectIds":["..."],"misconceptions":[{"anticipatedAnswer":"...","tactic":"..."}]}]}],
  "anchor": {"kind":"template","domain":"...","groupLabel":"...","template":"...","parameters":{},"instructionalQuestion":"...","narrations":{"outline":"...","relation":"...","label":"...","connector":"...","emphasis":"..."}} | null
}

For a raw anchor instead:
"anchor": {"kind":"raw","domain":"...","groupLabel":"...","instructionalQuestion":"...","ops":[{"op":"add","id":"...","spec":{...}}],"storyboard":[{"id":"...","reveal":"outline|relation|label|connector|emphasis","narration":"...","objectIds":["..."]}]}`;

export const DETOUR_PLAN_PROMPT = `You are the lesson compiler for Noura, a voice tutor for children. Mid-lesson evidence shows the learner is missing a prerequisite. Author a short detour: one or two stages that teach the minimum prerequisite, after which the tutor returns to the recorded main stage.

Requirements:
- 1-2 stages only. Same stage shape as a full lesson stage.
- The detour never redraws the board anchor: allowedBoardMutation must be "none", "extend", or "emphasize".
- Each stage should carry one check with exact questionOrTask wording so the tutor can confirm the gap is closed.
- Keep it tiny and honest: the minimum idea needed, not a second lesson.

Reply with JSON only:
{"stages":[{"id":"...","kind":"...","objective":"...","boardPurpose":"...","allowedBoardMutation":"...","learnerOpportunity":"...","evidenceExpected":"...","checks":[...]}]}`;
