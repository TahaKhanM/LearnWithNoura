/**
 * Tool surface exposed to the realtime tutor. Deliberately small: draw,
 * record what the learner showed, and keep the lesson plan current.
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
    name: 'semantic_visual_plan',
    description:
      'Decide whether a visual earns its place, then describe at most one semantic board section. Code owns composition, exact geometry, spacing, inspection, reveal order, and acceptance. Reuse/skip creates no new section; use no_board when speech is clearer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schemaVersion: { type: 'string', enum: ['2.0.0'] },
        planId: { type: 'string', minLength: 1, maxLength: 120 },
        intent: {
          type: 'object', additionalProperties: false,
          properties: {
            objective: { type: 'string', minLength: 1, maxLength: 300 },
            domain: { type: 'string', enum: ['geometry', 'quantitative', 'algebra', 'comparison', 'process', 'argument', 'history', 'grammar', 'table', 'timeline', 'none'] },
            relevance: { type: 'string', enum: ['essential', 'supportive', 'none'] },
            questionAnswered: { type: 'string', minLength: 1, maxLength: 300 },
            rationale: { type: 'string', minLength: 1, maxLength: 400 },
            action: { type: 'string', enum: ['create', 'reuse', 'replace', 'skip'] },
            targetGroupId: { type: 'string', minLength: 1, maxLength: 160 },
            density: { type: 'string', enum: ['minimal', 'standard'] },
            noBoardReason: { type: 'string', maxLength: 300 },
          },
          required: ['objective', 'domain', 'relevance', 'questionAnswered', 'rationale', 'action', 'density'],
        },
        groups: {
          type: 'array', minItems: 0, maxItems: 1,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 80 },
              label: { type: 'string', minLength: 1, maxLength: 160 },
              revealOrder: { type: 'array', minItems: 1, items: { type: 'string', enum: ['outline', 'relation', 'label', 'connector', 'emphasis'] } },
              template: { type: 'string', enum: ['pythagorean_area_proof', 'triangle_angle_sum', 'unit_circle_projection', 'fraction_comparison', 'slope_comparison', 'causal_cycle', 'argument_structure', 'cause_effect', 'grammar_structure', 'relationship_map', 'worked_steps', 'comparison', 'part_whole', 'table', 'timeline', 'no_board'] },
              parameters: { type: 'object' },
            },
            required: ['id', 'label', 'revealOrder', 'template', 'parameters'],
          },
        },
      },
      required: ['schemaVersion', 'planId', 'intent', 'groups'],
    },
  },
  {
    type: 'function' as const,
    name: 'propose_teaching_move',
    description:
      'Propose the next pedagogical move in structured form. Deterministic lesson code validates the move and owns whether waiting is legal.',
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
          enum: ['voice', 'text', 'draw', 'choice', 'mixed'],
          description: 'How the learner should answer questionOrTask. Use "draw" (or "mixed" for draw-and-explain) for board tasks: the learner then composes freely and presses Done; you will receive exactly one complete submitted drawing.',
        },
        proposedAction: { type: 'string', enum: ['explain', 'visual', 'question', 'wait', 'feedback', 'practice', 'reteach', 'advance', 'complete'] },
      },
      required: ['rationale', 'microObjective', 'strategy', 'childFacingText', 'proposedAction'],
    },
  },
  {
    type: 'function' as const,
    name: 'board_ops',
    description:
      'Add one small increment to an existing shared-board visual. New diagrams should use semantic_visual_plan so code owns layout; use raw board_ops only when no semantic template fits. There is no clear operation: replacing a section is a semantic_visual_plan "replace" decision, and unrelated new ideas get a new section.',
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
