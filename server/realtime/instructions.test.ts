import { describe, expect, it } from 'vitest';
import type { LessonBlueprint } from '../../shared/pedagogy.js';
import { lessonExecutionContext } from './instructions.js';

const conversation: LessonBlueprint = {
  blueprintId: 'blueprint-talk',
  goal: 'Explore triangles together',
  mode: 'conversation_led',
  successCriteria: ['Learner names one triangle fact'],
  anchor: null,
  stages: [
    {
      id: 'orient',
      kind: 'orient',
      objective: 'Find out what they already know',
      boardPurpose: 'none',
      allowedBoardMutation: 'none',
      learnerOpportunity: 'Share a first idea',
      evidenceExpected: 'recall',
    },
    {
      id: 'model',
      kind: 'model',
      objective: 'Build the idea',
      boardPurpose: 'none',
      allowedBoardMutation: 'none',
      learnerOpportunity: 'Predict the next step',
      evidenceExpected: 'reasoning',
    },
    {
      id: 'apply',
      kind: 'guided_check',
      objective: 'Try one example',
      boardPurpose: 'none',
      allowedBoardMutation: 'none',
      learnerOpportunity: 'Work one example',
      evidenceExpected: 'application',
    },
  ],
  currentStageIndex: 0,
  detourStack: [],
};

describe('lessonExecutionContext', () => {
  it('routes new conversation-led representations through the Board Director', () => {
    const brief = lessonExecutionContext(conversation, conversation.stages[0], null);
    expect(brief).toContain('allowed board mutation: none');
    expect(brief).toMatch(/does not forbid a useful visual/i);
    expect(brief).toContain('request_visual');
    expect(brief).toContain('Board Director');
    expect(brief).toContain('board_ops');
    expect(brief).toMatch(/never tell the learner you cannot draw/i);
    expect(brief).toMatch(/already visible/i);
  });
});
