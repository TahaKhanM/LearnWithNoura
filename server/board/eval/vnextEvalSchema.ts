import { z } from 'zod';
import type { AddOp } from '../../../shared/boardOps.js';
import { VisualTemplateSchema } from '../../../shared/semanticScene.js';
import {
  applyDirectorBoardPolicy,
  DirectorProposalSchema,
  type DirectorDensity,
  type DirectorProposal,
} from '../directorSchema.js';
import {
  DIRECTOR_EVAL_ADD_OP_JSON_SCHEMA,
  DIRECTOR_EVAL_SPEC_KINDS,
  StrictEvalAddOpSchema,
  parseStrictEvalAddOp,
  type JsonSchema,
} from './vnextBoardOpSchema.js';

const RevealSchema = z.enum(['outline', 'relation', 'label', 'connector', 'emphasis']);
const EvalTemplateSchema = VisualTemplateSchema.exclude(['no_board']);

const IllustrationSchema = z.object({
  purpose: z.string().min(1).max(300),
  subject: z.string().min(1).max(200),
  style: z.string().min(1).max(120).nullable(),
  requiredElements: z.array(z.string().min(1).max(80)).max(8),
  forbiddenElements: z.array(z.string().min(1).max(80)).max(8),
  alt: z.string().min(1).max(200).nullable(),
}).strict();

const evalHeaderShape = {
  template: EvalTemplateSchema.nullable(),
  groupLabel: z.string().min(1).max(160),
  representation: z.enum(['diagram', 'illustration']),
  illustration: IllustrationSchema.nullable(),
};

function requireMatchingIllustration(
  header: { representation: 'diagram' | 'illustration'; illustration: unknown },
  context: z.RefinementCtx,
): void {
  if ((header.representation === 'illustration') !== (header.illustration !== null)) {
    context.addIssue({ code: 'custom', path: ['illustration'], message: 'Illustration details must be present exactly when representation is illustration.' });
  }
}

export const VNextEvalHeaderSchema = z.object(evalHeaderShape).strict()
  .superRefine(requireMatchingIllustration);

export const VNextEvalStepSchema = z.object({
  id: z.string().min(1).max(120),
  reveal: RevealSchema,
  narration: z.string().min(1).max(400),
  ops: z.array(StrictEvalAddOpSchema).min(1).max(24),
}).strict();
export type VNextEvalStep = z.infer<typeof VNextEvalStepSchema>;

export const VNextEvalProposalSchema = z.object({
  ...evalHeaderShape,
  steps: z.array(VNextEvalStepSchema).min(1).max(8),
}).strict().superRefine((proposal, context) => {
  requireMatchingIllustration(proposal, context);
  const stepIds = new Set<string>();
  const objectIds = new Set<string>();
  let opCount = 0;
  for (const [stepIndex, step] of proposal.steps.entries()) {
    if (stepIds.has(step.id)) context.addIssue({ code: 'custom', path: ['steps', stepIndex, 'id'], message: 'Step ids must be unique.' });
    stepIds.add(step.id);
    for (const [opIndex, rawOp] of step.ops.entries()) {
      const op = parseStrictEvalAddOp(rawOp);
      opCount += 1;
      if (objectIds.has(op.id)) context.addIssue({ code: 'custom', path: ['steps', stepIndex, 'ops', opIndex, 'id'], message: 'Object ids must be unique across steps.' });
      objectIds.add(op.id);
    }
  }
  if (opCount > 40) context.addIssue({ code: 'custom', path: ['steps'], message: 'A proposal may contain at most 40 operations.' });
});
export type VNextEvalProposal = z.infer<typeof VNextEvalProposalSchema>;

const strictObject = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
});
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
const boundedString = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength });
const illustrationJsonSchema = strictObject({
  purpose: boundedString(300), subject: boundedString(200), style: nullable(boundedString(120)),
  requiredElements: { type: 'array', items: boundedString(80), maxItems: 8 },
  forbiddenElements: { type: 'array', items: boundedString(80), maxItems: 8 },
  alt: nullable(boundedString(200)),
});
const stepJsonSchema = strictObject({
  id: boundedString(120),
  reveal: { type: 'string', enum: RevealSchema.options },
  narration: boundedString(400),
  ops: { type: 'array', minItems: 1, maxItems: 24, items: DIRECTOR_EVAL_ADD_OP_JSON_SCHEMA },
});

