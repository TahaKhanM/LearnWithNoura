import { estimateUsageCostUsd } from './eval/budget.js';
import type { DirectorStreamUsage } from './directorStreamingService.js';

export type M2SmokeRole = 'realtime' | 'composition' | 'vision_audit' | 'recovery' | 'layout_correction';
export type M2SmokeModel = 'gpt-realtime-2.1' | 'gpt-5.6-terra' | 'gpt-5.6-luna';
export interface M2SmokeAccounting {
  begin(role: M2SmokeRole, model: string, reasoningEffort: 'low' | 'medium' | 'high'): string;
  recordUsage(callId: string, usage: DirectorStreamUsage): void;
  markCompleted(callId: string): void;
  markFailed(callId: string): void;
}

const INITIAL_RULES: Record<M2SmokeRole, {
  limit: number;
  reserveUsd: number;
  model: M2SmokeModel;
  effort: 'low' | 'medium';
}> = {
  realtime: { limit: 1, reserveUsd: 0.5, model: 'gpt-realtime-2.1', effort: 'low' },
  composition: { limit: 2, reserveUsd: 0.12, model: 'gpt-5.6-terra', effort: 'low' },
  vision_audit: { limit: 2, reserveUsd: 0.06, model: 'gpt-5.6-luna', effort: 'low' },
  recovery: { limit: 2, reserveUsd: 0.12, model: 'gpt-5.6-terra', effort: 'medium' },
  layout_correction: { limit: 0, reserveUsd: 0.12, model: 'gpt-5.6-terra', effort: 'low' },
};
const RERUN_RULES: Record<M2SmokeRole, typeof INITIAL_RULES[M2SmokeRole]> = {
  ...INITIAL_RULES,
  composition: { ...INITIAL_RULES.composition, limit: 1 },
  vision_audit: { ...INITIAL_RULES.vision_audit, limit: 1 },
  recovery: { ...INITIAL_RULES.recovery, limit: 1 },
};

interface SmokeEntry {
  sequence: number;
  callId: string;
  role: M2SmokeRole;
  model: M2SmokeModel;
  reasoningEffort: 'low' | 'medium' | 'high';
  reserveUsd: number;
  status: 'started' | 'completed' | 'failed';
  usage: DirectorStreamUsage | null;
  observedTextCostUsd: number;
}

export class M2SmokeBudget implements M2SmokeAccounting {
  private entries: SmokeEntry[] = [];
  private counts: Record<M2SmokeRole, number> = {
    realtime: 0,
    composition: 0,
    vision_audit: 0,
    recovery: 0,
    layout_correction: 0,
  };

  private readonly rules: typeof INITIAL_RULES;

  constructor(
    readonly hardCapUsd: number,
    readonly mode: 'initial' | 'corrected_rerun' = 'initial',
  ) {
    this.rules = mode === 'corrected_rerun' ? RERUN_RULES : INITIAL_RULES;
    const expectedCap = mode === 'corrected_rerun' ? 0.85 : 1.25;
    if (hardCapUsd !== expectedCap) throw new Error(`The authorized M2 ${mode} hard cap must be exactly $${expectedCap}.`);
    if (this.maximumPlannedReserveUsd() > hardCapUsd) throw new Error('The M2 smoke plan does not fit its authorized cap.');
  }

  maximumPlannedReserveUsd(): number {
    return money(Object.values(this.rules).reduce((total, rule) => total + rule.limit * rule.reserveUsd, 0));
  }

  begin(
    role: M2SmokeRole,
    model: string,
    reasoningEffort: 'low' | 'medium' | 'high',
  ): string {
    const rule = this.rules[role];
    if (this.counts[role] >= rule.limit) throw new Error(`M2 smoke ${role} provider call limit reached.`);
    if (model !== rule.model || reasoningEffort !== rule.effort) {
      throw new Error(`M2 smoke ${role} call does not match the authorized adopted configuration.`);
    }
    if (this.accountedUpperBoundUsd() + rule.reserveUsd > this.hardCapUsd) {
      throw new Error('M2 smoke hard spend cap would be exceeded.');
    }
    this.counts[role] += 1;
    const callId = `m2-smoke:${role}:${this.counts[role]}`;
    this.entries.push({
      sequence: this.entries.length + 1,
      callId,
      role,
      model: rule.model,
      reasoningEffort,
      reserveUsd: rule.reserveUsd,
      status: 'started',
      usage: null,
      observedTextCostUsd: 0,
    });
    return callId;
  }

  recordUsage(callId: string, usage: DirectorStreamUsage): void {
    const entry = this.require(callId);
    if (entry.model !== 'gpt-5.6-terra' && entry.model !== 'gpt-5.6-luna') return;
    entry.usage = { ...usage };
    entry.observedTextCostUsd = estimateUsageCostUsd(entry.model, usage);
    entry.status = 'completed';
    if (entry.observedTextCostUsd > entry.reserveUsd) {
      throw new Error(`M2 smoke ${callId} exceeded its conservative call reservation.`);
    }
  }

  markCompleted(callId: string): void {
    this.require(callId).status = 'completed';
  }

  markFailed(callId: string): void {
    this.require(callId).status = 'failed';
  }

  snapshot() {
    return {
      schemaVersion: '1.0.0' as const,
      mode: this.mode,
      hardCapUsd: this.hardCapUsd,
      maximumPlannedReserveUsd: this.maximumPlannedReserveUsd(),
      providerCalls: this.entries.length,
      accountedUpperBoundUsd: this.accountedUpperBoundUsd(),
      observedTextCostUsd: money(this.entries.reduce((total, entry) => total + entry.observedTextCostUsd, 0)),
      counts: { ...this.counts },
      entries: this.entries.map((entry) => ({ ...entry, usage: entry.usage ? { ...entry.usage } : null })),
    };
  }

  private accountedUpperBoundUsd(): number {
    return money(this.entries.reduce((total, entry) => total + entry.reserveUsd, 0));
  }

  private require(callId: string): SmokeEntry {
    const entry = this.entries.find((candidate) => candidate.callId === callId);
    if (!entry) throw new Error(`Unknown M2 smoke provider call ${callId}.`);
    return entry;
  }
}

function money(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}
