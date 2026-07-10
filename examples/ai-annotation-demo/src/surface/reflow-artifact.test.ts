import { describe, expect, it } from 'vitest';

import type { OcrTextBlock } from '../core/contracts';
import { LOCAL_REFLOW_ENGINE, type ReflowBlock } from './reflow';
import {
  createReflowArtifact,
  createQualityGatedReflowArtifact,
  legacyReflowArtifact,
  normalizeReflowEngineKey,
  reflowArtifactBlocksForEngine,
  withReaderPageMap,
  withStaleReaderPageMap,
} from './reflow-artifact';
import { createReaderPageMap } from './reader-page-map';

const blocks: ReflowBlock[] = [{
  id: 'rfl_test',
  type: 'para',
  level: 0,
  text: '规则重排必须保留原文。',
  source: [0.1, 0.1, 0.8, 0.04],
  sourceRunIds: ['run-1', 'run-2'],
}];

const sourceBlocks: OcrTextBlock[] = [
  {
    id: 'run-1',
    text: '规则重排必须',
    bbox: [0.1, 0.1, 0.36, 0.04],
    confidence: 1,
    language: 'zh-CN',
  },
  {
    id: 'run-2',
    text: '保留原文。',
    bbox: [0.46, 0.1, 0.28, 0.04],
    confidence: 1,
    language: 'zh-CN',
  },
];

