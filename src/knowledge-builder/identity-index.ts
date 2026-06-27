import { koId } from '../knowledge/ulid';
import type { KnowledgeBuilderStorePort } from './types';

export class MemoryKnowledgeIdentityStore {
  private ids = new Map<string, string>();

  async getKoIdByProvenanceKey(key: string): Promise<string | null> {
    return this.ids.get(key) ?? null;
  }

  async putKoIdentity(key: string, id: string): Promise<void> {
    this.ids.set(key, id);
  }
}

export async function getOrCreateKoId(store: Pick<KnowledgeBuilderStorePort, 'getKoIdByProvenanceKey' | 'putKoIdentity'>, provenanceKey: string): Promise<string> {
  const existing = await store.getKoIdByProvenanceKey(provenanceKey);
  if (existing) return existing;
  const next = koId();
  await store.putKoIdentity(provenanceKey, next);
  return next;
}
