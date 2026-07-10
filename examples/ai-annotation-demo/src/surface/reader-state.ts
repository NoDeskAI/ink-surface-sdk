import type { PersistedReflowArtifact } from './reflow-artifact';

export type ReaderSurfaceState =
  | 'ready'
  | 'cached_ready'
  | 'processing'
  | 'low_quality'
  | 'no_text'
  | 'stale'
  | 'hard_error'
  | 'legacy_approximate';

export interface ReaderStateDecision {
  state: ReaderSurfaceState;
  label: string;
  detail?: string;
  visible_surface: 'reader' | 'original' | 'cached_reader';
  can_render_reader: boolean;
}

export function readerStateFromArtifact(
  artifact: PersistedReflowArtifact | null | undefined,
  options: { hasCachedReader?: boolean; error?: string } = {},
): ReaderStateDecision {
  if (options.error) {
    return {
      state: 'hard_error',
      label: '原版阅读',
      detail: options.error,
      visible_surface: options.hasCachedReader ? 'cached_reader' : 'original',
      can_render_reader: !!options.hasCachedReader,
    };
  }
  if (!artifact) {
    return {
      state: 'processing',
      label: '正在准备阅读视图',
      visible_surface: options.hasCachedReader ? 'cached_reader' : 'original',
      can_render_reader: !!options.hasCachedReader,
    };
  }
  if (artifact.status === 'legacy_approximate') {
    return {
      state: 'legacy_approximate',
      label: '旧版阅读视图',
      detail: '旧缓存缺少完整 artifact 元数据',
      visible_surface: 'reader',
      can_render_reader: true,
    };
  }
  if (artifact.status === 'text_ready' || artifact.status === 'layout_ready' || artifact.status === 'page_map_ready') {
    return {
      state: artifact.page_map.status === 'ready' ? 'ready' : 'cached_ready',
      label: '优化阅读',
      visible_surface: 'reader',
      can_render_reader: true,
    };
  }
  if (artifact.status === 'no_text') {
    return {
      state: 'no_text',
      label: '原版阅读',
      detail: '没有可用阅读文本',
      visible_surface: 'original',
      can_render_reader: false,
    };
  }
  if (artifact.status === 'stale') {
    return {
      state: 'stale',
      label: '正在刷新阅读视图',
      visible_surface: options.hasCachedReader ? 'cached_reader' : 'original',
      can_render_reader: !!options.hasCachedReader,
    };
  }
  return {
    state: 'low_quality',
    label: '已显示原版',
    detail: artifact.fallback_reason,
    visible_surface: 'original',
    can_render_reader: false,
  };
}
