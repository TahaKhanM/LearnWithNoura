/**
 * Tool surface exposed to the realtime tutor. Deliberately small: draw,
 * record what the learner showed, and keep the lesson plan current.
 */

export const REALTIME_TOOLS = [
  {
    type: 'function' as const,
    name: 'semantic_visual_plan',
    description:
      'Describe one semantic visual group. Code selects domain layout, exact geometry, inspection, reveal order, and acceptance; use no_board when a diagram would not help.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schemaVersion: { type: 'string', enum: ['1.0.0'] },
        planId: { type: 'string', minLength: 1, maxLength: 120 },
        intent: {
          type: 'object', additionalProperties: false,
          properties: {
            objective: { type: 'string', minLength: 1, maxLength: 300 },
            domain: { type: 'string', enum: ['geometry', 'quantitative', 'process', 'argument', 'history', 'grammar', 'table', 'timeline', 'none'] },
            noBoardReason: { type: 'string', maxLength: 300 },
          },
          required: ['objective', 'domain'],
        },
        groups: {
          type: 'array', minItems: 0, maxItems: 1,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 80 },
              label: { type: 'string', minLength: 1, maxLength: 160 },
              revealOrder: { type: 'array', minItems: 1, items: { type: 'string', enum: ['outline', 'relation', 'label', 'connector', 'emphasis'] } },
              template: { type: 'string', enum: ['pythagorean_area_proof', 'unit_circle_projection', 'fraction_comparison', 'slope_comparison', 'causal_cycle', 'argument_structure', 'cause_effect', 'grammar_structure', 'table', 'timeline', 'no_board'] },
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
        questionOrTask: { type: 'string', minLength: 1, maxLength: 500 },
        taskId: { type: 'string', minLength: 1, maxLength: 160 },
        proposedAction: { type: 'string', enum: ['explain', 'visual', 'question', 'wait', 'feedback', 'practice', 'reteach', 'advance', 'complete'] },
      },
      required: ['rationale', 'microObjective', 'strategy', 'childFacingText', 'proposedAction'],
    },
  },
  {
    type: 'function' as const,
    name: 'board_ops',
    description:
      'Draw on the shared whiteboard. Call this right after saying the sentence the drawing belongs to. Each call should draw the marks for ONE idea.',
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
