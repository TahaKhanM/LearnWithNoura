import {
  CompiledLessonSchema,
  COMPILED_LESSON_SCHEMA_VERSION,
  type CompiledLesson,
} from '../../shared/compiledLesson.js';

/** Marks a conversation-led plan that is safe to teach from immediately
 * while the live compiler may still replace it with a stronger artifact. */
export const PROVISIONAL_COMPILER_MODEL = 'provisional-conversation';

/** Instant conversation-led lesson so Preparing does not block on the
 * compiler. Production still runs the live compiler in the background. */
export function compileProvisionalConversationLesson(input: {
  lessonKey: string;
  goal: string;
  objective?: string;
}): CompiledLesson {
  const objective = (input.objective ?? input.goal).trim().slice(0, 200) || 'Explore the chosen topic together';
  return CompiledLessonSchema.parse({
    compiledLessonId: `compiled-${input.lessonKey}`,
    schemaVersion: COMPILED_LESSON_SCHEMA_VERSION,
    goal: input.goal.trim().slice(0, 300) || objective,
    objective,
    blueprint: {
      blueprintId: `blueprint-${input.lessonKey}`,
      goal: objective,
      mode: 'conversation_led',
      successCriteria: [`Learner explains one key idea about: ${objective}`.slice(0, 240)],
      anchor: null,
      stages: [
        {
          id: 'orient', kind: 'orient', objective: `Find out what the learner already knows about ${objective}`.slice(0, 240),
          boardPurpose: 'none', allowedBoardMutation: 'none',
          learnerOpportunity: 'Share what they already know or wonder', evidenceExpected: 'recall',
          checks: [{ id: 'orient-known', questionOrTask: 'What do you already know about this, even a small piece?', responseMode: 'voice' }],
        },
        {
          id: 'model', kind: 'model', objective: 'Build the core idea together in small steps',
          boardPurpose: 'none', allowedBoardMutation: 'none',
          learnerOpportunity: 'Answer small prediction questions along the way', evidenceExpected: 'reasoning',
          checks: [{ id: 'model-predict', questionOrTask: 'What do you think happens next, and why?', responseMode: 'voice' }],
        },
        {
          id: 'apply', kind: 'guided_check', objective: 'Use the idea on one concrete example',
          boardPurpose: 'none', allowedBoardMutation: 'none',
          learnerOpportunity: 'Work one example aloud with light support', evidenceExpected: 'application',
          checks: [{ id: 'apply-example', questionOrTask: 'Try this one yourself and talk me through your thinking.', responseMode: 'voice' }],
        },
      ],
      currentStageIndex: 0,
      detourStack: [],
    },
    anchorScene: null,
    compiledAt: 0,
    compilerModel: PROVISIONAL_COMPILER_MODEL,
  });
}
