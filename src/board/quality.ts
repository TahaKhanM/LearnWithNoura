import { compileScene } from './compile';
import { avoidableConnectorCrossings, inspectScene } from './inspection';
import type { LayoutIssue } from '../../shared/layoutFeedback';
import type { SceneState } from './scene';

export interface BoardQualityReport {
  accepted: boolean;
  score: number;
  itemCount: number;
  textCharacters: number;
  connectorCrossings: number;
  reasons: string[];
  layoutIssues: LayoutIssue[];
}

const MAX_ITEMS = 30;
const MAX_TEXT_CHARACTERS = 720;
const MAX_CONNECTOR_CROSSINGS = 1;
const MAX_ASSETS = 8;
const MAX_IMAGES_PER_SECTION = 1;

/** A section-level legibility budget, applied after exact geometry inspection. */
export function evaluateBoardQuality(scene: SceneState): BoardQualityReport {
  const inspection = inspectScene(scene);
  const compiled = compileScene(scene.items);
  const tutorIds = new Set(scene.items.filter((item) => item.owner === 'tutor').map((item) => item.id));
  const tutorItemCount = tutorIds.size;
  const tutorIssues = inspection.issues.filter((issue) => tutorIds.has(issue.itemId));
  const textCharacters = compiled.filter((item) => tutorIds.has(item.id)).reduce((total, item) => total + item.nodes.reduce((sum, node) => sum + (node.type === 'text' ? node.text.length : node.type === 'katex' ? node.latex.length : 0), 0), 0);
  const crossingIssues = avoidableConnectorCrossings(scene);
  const connectorCrossings = crossingIssues.length;
  const reasons = tutorIssues.map((issue) => `${issue.kind}:${issue.itemId}${issue.withItemId ? `:${issue.withItemId}` : ''}`);
  const assetCount = scene.items.filter((item) => item.owner === 'tutor' && item.spec.kind === 'asset').length;
  const imagesBySection = new Map<string, number>();
  for (const item of scene.items) {
    if (item.owner !== 'tutor' || item.spec.kind !== 'image') continue;
    const section = item.semanticGroupId ?? '';
    imagesBySection.set(section, (imagesBySection.get(section) ?? 0) + 1);
  }
  const crowdedIllustration = [...imagesBySection.values()].some((count) => count > MAX_IMAGES_PER_SECTION);
  if (tutorItemCount > MAX_ITEMS) reasons.push(`density:${tutorItemCount}>${MAX_ITEMS}`);
  if (assetCount > MAX_ASSETS) reasons.push(`asset_density:${assetCount}>${MAX_ASSETS}`);
  if (crowdedIllustration) reasons.push(`illustration_density:>${MAX_IMAGES_PER_SECTION}`);
  if (textCharacters > MAX_TEXT_CHARACTERS) reasons.push(`text_density:${textCharacters}>${MAX_TEXT_CHARACTERS}`);
  if (connectorCrossings > MAX_CONNECTOR_CROSSINGS) reasons.push(`crossings:${connectorCrossings}>${MAX_CONNECTOR_CROSSINGS}`);
  const layoutIssues: LayoutIssue[] = [
    ...tutorIssues.map((issue) => ({
      code: issue.code,
      itemId: issue.itemId,
      ...(issue.withItemId ? { withItemId: issue.withItemId } : {}),
      ...(issue.itemBounds ? { itemBounds: issue.itemBounds } : {}),
      ...(issue.withItemBounds ? { withItemBounds: issue.withItemBounds } : {}),
    })),
    ...(connectorCrossings > MAX_CONNECTOR_CROSSINGS ? crossingIssues : []),
  ];
  const score = Math.max(0, 100 - tutorIssues.length * 22 - Math.max(0, tutorItemCount - 18) * 2 - Math.max(0, textCharacters - 420) * 0.04 - connectorCrossings * 12);
  return {
    accepted: reasons.length === 0,
    score: Math.round(score),
    itemCount: tutorItemCount,
    textCharacters,
    connectorCrossings,
    reasons,
    layoutIssues,
  };
}
