import { describe, expect, it } from 'vitest';

import type { PersistedReflowArtifact } from './reflow-artifact';
import { readerStateFromArtifact } from './reader-state';

function artifact(status: PersistedReflowArtifact['status']): PersistedReflowArtifact {
  return {
    schema: 'inkloop.reflow_artifact.v1',
    migration_id: 'reflow-artifact-v1',
    artifact_id: `a_${status}`,
    document_id: 'doc',
    page_id: 'pg_doc_0',
    page_index: 0,
    source_revision: 'sha256:doc',
    engine: 'local@v5',
    option_fingerprint: 'options:default',
    layout_fingerprint: null,
    status,
    fallback_reason: status === 'low_quality' ? 'text_mismatch' : undefined,
    text_readiness: status === 'no_text' || status === 'low_quality' ? 'blocked' : 'ready',
    layout_readiness: status === 'page_map_ready' ? 'ready' : 'pending',
    page_map: { status: status === 'page_map_ready' ? 'ready' : 'pending' },
    blocks: [],
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
  };
}

describe('reader state decision', () => {
  it('keeps original visible while reflow is processing without cached content', () => {
    expect(readerStateFromArtifact(null)).toMatchObject({
      state: 'processing',
      label: '正在准备阅读视图',
      visible_surface: 'original',
      can_render_reader: false,
    });
  });

  it('allows valid current artifacts to render in reader mode', () => {
    expect(readerStateFromArtifact(artifact('page_map_ready'))).toMatchObject({
      state: 'ready',
      label: '优化阅读',
      visible_surface: 'reader',
      can_render_reader: true,
    });
  });

  it('routes no-text and low-quality artifacts to original source fallback', () => {
    expect(readerStateFromArtifact(artifact('no_text'))).toMatchObject({
      state: 'no_text',
      label: '原版阅读',
      detail: '没有可用阅读文本',
      visible_surface: 'original',
      can_render_reader: false,
    });
    expect(readerStateFromArtifact(artifact('low_quality'))).toMatchObject({
      state: 'low_quality',
      label: '已显示原版',
      visible_surface: 'original',
      can_render_reader: false,
    });
  });

  it('keeps cached reader content for hard errors only when a cached surface exists', () => {
    expect(readerStateFromArtifact(null, { error: 'boom' })).toMatchObject({
      state: 'hard_error',
      visible_surface: 'original',
      can_render_reader: false,
    });
    expect(readerStateFromArtifact(null, { error: 'boom', hasCachedReader: true })).toMatchObject({
      state: 'hard_error',
      visible_surface: 'cached_reader',
      can_render_reader: true,
    });
  });
});
