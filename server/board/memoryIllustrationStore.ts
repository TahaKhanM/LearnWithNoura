import type { IllustrationRecord, IllustrationStore } from './illustrationTypes.js';

/** In-memory blob store for tests and offline fixture generation. */
export class MemoryIllustrationStore implements IllustrationStore {
  private readonly byId = new Map<string, IllustrationRecord>();
  private readonly byKey = new Map<string, string>();

  async getById(id: string): Promise<IllustrationRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async getByCacheKey(key: string): Promise<IllustrationRecord | null> {
    const id = this.byKey.get(key);
    return id ? this.byId.get(id) ?? null : null;
  }

  async put(record: IllustrationRecord): Promise<void> {
    this.byId.set(record.id, record);
    this.byKey.set(record.cacheKey, record.id);
  }
}
