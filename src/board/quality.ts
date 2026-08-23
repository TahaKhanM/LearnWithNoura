import { compileScene } from './compile';
import { countAvoidableConnectorCrossings, inspectScene } from './inspection';
import type { SceneState } from './scene';

export interface BoardQualityReport {
  accepted: boolean;
  score: number;
  itemCount: number;
  textCharacters: number;
  connectorCrossings: number;
  reasons: string[];
}

const MAX_ITEMS = 30;
const MAX_TEXT_CHARACTERS = 720;
const MAX_CONNECTOR_CROSSINGS = 1;

/** A section-level legibility budget, applied after exact geometry inspection. */
export function evaluateBoardQuality(scene: SceneState): BoardQualityReport {
  const inspection = inspectScene(scene);
  const compiled = compileScene(scene.items);
  const tutorIds = new Set(scene.items.filter((item) => item.owner === 'tutor').map((item) => item.id));
  const tutorItemCount = tutorIds.size;
  const tutorIssues = inspection.issues.filter((issue) => tutorIds.has(issue.itemId));
  const textCharacters = compiled.filter((item) => tutorIds.has(item.id)).reduce((total, item) => total + item.nodes.reduce((sum, node) => sum + (node.type === 'text' ? node.text.length : node.type === 'katex' ? node.latex.length : 0), 0), 0);
  const connectorCrossings = countAvoidableConnectorCrossings(scene);
  const reasons = tutorIssues.map((issue) => `${issue.kind}:${issue.itemId}${issue.withItemId ? `:${issue.withItemId}` : ''}`);
  if (tutorItemCount > MAX_ITEMS) reasons.push(`density:${tutorItemCount}>${MAX_ITEMS}`);
  if (textCharacters > MAX_TEXT_CHARACTERS) reasons.push(`text_density:${textCharacters}>${MAX_TEXT_CHARACTERS}`);
  if (connectorCrossings > MAX_CONNECTOR_CROSSINGS) reasons.push(`crossings:${connectorCrossings}>${MAX_CONNECTOR_CROSSINGS}`);
  const score = Math.max(0, 100 - tutorIssues.length * 22 - Math.max(0, tutorItemCount - 18) * 2 - Math.max(0, textCharacters - 420) * 0.04 - connectorCrossings * 12);
  return {
    accepted: reasons.length === 0,
    score: Math.round(score),
    itemCount: tutorItemCount,
    textCharacters,
    connectorCrossings,
    reasons,
  };
}
