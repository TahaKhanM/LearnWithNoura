import {
  CompiledLessonSchema,
  COMPILED_LESSON_SCHEMA_VERSION,
  type CompiledLesson,
} from '../../shared/compiledLesson.js';

/** Minimal conversation-led compiled lesson for storage contract tests. */
export function conversationCompiledLesson(goal = 'Talk through the water cycle'): CompiledLesson {
  return CompiledLessonSchema.parse({
    compiledLessonId: 'compiled-fixture-conversation',
    schemaVersion: COMPILED_LESSON_SCHEMA_VERSION,
    goal,
    objective: 'Explain how water moves between sky, land, and sea',
    blueprint: {
      blueprintId: 'blueprint-fixture-conversation',
      goal: 'Explain how water moves between sky, land, and sea',
      mode: 'conversation_led',
      successCriteria: ['Learner narrates one full cycle in their own words'],
      anchor: null,
      stages: [
        { id: 'orient', kind: 'orient', objective: 'Recall where rain comes from', boardPurpose: 'none', allowedBoardMutation: 'none', learnerOpportunity: 'Describe the last rainfall they saw', evidenceExpected: 'recall' },
        { id: 'model', kind: 'model', objective: 'Connect evaporation to clouds', boardPurpose: 'none', allowedBoardMutation: 'none', learnerOpportunity: 'Predict what happens to a puddle in the sun', evidenceExpected: 'reasoning' },
        { id: 'check', kind: 'guided_check', objective: 'Narrate one full cycle', boardPurpose: 'none', allowedBoardMutation: 'none', learnerOpportunity: 'Tell the journey of one raindrop', evidenceExpected: 'explanation' },
      ],
      currentStageIndex: 0,
      detourStack: [],
    },
    anchorScene: null,
    compiledAt: 1,
    compilerModel: 'storage-fixture',
  });
}