describe('reflow artifact contract', () => {
  it('normalizes legacy local engine aliases to the current local engine key', () => {
    expect(normalizeReflowEngineKey('local')).toBe(LOCAL_REFLOW_ENGINE);
    expect(normalizeReflowEngineKey(LOCAL_REFLOW_ENGINE)).toBe(LOCAL_REFLOW_ENGINE);
  });

  it('creates deterministic current artifacts with source revision and readiness metadata', () => {
    const first = createReflowArtifact({
      documentId: 'doc_demo',
      pageId: 'pg_demo_0',
      pageIndex: 0,
      sourceRevision: 'sha256:demo',
      engine: 'local',
      blocks,
      now: '2026-07-06T00:00:00.000Z',
    });
    const second = createReflowArtifact({
      documentId: 'doc_demo',
      pageId: 'pg_demo_0',
      pageIndex: 0,
      sourceRevision: 'sha256:demo',
      engine: LOCAL_REFLOW_ENGINE,
      blocks,
      now: '2026-07-06T00:01:00.000Z',
    });

    expect(first.artifact_id).toBe(second.artifact_id);
    expect(first.engine).toBe(LOCAL_REFLOW_ENGINE);
    expect(first.legacy_engine).toBe('local');
    expect(first.source_revision).toBe('sha256:demo');
    expect(first.text_readiness).toBe('ready');
    expect(first.layout_readiness).toBe('pending');
    expect(first.page_map.status).toBe('pending');
  });

  it('wraps old metadata-free reflow caches as legacy approximate artifacts', () => {
    const artifact = legacyReflowArtifact({
      documentId: 'doc_demo',
      pageId: 'pg_demo_0',
      pageIndex: 0,
      sourceRevision: 'sha256:demo',
      engine: 'local',
      blocks,
      now: '2026-07-06T00:00:00.000Z',
    });

    expect(artifact.status).toBe('legacy_approximate');
    expect(artifact.text_readiness).toBe('legacy');
    expect(artifact.fallback_reason).toBe('legacy_reflow_cache');
    expect(reflowArtifactBlocksForEngine(artifact, LOCAL_REFLOW_ENGINE)).toBe(blocks);
  });

  it('does not let a non-local provider satisfy the local engine contract', () => {
    const artifact = createReflowArtifact({
      documentId: 'doc_demo',
      pageId: 'pg_demo_0',
      pageIndex: 0,
      sourceRevision: 'sha256:demo',
      engine: 'external-test@v1',
      blocks,
      now: '2026-07-06T00:00:00.000Z',
    });

    expect(reflowArtifactBlocksForEngine(artifact, 'external-test@v1')).toBe(blocks);
    expect(reflowArtifactBlocksForEngine(artifact, LOCAL_REFLOW_ENGINE)).toBeNull();
  });

  it('creates quality-gated artifacts and blocks failed candidates from renderable cache reads', () => {
    const ready = createQualityGatedReflowArtifact({
      documentId: 'doc_demo',
      pageId: 'pg_demo_0',
      pageIndex: 0,
      sourceRevision: 'sha256:demo',
      engine: LOCAL_REFLOW_ENGINE,
      blocks,
      sourceBlocks,
      now: '2026-07-06T00:00:00.000Z',
    }).artifact;
    expect(ready.status).toBe('text_ready');
    expect(reflowArtifactBlocksForEngine(ready, LOCAL_REFLOW_ENGINE)).toBe(blocks);

    const noText = createQualityGatedReflowArtifact({
      documentId: 'doc_demo',
      pageId: 'pg_demo_1',
      pageIndex: 1,
      sourceRevision: 'sha256:demo',
      engine: LOCAL_REFLOW_ENGINE,
      blocks: [],
      sourceBlocks: [],
      now: '2026-07-06T00:00:00.000Z',
    }).artifact;
    expect(noText.status).toBe('no_text');
    expect(noText.text_readiness).toBe('blocked');
    expect(reflowArtifactBlocksForEngine(noText, LOCAL_REFLOW_ENGINE)).toBeNull();
  });

  it('promotes a text-ready artifact to page-map-ready after measured layout exists', () => {
    const artifact = createQualityGatedReflowArtifact({
      documentId: 'doc_demo',
      pageId: 'pg_demo_0',
      pageIndex: 0,
      sourceRevision: 'sha256:demo',
      engine: LOCAL_REFLOW_ENGINE,
      blocks,
      sourceBlocks,
      now: '2026-07-06T00:00:00.000Z',
    }).artifact;
    const pageMap = createReaderPageMap({
      layout: {
        schema: 'inkloop.reader_layout.v1',
        layout_id: 'reader_layout_a',
        page_index: 0,
        page_id: 'pg_demo_0',
        capture_surface: 'reader',
        coord_space: 'reader_px',
        width: 800,
        height: 810,
        style_fingerprint: 'style-a',
        text_runs: [{ block_id: 'rfl_test', text: '规则重排必须保留原文。', x: 20, y: 60, w: 400, h: 30, font_size: 24 }],
        updated_at: '2026-07-06T00:01:00.000Z',
      },
      sourceBlocks: [{ id: 'rfl_test', sourceRunIds: ['run-1'] }],
      viewportHeight: 810,
      now: '2026-07-06T00:01:00.000Z',
    });

    const promoted = withReaderPageMap(artifact, pageMap);

    expect(promoted.status).toBe('page_map_ready');
    expect(promoted.layout_readiness).toBe('ready');
    expect(promoted.page_map).toMatchObject({
      status: 'ready',
      layout_id: 'reader_layout_a',
      reader_page_count: 1,
    });
    expect(promoted.reader_page_map?.entries[0]).toMatchObject({
      block_id: 'rfl_test',
      source_run_ids: ['run-1'],
      reader_page_index: 0,
    });
  });

  it('can downgrade a stale measured page map back to text-ready', () => {
    const artifact = createQualityGatedReflowArtifact({
      documentId: 'doc_demo',
      pageId: 'pg_demo_0',
      pageIndex: 0,
      sourceRevision: 'sha256:demo',
      engine: LOCAL_REFLOW_ENGINE,
      blocks,
      sourceBlocks,
      now: '2026-07-06T00:00:00.000Z',
    }).artifact;
    const pageMap = createReaderPageMap({
      layout: {
        schema: 'inkloop.reader_layout.v1',
        layout_id: 'reader_layout_a',
        page_index: 0,
        page_id: 'pg_demo_0',
        capture_surface: 'reader',
        coord_space: 'reader_px',
        width: 800,
        height: 810,
        style_fingerprint: 'style-a',
        text_runs: [{ block_id: 'rfl_test', text: '规则重排必须保留原文。', x: 20, y: 60, w: 400, h: 30, font_size: 24 }],
        updated_at: '2026-07-06T00:01:00.000Z',
      },
      sourceBlocks: [{ id: 'rfl_test', sourceRunIds: ['run-1'] }],
      viewportHeight: 810,
      now: '2026-07-06T00:01:00.000Z',
    });

    const stale = withStaleReaderPageMap(withReaderPageMap(artifact, pageMap));

    expect(stale.status).toBe('text_ready');
    expect(stale.layout_readiness).toBe('pending');
    expect(stale.page_map.status).toBe('stale');
    expect(stale.reader_page_map).toBeUndefined();
    expect(reflowArtifactBlocksForEngine(stale, LOCAL_REFLOW_ENGINE)).toBe(blocks);
  });
});
