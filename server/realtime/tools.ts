/**
 * Tool surface exposed to the realtime tutor. Deliberately small: draw,
 * record what the learner showed, and keep the lesson plan current. The
 * lesson blueprint itself is compiled before the session ever starts; the
 * realtime tutor executes it and never authors one.
 */

export const REALTIME_TOOLS = [
  {
    type: 'function' as const,
    name: 'inspect_board',
    description:
      'Read the authoritative visible board sections, reusable object IDs, density, and recent learner-mark observations. Call before adapting an existing visual or whenever the learner refers to “this”, “that”, or their drawing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        focus: { type: 'string', maxLength: 160, description: 'Optional object, group, or learner-mark id to inspect.' },
      },
    },
  },
  {
    type: 'function' as const,
    name: 'request_visual',
    description:
      'Request a new representation by INTENT; you never supply geometry. Use establish for the first figure on a blank board in any lesson (including a learner-requested number line, graph, diagram, or sketch), compare for a new side representation, and emphasize for visible named objects. The application designs, validates in the learner browser, vision-checks, and reveals new scenes. Use board_ops only for a small fast increment attached to work that is already visible. Actions are additive only; never call this twice in one tutor turn or while a build is in progress.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schemaVersion: { type: 'string', enum: ['3.0.0'] },
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        action: { type: 'string', enum: ['establish', 'extend', 'emphasize', 'compare', 'none'] },
        purpose: { type: 'string', minLength: 1, maxLength: 300, description: 'Why the current stage needs this visual right now.' },
        idea: { type: 'string', minLength: 1, maxLength: 300, description: 'The one relationship or idea the picture must show, concretely.' },
        constraints: { type: 'string', maxLength: 300, description: 'Optional requirements, e.g. "use a number line", "keep it very simple", "reuse the fractions already shown".' },
        targetGroupId: { type: 'string', minLength: 1, maxLength: 160, description: 'For extend: the visible section to add to.' },
        targetObjectIds: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 160 }, description: 'For emphasize: the visible object ids to highlight. For establish/compare: visible objects the new picture relates to.' },
        density: { type: 'string', enum: ['minimal', 'standard'] },
        noBoardReason: { type: 'string', maxLength: 300 },
      },
      required: ['schemaVersion', 'requestId', 'action', 'purpose', 'idea', 'density'],
    },
  },
  {
    type: 'function' as const,
    name: 'propose_teaching_move',
    description:
      'Propose the next pedagogical move executing the CURRENT blueprint stage. Deterministic lesson code validates stage legality, anchor stability, and whether waiting is legal. Not a gate before a visual request: request the representation first, then use this when handing a question or recording the move. Exception: a stage other than the current one is rejected unless you record a prerequisite detour.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        classification: {
          type: 'string',
          enum: ['correct', 'partially_correct', 'incorrect', 'confident_misconception', 'confusion', 'missing_prerequisite', 'irrelevant', 'self_corrected', 'uncertain_or_ambiguous', 'no_meaningful_response'],
        },
        rationale: { type: 'string', minLength: 1, maxLength: 600 },
        microObjective: { type: 'string', minLength: 1, maxLength: 220 },
        strategy: { type: 'string', minLength: 1, maxLength: 220 },
        visualStrategy: { type: 'string', minLength: 1, maxLength: 220 },
        semanticObjectId: { type: 'string', minLength: 1, maxLength: 160 },
        childFacingText: { type: 'string', minLength: 1, maxLength: 1200 },
        questionOrTask: { type: 'string', minLength: 1, maxLength: 500, description: 'The exact question or small task handed to the learner. Works for imperatives too, e.g. "Circle the acute angle." Providing this yields the floor once it has been spoken.' },
        taskId: { type: 'string', minLength: 1, maxLength: 160 },
        responseMode: {
          type: 'string',
          enum: ['voice', 'text', 'draw', 'choice', 'mixed', 'manipulate'],
          description: 'How the learner should answer questionOrTask. Use "draw" (or "mixed" for draw-and-explain) for drawing tasks, or "manipulate" when the learner moves or taps board widgets: they press Done once; the board checks locally before you react.',
        },
        proposedAction: { type: 'string', enum: ['explain', 'visual', 'question', 'wait', 'feedback', 'practice', 'reteach', 'advance', 'complete'] },
        blueprintId: { type: 'string', minLength: 1, maxLength: 120 },
        stageId: { type: 'string', minLength: 1, maxLength: 80, description: 'The current blueprint stage this move executes.' },
        goalLink: { type: 'string', minLength: 1, maxLength: 300, description: 'One sentence: why this move advances the current stage.' },
        boardPurpose: { type: 'string', enum: ['establish_anchor', 'reveal_relation', 'demonstrate_change', 'compare_cases', 'elicit_learner_work', 'test_prediction', 'summarize', 'none'] },
        anchorGroupId: { type: 'string', minLength: 1, maxLength: 160 },
        targetObjectIds: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 160 }, description: 'The visible board objects this move refers to or asks about.' },
        learnerOpportunityId: { type: 'string', minLength: 1, maxLength: 160 },
        expectedEvidence: { type: 'string', minLength: 1, maxLength: 240 },
        detourReason: { type: 'string', minLength: 1, maxLength: 240, description: 'Record a bounded prerequisite detour; the lesson returns to the recorded stage afterwards.' },
        returnStageId: { type: 'string', minLength: 1, maxLength: 80 },
      },
      required: ['rationale', 'microObjective', 'strategy', 'childFacingText', 'proposedAction'],
    },
  },
  {
    type: 'function' as const,
    name: 'board_ops',
    description:
      'Fast, atomic increments on work that is already visible: highlight/update a visible object or add code-owned annotate marks targeting a visible semantic object/sub-anchor or learner-stroke id. Annotation geometry is computed by the application; use a raw point only as a last resort. New figures and representations—including the first marks on a blank board—go through request_visual. A successful status visible means first paint was confirmed in the learner browser. There is no clear or replace operation: visible work persists.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ops: {
          type: 'array',
          description: 'Drawing operations, applied in order.',
          items: { type: 'object' },
        },
      },
      required: ['ops'],
    },
  },
  {
    type: 'function' as const,
    name: 'ground_image_region',
    description:
      'Point an annotation at a named region inside an existing visible image. Supply only the visible image id, a concrete target hint, annotation style, and optional note. The application proposes a normalized region, renders it back, verifies it with the audit role, and asks the learner to tap only when confidence is low. Do not use for ordinary vector objects; use fast board_ops annotate instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requestId: { type: 'string', minLength: 1, maxLength: 120 },
        imageId: { type: 'string', minLength: 1, maxLength: 40 },
        hint: { type: 'string', minLength: 2, maxLength: 200 },
        style: { type: 'string', enum: ['circle', 'underline', 'arrow', 'tick', 'cross', 'bracket', 'callout', 'highlighter'] },
        note: { type: 'string', maxLength: 120 },
      },
      required: ['requestId', 'imageId', 'hint', 'style'],
    },
  },
  {
    type: 'function' as const,
    name: 'record_evidence',
    description:
      'Record what the learner just showed about their understanding. Call this whenever the learner answers a question, explains something, makes a revealing mistake, or shows confusion. Be specific and honest — this feeds the parent report.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        concept: {
          type: 'string',
          description: 'The specific concept assessed, e.g. "angle sum of a triangle".',
        },
        observation: {
          type: 'string',
          description: 'What the learner said or did, in one or two factual sentences.',
        },
        verdict: {
          type: 'string',
          enum: ['progressing', 'struggling', 'misconception'],
          description:
            'mastered: showed solid understanding. progressing: partial. struggling: could not do it. misconception: holds a specific wrong belief.',
        },
        classification: {
          type: 'string',
          enum: ['correct', 'partially_correct', 'incorrect', 'confident_misconception', 'confusion', 'missing_prerequisite', 'irrelevant', 'self_corrected', 'uncertain_or_ambiguous', 'no_meaningful_response'],
          description: 'The response taxonomy. One correct answer is never mastery.',
        },
        confidence_basis: { type: 'string', description: 'Why this confidence level is justified.' },
        task_id: { type: 'string', description: 'The delivered question or opportunity that produced this evidence.' },
        opportunity_kind: {
          type: 'string',
          enum: ['recall', 'explanation', 'application', 'retrieval'],
          description: 'What kind of independent opportunity produced this evidence. Retrieval means a later revisit, not an immediate retry.',
        },
        retrieval_of: { type: 'string', description: 'Earlier task ID revisited by a genuine later retrieval opportunity.' },
        contradicts: { type: 'array', items: { type: 'string' }, description: 'Earlier evidence IDs this observation conflicts with.' },
        supersedes: { type: 'array', items: { type: 'string' }, description: 'Earlier evidence IDs explicitly resolved by this independent observation.' },
        confidence: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'How much weight this single observation deserves.',
        },
        excerpt: {
          type: 'string',
          description: 'Short quote of what the learner said, if available.',
        },
      },
      required: ['concept', 'observation', 'verdict', 'confidence', 'classification', 'confidence_basis', 'task_id', 'opportunity_kind'],
    },
  },
  {
    type: 'function' as const,
    name: 'update_lesson_state',
    description:
      'Keep the visible lesson state current. Call when the focus shifts to a new concept, when you change teaching strategy, or when you decide the next step.',
    parameters: {
      type: 'object',
      properties: {
        active_concept: {
          type: 'string',
          description: 'The concept being worked on right now, in a child-friendly phrase.',
        },
        strategy: {
          type: 'string',
          description: 'Current teaching approach, e.g. "concrete example", "visual proof", "practice question".',
        },
        next_step: {
          type: 'string',
          description: 'What you plan to do next and why, one sentence.',
        },
      },
      required: ['active_concept'],
    },
  },
];