/** Property order is intentional and tested: `template` completes before any
 * generative step, allowing the future deterministic short-circuit lane. */
export const DIRECTOR_VNEXT_EVAL_JSON_SCHEMA: JsonSchema = strictObject({
  template: nullable({ type: 'string', enum: EvalTemplateSchema.options }),
  groupLabel: boundedString(160),
  representation: { type: 'string', enum: ['diagram', 'illustration'] },
  illustration: nullable(illustrationJsonSchema),
  steps: { type: 'array', minItems: 1, maxItems: 8, items: stepJsonSchema },
});

export const DIRECTOR_VNEXT_EVAL_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'noura_director_vnext_eval',
    strict: true,
    schema: DIRECTOR_VNEXT_EVAL_JSON_SCHEMA,
  },
};

export const DIRECTOR_VNEXT_EVAL_STATIC_PROMPT = [
  'You are the Board Director for Noura, a voice tutor teaching one child at a shared whiteboard.',
  'Return one exact step-structured scene matching the supplied strict JSON schema.',
  '`template` is always the first field. Use null unless an exact named template fully represents the request without guessing parameters.',
  `Allowed BoardOp spec kinds: ${DIRECTOR_EVAL_SPEC_KINDS.join(', ')}.`,
  'Every operation is additive. Use fresh short ids. Stay within a 1000 by 600 board.',
  'Each step reveals its own operations exactly once. Narration is one or two short child-facing sentences and never mentions ids, tools, or drawing.',
  'Be compact: prefer two to four steps, at most 15 operations total, one narration sentence of at most 18 words, and no decorative duplicates.',
  'For quantitative geometry or axes, use a two-column layout: keep the full figure within x=80..540 and y=80..520. Put equations or explanatory text at x=620 in the right column, with y positions at least 100 apart.',
  'Right-column equations must use small or normal size and short individual equalities; split a long derivation across steps. Never use big equations or text in the right column.',
  'Keep every object fully inside x=60..940 and y=60..540. Never place text, equations, boxes, or labels on top of a line, axis, polygon, circle, connector, or another annotation.',
  'Before replying, check the complete scene for bounds and collisions; simplify instead of overlapping objects.',
  'Use illustration only for a background-enhancement brief; all exact labels, values, equations, scales, and arrows remain BoardOp overlays.',
].join('\n');

export function validatePolicyReadyEvalStep(input: {
  step: unknown;
  density: DirectorDensity;
  priorOps?: readonly AddOp[];
  visibleObjectIds?: readonly string[];
}): { step: VNextEvalStep; ops: AddOp[] } {
  const step = VNextEvalStepSchema.parse(input.step);
  const stepOps = step.ops.map(parseStrictEvalAddOp);
  const priorOps = [...(input.priorOps ?? [])];
  const duplicateIds = new Set(priorOps.map((op) => op.id));
  for (const op of stepOps) {
    if (duplicateIds.has(op.id)) throw new Error('Step object ids collide with earlier steps.');
    duplicateIds.add(op.id);
  }
  const policy = applyDirectorBoardPolicy([...priorOps, ...stepOps], {
    density: input.density,
    visibleObjectIds: input.visibleObjectIds ?? [],
  });
  if (!policy.ok) throw new Error(policy.reasons.join('; '));
  return { step, ops: policy.ops.slice(priorOps.length) };
}

export function parseVNextEvalDirectorProposal(text: string, density: DirectorDensity): DirectorProposal {
  const proposal = VNextEvalProposalSchema.parse(JSON.parse(text));
  const ops: AddOp[] = [];
  const storyboard: DirectorProposal['storyboard'] = [];
  for (const rawStep of proposal.steps) {
    const validated = validatePolicyReadyEvalStep({ step: rawStep, density, priorOps: ops });
    ops.push(...validated.ops);
    storyboard.push({
      id: validated.step.id,
      reveal: validated.step.reveal,
      narration: validated.step.narration,
      objectIds: validated.ops.map((op) => op.id),
    });
  }
  return DirectorProposalSchema.parse({
    groupLabel: proposal.groupLabel,
    representation: proposal.representation,
    ...(proposal.illustration ? {
      illustration: {
        ...proposal.illustration,
        ...(proposal.illustration.style === null ? { style: undefined } : {}),
        ...(proposal.illustration.alt === null ? { alt: undefined } : {}),
      },
    } : {}),
    ops,
    storyboard,
  });
}
