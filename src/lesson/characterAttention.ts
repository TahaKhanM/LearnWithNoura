import type { GenerationIdentity } from '../../shared/runtimeProtocol';

export type AttentionTargetType =
  | 'interruption'
  | 'learner_activity'
  | 'learner_drawing'
  | 'learner_pointer'
  | 'learner_touch'
  | 'focused_object'
  | 'tutor_pen'
  | 'semantic_object'
  | 'caption_question'
  | 'neutral_learner';

export type SmoothingProfile = 'immediate' | 'responsive' | 'gentle';

export interface CharacterAttentionTarget extends GenerationIdentity {
  targetType: AttentionTargetType;
  semanticObjectId?: string;
  boardCoordinates?: [number, number];
  priority: number;
  startTime: number;
  expiryTime: number;
  smoothingProfile: SmoothingProfile;
  permittedInReducedMotion: boolean;
}

export interface CharacterAttentionFrame {
  x: number;
  y: number;
  targetType: AttentionTargetType;
  semanticObjectId?: string;
}

const EXPECTED_PRIORITY: Record<AttentionTargetType, number> = {
  interruption: 100,
  learner_activity: 96,
  learner_drawing: 90,
  learner_pointer: 82,
  learner_touch: 82,
  focused_object: 82,
  tutor_pen: 70,
  semantic_object: 60,
  caption_question: 50,
  neutral_learner: 10,
};

const ALPHA: Record<SmoothingProfile, number> = { immediate: 1, responsive: 0.34, gentle: 0.16 };

export class CharacterAttentionController {
  private identity: GenerationIdentity;
  private active: CharacterAttentionTarget | null = null;
  private x = 0;
  private y = 0;
  private lastPointer: [number, number] | null = null;
  private reducedMotion: boolean;

  constructor(identity: GenerationIdentity, reducedMotion = false) {
    this.identity = identity;
    this.reducedMotion = reducedMotion;
  }

  replaceGeneration(identity: GenerationIdentity): void {
    this.identity = identity;
    this.active = null;
    this.lastPointer = null;
    this.x = 0;
    this.y = 0;
  }

  setReducedMotion(value: boolean): void { this.reducedMotion = value; }

  offer(target: CharacterAttentionTarget): boolean {
    if (!this.isCurrent(target)) return false;
    if (this.reducedMotion && !target.permittedInReducedMotion) return false;
    if (target.priority !== EXPECTED_PRIORITY[target.targetType]) return false;
    if (target.expiryTime <= target.startTime) return false;
    if (target.targetType === 'learner_pointer' && target.boardCoordinates && this.lastPointer) {
      if (Math.hypot(target.boardCoordinates[0] - this.lastPointer[0], target.boardCoordinates[1] - this.lastPointer[1]) < 18) return false;
    }
    if (target.targetType === 'learner_pointer' && target.boardCoordinates) this.lastPointer = target.boardCoordinates;
    if (this.active && this.active.expiryTime > target.startTime && this.active.priority > target.priority) return false;
    this.active = target;
    return true;
  }

  cancelGeneration(identity: GenerationIdentity): void {
    if (this.matches(identity)) {
      this.active = null;
      this.x = 0;
      this.y = 0;
    }
  }

  frame(now: number): CharacterAttentionFrame {
    if (this.active && now >= this.active.expiryTime) this.active = null;
    const target = this.active ?? {
      ...this.identity,
      targetType: 'neutral_learner' as const,
      priority: EXPECTED_PRIORITY.neutral_learner,
      startTime: now,
      expiryTime: now + 1000,
      smoothingProfile: 'gentle' as const,
      permittedInReducedMotion: true,
    };
    const destination = target.boardCoordinates
      ? [clamp((target.boardCoordinates[0] - 500) / 500), clamp((target.boardCoordinates[1] - 300) / 300)] as const
      : [0, target.targetType === 'caption_question' ? 0.32 : 0] as const;
    const alpha = this.reducedMotion ? 1 : ALPHA[target.smoothingProfile];
    this.x = clamp(this.x + (destination[0] - this.x) * alpha);
    this.y = clamp(this.y + (destination[1] - this.y) * alpha);
    return { x: this.x, y: this.y, targetType: target.targetType, ...(target.semanticObjectId ? { semanticObjectId: target.semanticObjectId } : {}) };
  }

  private isCurrent(target: CharacterAttentionTarget): boolean {
    return this.matches(target);
  }

  private matches(identity: GenerationIdentity): boolean {
    return identity.sessionId === this.identity.sessionId && identity.connectionEpoch === this.identity.connectionEpoch && identity.turnId === this.identity.turnId && identity.generationId === this.identity.generationId;
  }
}

export function attentionPriority(targetType: AttentionTargetType): number { return EXPECTED_PRIORITY[targetType]; }
function clamp(value: number): number { return Math.max(-0.78, Math.min(0.78, value)); }
