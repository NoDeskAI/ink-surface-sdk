import type { OcrTextBlock } from '../core/contracts';
import { analyzeReflowCandidate, type ReflowQualityReport } from './reflow-quality';
import type { ReaderPageMap } from './reader-page-map';
import { LOCAL_REFLOW_ENGINE, type ReflowBlock } from './reflow';

export const REFLOW_ARTIFACT_SCHEMA = 'inkloop.reflow_artifact.v1';
export const REFLOW_ARTIFACT_MIGRATION_ID = 'reflow-artifact-v1';
export const DEFAULT_REFLOW_OPTION_FINGERPRINT = 'options:default';

export type ReflowArtifactStatus =
  | 'text_ready'
  | 'layout_ready'
  | 'page_map_ready'
  | 'no_text'
  | 'low_quality'
  | 'complex_layout'
  | 'stale'
  | 'error'
  | 'legacy_approximate';

export type ReflowArtifactReadiness = 'ready' | 'pending' | 'blocked' | 'legacy';
export type ReflowPageMapStatus = 'pending' | 'ready' | 'stale' | 'blocked' | 'legacy';

export interface PersistedReflowArtifactQualitySummary {
  normalized_text_matches?: boolean;
  source_run_coverage?: number;
  source_run_count?: number;
  covered_run_count?: number;
  blockers?: string[];
  warnings?: string[];
}

export interface PersistedReflowArtifactPageMapSummary {
  status: ReflowPageMapStatus;
  layout_id?: string;
  reader_page_count?: number;
  updated_at?: string;
}

export interface PersistedReflowArtifact {
  schema: typeof REFLOW_ARTIFACT_SCHEMA;
  migration_id: typeof REFLOW_ARTIFACT_MIGRATION_ID;
  artifact_id: string;
  document_id: string;
  page_id: string;
  page_index: number;
  source_revision: string;
  engine: string;
  legacy_engine?: string;
  option_fingerprint: string;
  layout_fingerprint?: string | null;
  status: ReflowArtifactStatus;
  fallback_reason?: string;
  text_readiness: ReflowArtifactReadiness;
  layout_readiness: ReflowArtifactReadiness;
  page_map: PersistedReflowArtifactPageMapSummary;
  reader_page_map?: ReaderPageMap;
  quality?: PersistedReflowArtifactQualitySummary;
  blocks: ReflowBlock[];
  created_at: string;
  updated_at: string;
}

export interface CreateReflowArtifactInput {
  documentId: string;
  pageId: string;
  pageIndex: number;
  sourceRevision: string;
  engine: string;
  blocks: ReflowBlock[];
  status?: ReflowArtifactStatus;
  fallbackReason?: string;
  optionFingerprint?: string;
  layoutFingerprint?: string | null;
  quality?: PersistedReflowArtifactQualitySummary;
  pageMap?: Partial<PersistedReflowArtifactPageMapSummary>;
  readerPageMap?: ReaderPageMap;
  now?: string;
}

