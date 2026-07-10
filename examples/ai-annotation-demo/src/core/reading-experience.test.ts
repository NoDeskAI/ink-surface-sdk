import { describe, expect, it } from 'vitest';
import {
  pageLayoutControlsAvailable,
  pdfOriginalControlsAvailable,
  optionalPdfAdaptationPageCap,
  readingControlsUnavailableHint,
  readingExperienceForSource,
} from './reading-experience';

describe('readingExperienceForSource', () => {
  it('keeps PDF reading on original pages and disables optimized reader preprocessing', () => {
    const experience = readingExperienceForSource('pdf');

    expect(experience).toMatchObject({
      schema: 'inkloop.reading_experience.v1',
      source_kind: 'pdf',
      primary_engine: 'pdfjs-original@v1',
      controls: {
        originalPage: true,
        spread: true,
        zoom: true,
        textReader: false,
        pdfAdaptation: false,
        markSummary: true,
      },
      preprocess: {
        status: 'none',
        output: 'preprocessed_pdf',
      },
      anchor_contract: {
        source_page_bbox: true,
        source_run_ids: true,
        reader_layout_id: true,
        inkloop_uri: true,
      },
    });
    expect(pdfOriginalControlsAvailable(experience)).toBe(true);
    expect(readingControlsUnavailableHint(experience)).toBe('');
  });

  it('keeps EPUB in publication reading mode and disables PDF-only controls', () => {
    const experience = readingExperienceForSource('epub');

    expect(experience.primary_engine).toBe('synthetic-html@v1');
    expect(experience.preprocess).toMatchObject({
      status: 'planned',
      engine: 'readium-publication@v1',
      runtime: 'android_native',
      output: 'publication_view',
    });
    expect(experience.controls).toMatchObject({
      originalPage: false,
      spread: true,
      zoom: false,
      textReader: true,
      pdfAdaptation: false,
      sourceBacklink: true,
      markSummary: true,
    });
    expect(pdfOriginalControlsAvailable(experience)).toBe(false);
    expect(pageLayoutControlsAvailable(experience)).toBe(true);
    expect(readingControlsUnavailableHint(experience)).toContain('EPUB');
  });

  it('treats Markdown as a synthetic reading surface with the same mark anchor contract', () => {
    const experience = readingExperienceForSource('markdown');

    expect(experience.primary_engine).toBe('synthetic-html@v1');
    expect(experience.preprocess).toMatchObject({ status: 'none', output: 'synthetic_surface' });
    expect(experience.marking).toMatchObject({
      pen: true,
      highlighter: true,
      underline: true,
      aiPen: true,
      readerLayoutSnapshot: true,
      sourcePageBbox: true,
      sourceRunIds: true,
    });
    expect(experience.anchor_contract).toMatchObject({
      source_page_bbox: true,
      source_run_ids: true,
      reader_layout_id: true,
      inkloop_uri: true,
    });
    expect(readingControlsUnavailableHint(experience)).toContain('Markdown');
  });

  it('does not run PDF adaptation page caching unless it is explicitly enabled', () => {
    expect(optionalPdfAdaptationPageCap(200, { enabled: false, pages: 80 })).toBe(0);
    expect(optionalPdfAdaptationPageCap(200, { enabled: true, pages: 12 })).toBe(12);
    expect(optionalPdfAdaptationPageCap(8, { enabled: true, pages: 12 })).toBe(8);
  });
});
