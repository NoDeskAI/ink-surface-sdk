import { describe, expect, it } from 'vitest';

import { pdfScaleForBox, pdfSpreadOrientation } from './page-layout';

describe('PDF page layout', () => {
  it('uses vertical spread in portrait viewports and horizontal spread in landscape viewports', () => {
    expect(pdfSpreadOrientation({ width: 900, height: 1200 })).toBe('vertical');
    expect(pdfSpreadOrientation({ width: 1200, height: 900 })).toBe('horizontal');
  });

  it('fits the whole vertical spread in fit-page mode', () => {
    const scale = pdfScaleForBox({
      page: { width: 600, height: 800 },
      viewport: { width: 1200, height: 900 },
      spread: true,
      orientation: 'vertical',
      zoomMode: 'fit-page',
      zoomPercent: 100,
      gap: 22,
    });

    expect(scale).toBeCloseTo((900 - 22) / (800 * 2), 5);
  });

  it('fills the spread width in fit-width mode without height clamping', () => {
    const fitPage = pdfScaleForBox({
      page: { width: 600, height: 800 },
      viewport: { width: 1600, height: 900 },
      spread: true,
      orientation: 'horizontal',
      zoomMode: 'fit-page',
      zoomPercent: 100,
      gap: 22,
    });
    const fitWidth = pdfScaleForBox({
      page: { width: 600, height: 800 },
      viewport: { width: 1600, height: 900 },
      spread: true,
      orientation: 'horizontal',
      zoomMode: 'fit-width',
      zoomPercent: 100,
      gap: 22,
    });

    expect(fitPage).toBeCloseTo(900 / 800, 5);
    expect(fitWidth).toBeCloseTo((1600 - 22) / (600 * 2), 5);
    expect(fitWidth).toBeGreaterThan(fitPage);
  });

  it('keeps both pages visible for vertical spread in fit-width mode', () => {
    const scale = pdfScaleForBox({
      page: { width: 600, height: 800 },
      viewport: { width: 820, height: 1128 },
      spread: true,
      orientation: 'vertical',
      zoomMode: 'fit-width',
      zoomPercent: 100,
      gap: 22,
    });

    expect(scale).toBeCloseTo((1128 - 22) / (800 * 2), 5);
  });
});
