import type {
  DirectorReasoningEffort,
  OpenAiTelemetryModel,
  VisionAuditOutcome,
} from '../../shared/sessionTelemetry.js';

export const VISION_AUDIT_BUDGET_MS = 3_000;

export interface VisionAuditInput {
  purpose: string;
  idea: string;
  constraints: string | null;
  candidateImage: string;
}

export interface VisionAuditPort {
  model: OpenAiTelemetryModel;
  reasoningEffort: DirectorReasoningEffort;
  inspect(input: VisionAuditInput, options: { signal: AbortSignal }): Promise<{
    outcome: 'approved' | 'rejected' | 'invalid';
    issues: string[];
  }>;
}

export type VisionAuditIssueCode = 'semantic_mismatch' | 'invalid_verdict' | 'audit_unavailable';

export function closedVisionAuditIssues(
  outcome: VisionAuditOutcome,
): VisionAuditIssueCode[] {
  if (outcome === 'rejected') return ['semantic_mismatch'];
  if (outcome === 'invalid') return ['invalid_verdict'];
  if (outcome === 'error') return ['audit_unavailable'];
  return [];
}

export interface VisionAuditEvent {
  startedAtMs: number;
  model: OpenAiTelemetryModel;
  reasoningEffort: DirectorReasoningEffort;
  outcome: VisionAuditOutcome;
  issues: string[];
}
