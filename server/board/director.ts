import type { BoardOp } from '../../shared/boardOps.js';
import type { SceneValidator } from '../lesson/compiler.js';
import type { SceneRenderer } from '../lesson/headlessSceneValidator.js';
import { directorProposePrompt, DIRECTOR_VISION_PROMPT } from './directorPrompts.js';
import { closedVisionAuditIssues } from './visionAudit.js';
import {
  type IllustrationBrief,
  type IllustrationHooks,
  type IllustrationPrepareOk,
  type IllustrationPrepareResult,
} from './illustration.js';
import type { IllustrationStore } from './illustrationTypes.js';
import {
  applyDirectorBoardPolicy,
  buildDirectedScene,
  DIRECTOR_DENSITY_BUDGETS,
  DirectorProposalSchema,
  DirectorVisionVerdictSchema,
  type DirectedScene,
  type DirectorDensity,
} from './directorSchema.js';

/**
 * The Board Director: the slow tier of the two-tier drawing brain. The voice
 * model supplies intent; a multimodal reasoning model designs the scene; the
 * REAL client pipeline validates it headlessly; a vision pass inspects the
 * rendered candidate against the intent. At most two correction rounds, then
 * the request fails closed — an unvalidated scene never reaches the board.
 */

export interface DirectorMessagePartText { type: 'text'; text: string }
export interface DirectorMessagePartImage { type: 'image'; dataUrl: string }
export type DirectorMessagePart = DirectorMessagePartText | DirectorMessagePartImage;
export interface DirectorMessage { role: 'system' | 'user'; content: DirectorMessagePart[] }

export interface DirectorChatClient {
  /** One multimodal chat round trip returning the reply text, or null. */
  complete(request: { messages: DirectorMessage[] }): Promise<string | null>;
}

export interface DirectorSceneRequest {
  /** Why the tutor wants this visual, in the voice model's words. */
  purpose: string;
  /** The relationship or idea the scene must show. */
  idea: string;
  constraints: string | null;
  density: DirectorDensity;
  /** Visible objects the request is about (may be empty). */
  targetObjectIds: string[];
  /** Server-assigned section: the Director never chooses where work lands. */
  sectionId: string;
  sectionLabel: string;
  boardSummary: string;
  visibleObjectIds: string[];
  /** Released ops of the visible board, for the Director's screenshot. */
  currentBoardOps: BoardOp[];
  stageBrief: string;
  learnerContext: string;
  assetOwner?: { parentId?: string; sessionId?: string };
  /** Per-session render authority. Live realtime requests bind these to the
   * connected learner browser, so production does not depend on launching
   * Chromium inside a serverless function. */
  validateScene?: SceneValidator;
  renderScene?: SceneRenderer;
}

export type DirectorResult =
  | { ok: true; scene: DirectedScene; illustrationBrief?: IllustrationBrief }
  | {
    ok: false;
    reasons: string[];
    /** A pre-commit composition/transport failure may make one escalated
     * retry; semantic audit rejections and post-commit failures may not. */
    retryable?: boolean;
  };

export interface IllustrationPrepareOptions {
  generationBudgetRemaining?: number;
}

export interface IllustrationDirectorPort {
  enabled: boolean;
  prepare(
    brief: IllustrationBrief,
    hooks?: IllustrationHooks,
    options?: IllustrationPrepareOptions,
  ): Promise<IllustrationPrepareResult>;
  store?: IllustrationStore;
  persist?(result: IllustrationPrepareOk, owner?: { parentId?: string; sessionId?: string }): Promise<void>;
}

export interface BoardDirectorDeps {
  client: DirectorChatClient;
  /** Validates final BoardOps through the real client render pipeline. */
  validateScene: SceneValidator;
  /** Rasters ops to the canonical board JPEG through the same pipeline. */
  renderScene: SceneRenderer;
  /** Bounded self-correction rounds after the first rejection. Default 2. */
  maxCorrectionRounds?: number;
  /** When omitted or disabled, the Director never requests generated images. */
  illustrations?: IllustrationDirectorPort | null;
}

export type BoardDirector = (request: DirectorSceneRequest) => Promise<DirectorResult>;

