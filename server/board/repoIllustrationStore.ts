import type { DomainRepository } from '../store/domain.js';
import type { IllustrationRecord, IllustrationStore } from './illustrationTypes.js';

export function illustrationStoreFromRepo(repo: DomainRepository): IllustrationStore {
  return {
    getById: async (id) => toRecord(await repo.getBoardAsset(id)),
    getByCacheKey: async (key) => toRecord(await repo.getBoardAssetByCacheKey(key)),
    put: async (record) => {
      await repo.putBoardAsset(record);
    },
  };
}

function toRecord(row: IllustrationRecord | null): IllustrationRecord | null {
  return row;
}
