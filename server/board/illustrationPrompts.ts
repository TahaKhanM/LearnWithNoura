import type { IllustrationBrief } from './illustrationTypes.js';

export function buildIllustrationPrompt(brief: IllustrationBrief): string {
  const style = brief.style?.trim() || 'clear educational illustration';
  const required = brief.requiredElements.length > 0
    ? `Must include: ${brief.requiredElements.join(', ')}.`
    : 'Include only the named subject and the minimum supporting setting.';
  const forbidden = brief.forbiddenElements.length > 0
    ? `Must not include: ${brief.forbiddenElements.join(', ')}.`
    : '';
  return [
    `Child-safe educational illustration for a voice tutor named Noura.`,
    `Purpose: ${brief.purpose.trim()}`,
    `Subject: ${brief.subject.trim()}`,
    `Style: ${style}. Friendly, simple, high-contrast shapes a child can read at a glance.`,
    required,
    forbidden,
    'Hard constraints:',
    '- No photorealistic children or identifiable real children.',
    '- No violence, weapons, gore, sexual content, or frightening imagery.',
    '- Do not draw any letters, words, numbers, digits, equations, scales, rulers, tick marks, or measurement labels. Those are added later as exact overlays.',
    '- Leave clear empty bands at the top and bottom of the picture for labels.',
    '- Landscape composition suitable for a 1000×600 classroom board.',
  ].filter(Boolean).join('\n');
}

export const ILLUSTRATION_VISION_PROMPT = `You inspect a generated educational illustration for a child's whiteboard. Judge only what is in the picture. Reply with JSON only:
{"approved": boolean, "issues": [string, ...], "hasEmbeddedText": boolean, "unsafe": boolean, "missingRequired": [string, ...]}

Reject when any of these hold:
- The picture contains letters, words, numbers, digits, equations, or measurement marks (those must stay empty — overlays handle them).
- The picture is unsafe for a child (violence, weapons, photoreal children, sexual or frightening content).
- A required element named in the request is missing or unrecognizable.
- The picture does not show the requested subject clearly.
List concrete issues when you reject. Never approve out of politeness.`;