export interface CreateQualityGatedReflowArtifactInput extends Omit<CreateReflowArtifactInput, 'status' | 'fallbackReason' | 'quality'> {
  sourceBlocks: OcrTextBlock[];
  reflowBlocks?: ReflowBlock[];
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function readinessForStatus(status: ReflowArtifactStatus): {
  text: ReflowArtifactReadiness;
  layout: ReflowArtifactReadiness;
  pageMap: ReflowPageMapStatus;
} {
  if (status === 'legacy_approximate') return { text: 'legacy', layout: 'legacy', pageMap: 'legacy' };
  if (status === 'layout_ready') return { text: 'ready', layout: 'ready', pageMap: 'pending' };
  if (status === 'page_map_ready') return { text: 'ready', layout: 'ready', pageMap: 'ready' };
  if (status === 'text_ready') return { text: 'ready', layout: 'pending', pageMap: 'pending' };
  if (status === 'stale') return { text: 'pending', layout: 'pending', pageMap: 'stale' };
  return { text: 'blocked', layout: 'blocked', pageMap: 'blocked' };
}

export function normalizeReflowEngineKey(engine: string | null | undefined): string {
  if (!engine || engine === 'local') return LOCAL_REFLOW_ENGINE;
  return engine;
}

export function reflowArtifactId(input: {
  documentId: string;
  pageIndex: number;
  sourceRevision: string;
  engine: string;
  optionFingerprint: string;
  layoutFingerprint?: string | null;
}): string {
  const normalizedEngine = normalizeReflowEngineKey(input.engine);
  const raw = [
    input.documentId,
    input.pageIndex,
    input.sourceRevision,
    normalizedEngine,
    input.optionFingerprint,
    input.layoutFingerprint ?? '',
  ].join('|');
  return `rflart_${stableHash(raw)}`;
}

export function createReflowArtifact(input: CreateReflowArtifactInput): PersistedReflowArtifact {
  const status = input.status ?? 'text_ready';
  const readiness = readinessForStatus(status);
  const engine = normalizeReflowEngineKey(input.engine);
  const optionFingerprint = input.optionFingerprint ?? DEFAULT_REFLOW_OPTION_FINGERPRINT;
  const now = input.now ?? new Date().toISOString();
  return {
    schema: REFLOW_ARTIFACT_SCHEMA,
    migration_id: REFLOW_ARTIFACT_MIGRATION_ID,
    artifact_id: reflowArtifactId({
      documentId: input.documentId,
      pageIndex: input.pageIndex,
      sourceRevision: input.sourceRevision,
      engine,
      optionFingerprint,
      layoutFingerprint: input.layoutFingerprint,
    }),
    document_id: input.documentId,
    page_id: input.pageId,
    page_index: input.pageIndex,
    source_revision: input.sourceRevision,
    engine,
    ...(input.engine !== engine ? { legacy_engine: input.engine } : {}),
    option_fingerprint: optionFingerprint,
    layout_fingerprint: input.layoutFingerprint ?? null,
    status,
    ...(input.fallbackReason ? { fallback_reason: input.fallbackReason } : {}),
    text_readiness: readiness.text,
    layout_readiness: readiness.layout,
    page_map: {
      status: input.pageMap?.status ?? readiness.pageMap,
      layout_id: input.pageMap?.layout_id,
      reader_page_count: input.pageMap?.reader_page_count,
      updated_at: input.pageMap?.updated_at,
    },
    reader_page_map: input.readerPageMap,
    quality: input.quality,
    blocks: input.blocks,
    created_at: now,
    updated_at: now,
  };
}

function artifactStatusFromQuality(report: ReflowQualityReport): ReflowArtifactStatus {
  if (report.status === 'text_ready') return 'text_ready';
  return report.status;
}

function qualitySummaryFromReport(report: ReflowQualityReport): PersistedReflowArtifactQualitySummary {
  return {
    normalized_text_matches: report.normalized_text_matches,
    source_run_coverage: report.source_run_coverage,
    source_run_count: report.source_run_count,
    covered_run_count: report.covered_run_count,
    blockers: report.promotion_blockers,
    warnings: report.warnings,
  };
}

export function createQualityGatedReflowArtifact(input: CreateQualityGatedReflowArtifactInput): {
  artifact: PersistedReflowArtifact;
  quality: ReflowQualityReport;
} {
  const reflowBlocks = input.reflowBlocks ?? input.blocks;
  const quality = analyzeReflowCandidate({
    page: input.pageIndex + 1,
    blocks: input.sourceBlocks,
    reflowBlocks,
  });
  const status = artifactStatusFromQuality(quality);
  return {
    quality,
    artifact: createReflowArtifact({
      ...input,
      blocks: reflowBlocks,
      status,
      fallbackReason: quality.promotion_blockers[0],
      quality: qualitySummaryFromReport(quality),
    }),
  };
}

export function legacyReflowArtifact(input: {
  documentId: string;
  pageId: string;
  pageIndex: number;
  sourceRevision: string;
  engine: string | null;
  blocks: ReflowBlock[];
  now?: string;
}): PersistedReflowArtifact {
  return createReflowArtifact({
    documentId: input.documentId,
    pageId: input.pageId,
    pageIndex: input.pageIndex,
    sourceRevision: input.sourceRevision,
    engine: input.engine ?? LOCAL_REFLOW_ENGINE,
    blocks: input.blocks,
    status: 'legacy_approximate',
    fallbackReason: 'legacy_reflow_cache',
    quality: { warnings: ['legacy_metadata_missing'] },
    now: input.now,
  });
}

export function reflowArtifactMatchesEngine(artifact: PersistedReflowArtifact | null | undefined, engine: string): boolean {
  return !!artifact
    && artifact.schema === REFLOW_ARTIFACT_SCHEMA
    && normalizeReflowEngineKey(artifact.engine) === normalizeReflowEngineKey(engine);
}

export function isReflowArtifactRenderable(artifact: PersistedReflowArtifact | null | undefined): boolean {
  return !!artifact && (
    artifact.status === 'text_ready'
    || artifact.status === 'layout_ready'
    || artifact.status === 'page_map_ready'
    || artifact.status === 'legacy_approximate'
  );
}

export function reflowArtifactBlocksForEngine(
  artifact: PersistedReflowArtifact | null | undefined,
  engine: string,
): ReflowBlock[] | null {
  return reflowArtifactMatchesEngine(artifact, engine) && isReflowArtifactRenderable(artifact)
    ? artifact?.blocks ?? null
    : null;
}

export function withReaderPageMap(artifact: PersistedReflowArtifact, readerPageMap: ReaderPageMap): PersistedReflowArtifact {
  return {
    ...artifact,
    status: 'page_map_ready',
    layout_readiness: 'ready',
    page_map: {
      status: 'ready',
      layout_id: readerPageMap.layout_id,
      reader_page_count: readerPageMap.reader_page_count,
      updated_at: readerPageMap.created_at,
    },
    reader_page_map: readerPageMap,
    updated_at: readerPageMap.created_at,
  };
}

export function withStaleReaderPageMap(artifact: PersistedReflowArtifact): PersistedReflowArtifact {
  if (artifact.page_map.status !== 'ready') return artifact;
  return {
    ...artifact,
    status: artifact.status === 'page_map_ready' ? 'text_ready' : artifact.status,
    layout_readiness: artifact.status === 'page_map_ready' ? 'pending' : artifact.layout_readiness,
    page_map: {
      ...artifact.page_map,
      status: 'stale',
    },
    reader_page_map: undefined,
    updated_at: new Date().toISOString(),
  };
}
