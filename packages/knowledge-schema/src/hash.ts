import { canonicalize } from './canonical-json.js';
import type { KnowledgeObject, KnowledgeObjectWithoutHash, Sha256 } from './knowledge-object.js';

const encoder = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Tagged(input: string): Promise<Sha256> {
  return `sha256:${await sha256Hex(input)}`;
}

export async function computeKnowledgeHash(ko: KnowledgeObjectWithoutHash): Promise<Sha256> {
  return sha256Tagged(canonicalize(ko));
}

export async function recomputeKnowledgeHash(ko: KnowledgeObject): Promise<Sha256> {
  const { content_hash: _contentHash, ...withoutHash } = ko;
  return computeKnowledgeHash(withoutHash);
}
