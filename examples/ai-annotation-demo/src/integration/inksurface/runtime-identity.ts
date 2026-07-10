import type { RuntimeDocumentIdentity, RuntimeDocumentSourceKind, RuntimeSourceRevision } from 'ink-surface-sdk/runtime-schema';

export interface RuntimeIdentityInput {
  sourceKind: RuntimeDocumentSourceKind;
  documentId?: string;
  sourcePath?: string;
  fileHash?: string;
  title?: string;
  contentHash?: string;
  createdAt?: string;
  updatedAt?: string;
  existingIdentity?: RuntimeDocumentIdentity | null;
}

export interface RuntimeIdentityResult {
  identity: RuntimeDocumentIdentity;
  sourceRevision: RuntimeSourceRevision;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanSegment(input: string): string {
  return input.normalize('NFKC').trim().replace(/[^a-zA-Z0-9._:/-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

function simpleHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function docIdFromStableKey(stableKey: string): string {
  return `doc_${simpleHash(stableKey)}${simpleHash([...stableKey].reverse().join(''))}`;
}

function stableKeyOf(input: RuntimeIdentityInput): string {
  if (input.sourceKind === 'imported_pdf') return `pdf:${input.fileHash || input.documentId || cleanSegment(input.title || 'pdf')}`;
  if (input.sourceKind === 'native_markdown') return `markdown:${input.sourcePath || input.documentId || cleanSegment(input.title || 'markdown')}`;
  return `inkloop:${input.documentId || input.sourcePath || cleanSegment(input.title || 'new-document')}`;
}

export function resolveRuntimeDocumentIdentity(input: RuntimeIdentityInput): RuntimeIdentityResult {
  const updatedAt = input.updatedAt ?? nowIso();
  const stableKey = input.existingIdentity?.stable_key ?? stableKeyOf(input);
  const docId = input.existingIdentity?.doc_id ?? input.documentId ?? docIdFromStableKey(stableKey);
  const identity: RuntimeDocumentIdentity = {
    schema_version: 'inkloop.runtime_document_identity.v1',
    doc_id: docId,
    source_kind: input.sourceKind,
    source_ref_id: input.existingIdentity?.source_ref_id ?? `src_${docId.replace(/^doc_/, '')}`,
    stable_key: stableKey,
    source_path: input.sourcePath ?? input.existingIdentity?.source_path,
    file_hash: input.fileHash ?? input.existingIdentity?.file_hash,
    created_at: input.existingIdentity?.created_at ?? input.createdAt ?? updatedAt,
    updated_at: updatedAt,
  };
  return {
    identity,
    sourceRevision: {
      revision_id: input.contentHash ? `rev_${simpleHash(`${docId}:${input.contentHash}`)}` : undefined,
      content_hash: input.contentHash,
      source_path: input.sourcePath,
      updated_at: updatedAt,
    },
  };
}
