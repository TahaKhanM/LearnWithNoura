import { z } from 'zod';

export const EVENT_SCHEMA_VERSION = '1.0.0' as const;

export const RuntimeEventEnvelopeSchema = z.object({
  eventId: z.string().min(8).max(160),
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  sessionId: z.string().min(1).max(160),
  connectionEpoch: z.number().int().nonnegative(),
  turnId: z.string().min(1).max(160),
  generationId: z.string().min(1).max(160),
  sequence: z.number().int().nonnegative(),
  type: z.string().min(1).max(120),
  payload: z.unknown(),
  providerResponseId: z.string().min(1).max(200).optional(),
  providerItemId: z.string().min(1).max(200).optional(),
  visualCueId: z.string().min(1).max(160).optional(),
  semanticObjectId: z.string().min(1).max(160).optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export type RuntimeEventEnvelope<TPayload = unknown> = Omit<
  z.infer<typeof RuntimeEventEnvelopeSchema>,
  'payload'
> & { payload: TPayload };

export interface GenerationIdentity {
  sessionId: string;
  connectionEpoch: number;
  turnId: string;
  generationId: string;
}

export function createRuntimeEvent<TPayload>(
  identity: GenerationIdentity,
  sequence: number,
  type: string,
  payload: TPayload,
  optional: Partial<Pick<RuntimeEventEnvelope,
    'providerResponseId' | 'providerItemId' | 'visualCueId' |
    'semanticObjectId' | 'idempotencyKey'>> = {},
): RuntimeEventEnvelope<TPayload> {
  return RuntimeEventEnvelopeSchema.parse({
    eventId: globalThis.crypto.randomUUID(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    ...identity,
    sequence,
    type,
    payload,
    ...optional,
  }) as RuntimeEventEnvelope<TPayload>;
}

/** Rejects stale, duplicated, and non-monotonic events before any mutation. */
export class RuntimeEventGate {
  private active: GenerationIdentity;
  private seen = new Set<string>();
  private lastSequence = -1;

  constructor(active: GenerationIdentity) {
    this.active = active;
  }

  replace(active: GenerationIdentity): void {
    this.active = active;
    this.seen.clear();
    this.lastSequence = -1;
  }

  accept(input: unknown): input is RuntimeEventEnvelope {
    const parsed = RuntimeEventEnvelopeSchema.safeParse(input);
    if (!parsed.success) return false;
    const event = parsed.data;
    if (
      event.sessionId !== this.active.sessionId ||
      event.connectionEpoch !== this.active.connectionEpoch ||
      event.turnId !== this.active.turnId ||
      event.generationId !== this.active.generationId ||
      event.sequence <= this.lastSequence ||
      this.seen.has(event.eventId)
    ) return false;
    this.seen.add(event.eventId);
    this.lastSequence = event.sequence;
    return true;
  }
}
