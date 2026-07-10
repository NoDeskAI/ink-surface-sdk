export const READING_EXPERIENCE_SCHEMA = 'inkloop.reading_experience.v1' as const;

export type ReadingSourceKind = 'pdf' | 'epub' | 'markdown';

export type ReadingEngineId =
  | 'pdfjs-original@v1'
  | 'k2pdfopt-preprocess@v1'
  | 'synthetic-html@v1'
  | 'readium-publication@v1'
  | 'mupdf-preprocess@v1';

export type ReadingPreprocessStatus = 'none' | 'optional' | 'planned' | 'pending' | 'ready' | 'blocked';
export type ReadingPreprocessRuntime = 'cloud_hub' | 'android_native' | 'web' | 'manual';
export type ReadingPreprocessOutput = 'preprocessed_pdf' | 'publication_view' | 'synthetic_surface';

export interface ReadingControlCapabilities {
  originalPage: boolean;
  spread: boolean;
  zoom: boolean;
  textReader: boolean;
  pdfAdaptation: boolean;
  sourceBacklink: boolean;
  markSummary: boolean;
}

export interface ReadingMarkCapabilities {
  pen: boolean;
  highlighter: boolean;
  underline: boolean;
  aiPen: boolean;
  readerLayoutSnapshot: boolean;
  sourcePageBbox: boolean;
  sourceRunIds: boolean;
}

export interface ReadingPreprocessPlan {
  status: ReadingPreprocessStatus;
  engine?: ReadingEngineId;
  runtime?: ReadingPreprocessRuntime;
  output?: ReadingPreprocessOutput;
  reason: string;
}

export interface ReadingExperienceAnchorContract {
  source_page_bbox: boolean;
  source_run_ids: boolean;
  reader_layout_id: boolean;
  inkloop_uri: boolean;
}

export interface ReadingExperience {
  schema: typeof READING_EXPERIENCE_SCHEMA;
  source_kind: ReadingSourceKind;
  primary_engine: ReadingEngineId;
  controls: ReadingControlCapabilities;
  marking: ReadingMarkCapabilities;
  preprocess: ReadingPreprocessPlan;
  anchor_contract: ReadingExperienceAnchorContract;
}

export interface OptionalPdfAdaptationSettings {
  enabled: boolean;
  pages: number;
}

const MARKING_ALL: ReadingMarkCapabilities = {
  pen: true,
  highlighter: true,
  underline: true,
  aiPen: true,
  readerLayoutSnapshot: true,
  sourcePageBbox: true,
  sourceRunIds: true,
};

const ANCHOR_CONTRACT: ReadingExperienceAnchorContract = {
  source_page_bbox: true,
  source_run_ids: true,
  reader_layout_id: true,
  inkloop_uri: true,
};

function baseExperience(sourceKind: ReadingSourceKind): Pick<ReadingExperience, 'schema' | 'source_kind' | 'marking' | 'anchor_contract'> {
  return {
    schema: READING_EXPERIENCE_SCHEMA,
    source_kind: sourceKind,
    marking: MARKING_ALL,
    anchor_contract: ANCHOR_CONTRACT,
  };
}

export function readingExperienceForSource(sourceKind: ReadingSourceKind): ReadingExperience {
  if (sourceKind === 'pdf') {
    return {
      ...baseExperience(sourceKind),
      primary_engine: 'pdfjs-original@v1',
      controls: {
        originalPage: true,
        spread: true,
        zoom: true,
        textReader: false,
        pdfAdaptation: false,
        sourceBacklink: true,
        markSummary: true,
      },
      preprocess: {
        status: 'none',
        output: 'preprocessed_pdf',
        reason: 'V1 PDF 固定使用原版页阅读，保留单页/双页、适应页面/宽度、百分比缩放和标记摘要；暂不进入优化阅读或重排预处理。',
      },
    };
  }

  if (sourceKind === 'epub') {
    return {
      ...baseExperience(sourceKind),
      primary_engine: 'synthetic-html@v1',
      controls: {
        originalPage: false,
        spread: true,
        zoom: false,
        textReader: true,
        pdfAdaptation: false,
        sourceBacklink: true,
        markSummary: true,
      },
      preprocess: {
        status: 'planned',
        engine: 'readium-publication@v1',
        runtime: 'android_native',
        output: 'publication_view',
        reason: 'EPUB 本身是流式出版物；V1 先用统一 synthetic surface，后续接 Readium Kotlin 作为 Android 原生出版物解析层。',
      },
    };
  }

  return {
    ...baseExperience(sourceKind),
    primary_engine: 'synthetic-html@v1',
    controls: {
      originalPage: false,
      spread: false,
      zoom: false,
      textReader: true,
      pdfAdaptation: false,
      sourceBacklink: true,
      markSummary: true,
    },
    preprocess: {
      status: 'none',
      output: 'synthetic_surface',
      reason: 'Markdown 直接转换为统一 synthetic surface，不需要 PDF 式双页或缩放控件。',
    },
  };
}

export function pdfOriginalControlsAvailable(experience: ReadingExperience | null | undefined): boolean {
  return !!experience?.controls.originalPage && !!experience.controls.spread && !!experience.controls.zoom;
}

export function pageLayoutControlsAvailable(experience: ReadingExperience | null | undefined): boolean {
  return !!experience?.controls.spread;
}

export function readingControlsUnavailableHint(experience: ReadingExperience | null | undefined): string {
  if (!experience) return '先打开一本书';
  if (pdfOriginalControlsAvailable(experience)) return '';
  if (experience.source_kind === 'epub') return 'EPUB 支持单页/双页；缩放只作用于 PDF 原版页';
  if (experience.source_kind === 'markdown') return 'Markdown 使用文本阅读器；双页与缩放只作用于 PDF 原版页';
  return '当前文档不支持原版页布局控件';
}

export function optionalPdfAdaptationPageCap(
  pageCount: number,
  settings: OptionalPdfAdaptationSettings,
): number {
  if (!settings.enabled) return 0;
  const total = Math.max(0, Math.floor(Number(pageCount) || 0));
  const pages = Math.max(0, Math.floor(Number(settings.pages) || 0));
  return Math.min(total, pages);
}
