import type { DocumentProjection } from '../knowledge/document-projection';
import type { KnowledgeObject, KnowledgeStatus, Privacy } from '../knowledge/knowledge-object';
import type { NormBBox } from '../core/contracts';

export interface InkLoopDoc {
  document_id: string;
  filename?: string;
  title?: string;
  page_count?: number;
}

export interface InkLoopMark {
  mark_id: string;
  document_id: string;
  page_id?: string;
  page_index?: number;
  bbox?: NormBBox;
  hmp?: {
    target_object_refs?: string[];
    object_refs?: string[];
    anchor_bbox?: NormBBox;
    text_hint?: string;
  } | null;
  marked_text?: string;
  feature_type?: string;
  kind?: string;
  is_tombstone?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface InkLoopAiTurn {
  entry_id: string;
  document_id: string;
  page_id?: string;
  page_index?: number;
  ai_reply: string;
  overlay_state?: string;
  user_question?: string;
  trigger?: string;
  anchor?: {
    mark_ids?: string[];
    object_refs?: string[];
  };
  inference_view?: {
    question?: string;
    anchor_bbox?: NormBBox;
  };
  created_at?: string;
  updated_at?: string;
}

export interface InkLoopDocumentBlock {
  id: string;
  type: 'heading' | 'para' | 'list' | string;
  level?: number;
  text: string;
  source: NormBBox;
  items?: string[];
  ordered?: boolean;
  sourceRunIds?: string[];
  anchorUnsafe?: boolean;
}

export interface InkLoopDocumentPage {
  page_id?: string;
  page_index: number;
  reflow?: InkLoopDocumentBlock[] | null;
  reflow_engine?: string | null;
  text_md?: string;
  status?: 'pending' | 'reflowed' | 'done' | string;
}

export interface KnowledgeQuery {
  document_id?: string;
  status?: KnowledgeStatus[];
  privacy?: Privacy[];
}

export interface KnowledgeBuilderStorePort {
  getDoc(documentId: string): Promise<InkLoopDoc | null>;
  listDocs(): Promise<InkLoopDoc[]>;
  getFoldedMarks(documentId: string): Promise<InkLoopMark[]>;
  getFoldedAiTurns(documentId: string): Promise<InkLoopAiTurn[]>;
  getKoIdByProvenanceKey(key: string): Promise<string | null>;
  putKoIdentity(key: string, koId: string): Promise<void>;
  upsertKnowledgeObject?(ko: KnowledgeObject): Promise<void>;
  listKnowledgeObjects?(query: KnowledgeQuery): Promise<KnowledgeObject[]>;
}

export interface BuildKnowledgeObjectsInput {
  document_id?: string;
  mark_ids?: string[];
  ai_turn_ids?: string[];
  include_dismissed?: boolean;
  include_archived?: boolean;
  now?: string;
}

export interface BuildKnowledgeObjectsResult {
  objects: KnowledgeObject[];
  skipped: Array<{
    reason: 'privacy_local_only' | 'folded' | 'dismissed' | 'empty_body' | 'missing_source' | 'unsupported_kind';
    source_id: string;
    detail?: string;
  }>;
  warnings: Array<{
    code: string;
    detail: string;
  }>;
}

export interface BuildDocumentProjectionsInput {
  document_id?: string;
  now?: string;
  app_version?: string;
  reflow_engine?: string;
  include_full_text?: boolean;
  privacy?: Privacy;
}

export interface BuildDocumentProjectionsResult {
  projections: DocumentProjection[];
  skipped: Array<{
    reason: 'missing_source' | 'privacy_local_only' | 'empty_document';
    source_id: string;
    detail?: string;
  }>;
  warnings: Array<{
    code: 'missing_page_text' | 'missing_page_cache' | 'anchor_unstable';
    detail: string;
    page_index?: number;
  }>;
}

export interface DocumentProjectionBuilderStorePort {
  getDoc(documentId: string): Promise<InkLoopDoc | null>;
  listDocs(): Promise<InkLoopDoc[]>;
  getDocumentProjectionPages(documentId: string, options?: { reflow_engine?: string }): Promise<InkLoopDocumentPage[]>;
  listKnowledgeObjects?(query: KnowledgeQuery): Promise<KnowledgeObject[]>;
  upsertDocumentProjection?(projection: DocumentProjection): Promise<void>;
}
