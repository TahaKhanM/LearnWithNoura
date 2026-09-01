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

export interface VisionAuditEvent {
  startedAtMs: number;
  model: OpenAiTelemetryModel;
  reasoningEffort: DirectorReasoningEffort;
  outcome: VisionAuditOutcome;
  issues: string[];
}