export async function directVisual(deps: BoardDirectorDeps, request: DirectorSceneRequest): Promise<DirectorResult> {
  const attempts = 1 + Math.max(0, deps.maxCorrectionRounds ?? 2);
  const validateScene = request.validateScene ?? deps.validateScene;
  const renderScene = request.renderScene ?? deps.renderScene;
  const boardImage = request.currentBoardOps.length > 0
    ? await renderScene(request.currentBoardOps)
    : null;
  let feedback: string[] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reply = await deps.client.complete({
      messages: proposalMessages(request, boardImage, feedback, Boolean(deps.illustrations?.enabled)),
    });
    if (!reply) {
      feedback = ['The model returned an empty reply.'];
      continue;
    }
    let scene: DirectedScene;
    let illustrationBrief: IllustrationBrief | undefined;
    try {
      const proposal = DirectorProposalSchema.parse(JSON.parse(reply));
      // Permanence violations are stripped by the policy; a design that
      // relied on destruction fails the storyboard coverage checks in
      // buildDirectedScene and comes back here as feedback.
      const overlayOps = Array.isArray(proposal.ops)
        ? proposal.ops.filter((op) => !isImageOp(op))
        : proposal.ops;
      if (proposal.representation === 'illustration') {
        if (!deps.illustrations?.enabled) {
          feedback = ['Illustrations are not available; design a vector or asset diagram instead.'];
          continue;
        }
        if (!proposal.illustration) {
          feedback = ['An illustration request needs purpose, subject, and required or forbidden elements.'];
          continue;
        }
        illustrationBrief = proposal.illustration;
      }
      const emptyOverlays = Array.isArray(overlayOps) && overlayOps.length === 0;
      if (emptyOverlays) {
        feedback = illustrationBrief
          ? ['Illustration scenes need overlay labels, equations, or arrows as BoardOps; the generated picture cannot carry those.']
          : ['The scene must add objects; erase, clear, update, and highlight are not available to the Director.'];
        continue;
      }
      const policy = applyDirectorBoardPolicy(overlayOps, {
        density: request.density,
        visibleObjectIds: request.visibleObjectIds,
      });
      if (policy.ok === false) {
        feedback = policy.reasons;
        continue;
      }
      scene = buildDirectedScene({
        groupId: request.sectionId,
        groupLabel: proposal.groupLabel,
        ops: policy.ops,
        storyboard: proposal.storyboard,
      });
    } catch (error) {
      feedback = [describeError(error)];
      continue;
    }
    const verdict = await validateScene(scene.ops);
    if (verdict.ok === false) {
      feedback = verdict.issues.map((issue) => `Deterministic layout validation rejected the scene: ${issue}`);
      continue;
    }
    const candidateImage = await renderScene(scene.ops, scene.groupId);
    if (!candidateImage) {
      feedback = ['The candidate scene could not be rendered for inspection.'];
      continue;
    }
    const visionReply = await deps.client.complete({
      messages: visionMessages(request, scene, candidateImage),
    });
    let approved = false;
    try {
      const vision = DirectorVisionVerdictSchema.parse(JSON.parse(visionReply ?? ''));
      approved = vision.approved;
      if (!approved) feedback = closedVisionAuditIssues('rejected').map((issue) => `vision_audit:${issue}`);
    } catch {
      feedback = closedVisionAuditIssues('invalid').map((issue) => `vision_audit:${issue}`);
    }
    if (approved) {
      return { ok: true, scene, ...(illustrationBrief ? { illustrationBrief } : {}) };
    }
  }

  return {
    ok: false,
    reasons: feedback.length > 0 ? feedback : ['The Director produced no acceptable scene.'],
  };
}

function proposalMessages(
  request: DirectorSceneRequest,
  boardImage: string | null,
  feedback: string[],
  illustrationsEnabled: boolean,
): DirectorMessage[] {
  const lines = [
    request.learnerContext,
    `Current lesson stage: ${request.stageBrief}`,
    `Purpose of the visual: ${request.purpose}`,
    `It must show: ${request.idea}`,
    ...(request.constraints ? [`Constraints from the tutor: ${request.constraints}`] : []),
    ...(request.targetObjectIds.length > 0 ? [`It relates to these visible objects: ${request.targetObjectIds.join(', ')}`] : []),
    `The scene builds board section "${request.sectionId}" (${request.sectionLabel}).`,
    `Object budget: at most ${DIRECTOR_DENSITY_BUDGETS[request.density]} objects (${request.density}).`,
    `Visible board now: ${request.boardSummary}`,
    ...(request.visibleObjectIds.length > 0 ? [`Ids already taken (never reuse): ${request.visibleObjectIds.join(', ')}`] : []),
  ];
  if (feedback.length > 0) {
    lines.push(
      'Your previous design was rejected for these reasons:',
      ...feedback.map((reason) => `- ${reason}`),
      'Fix every problem and reply again with JSON only.',
    );
  }
  const content: DirectorMessagePart[] = [{ type: 'text', text: lines.join('\n') }];
  if (boardImage) {
    content.push({ type: 'text', text: 'Snapshot of the board the learner sees right now:' });
    content.push({ type: 'image', dataUrl: boardImage });
  }
  return [
    { role: 'system', content: [{ type: 'text', text: directorProposePrompt(illustrationsEnabled) }] },
    { role: 'user', content },
  ];
}

function visionMessages(
  request: DirectorSceneRequest,
  scene: DirectedScene,
  candidateImage: string,
): DirectorMessage[] {
  const text = [
    `The visual was requested to show: ${request.idea} (purpose: ${request.purpose}).`,
    `Your storyboard claims these reveal steps: ${scene.storyboard.map((step) => `${step.reveal}: ${step.narration}`).join(' | ')}`,
    'Inspect the rendered candidate below.',
  ].join('\n');
  return [
    { role: 'system', content: [{ type: 'text', text: DIRECTOR_VISION_PROMPT }] },
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image', dataUrl: candidateImage },
      ],
    },
  ];
}

function isImageOp(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const op = raw as { spec?: { kind?: unknown }; kind?: unknown };
  return op.spec?.kind === 'image' || op.kind === 'image';
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: Array<{ path: Array<string | number>; message: string }> }).issues;
    return issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ').slice(0, 600);
  }
  return String(error instanceof Error ? error.message : error).slice(0, 600);
}
