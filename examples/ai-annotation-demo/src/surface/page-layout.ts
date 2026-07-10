export type PdfSpreadOrientation = 'horizontal' | 'vertical';
export type PdfZoomMode = 'fit-width' | 'fit-page' | 'percent';

export interface PdfViewportBox {
  width: number;
  height: number;
}

export interface PdfPageBox {
  width: number;
  height: number;
}

export interface PdfScaleOptions {
  page: PdfPageBox;
  viewport: PdfViewportBox;
  spread: boolean;
  orientation: PdfSpreadOrientation;
  zoomMode: PdfZoomMode;
  zoomPercent: number;
  gap: number;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

export function pdfSpreadOrientation(viewport: PdfViewportBox): PdfSpreadOrientation {
  return viewport.width >= viewport.height ? 'horizontal' : 'vertical';
}

export function pdfScaleForBox(options: PdfScaleOptions): number {
  const pageWidth = Math.max(1, options.page.width);
  const pageHeight = Math.max(1, options.page.height);
  const viewportWidth = Math.max(1, options.viewport.width);
  const viewportHeight = Math.max(1, options.viewport.height);
  const gap = Math.max(0, options.gap);

  if (options.zoomMode === 'percent') return clampScale(options.zoomPercent / 100);

  const spreadHorizontal = options.spread && options.orientation === 'horizontal';
  const spreadVertical = options.spread && options.orientation === 'vertical';
  const contentWidth = spreadHorizontal ? pageWidth * 2 : pageWidth;
  const contentHeight = spreadVertical ? pageHeight * 2 : pageHeight;
  const widthScale = Math.max(1, viewportWidth - (spreadHorizontal ? gap : 0)) / contentWidth;
  const heightScale = Math.max(1, viewportHeight - (spreadVertical ? gap : 0)) / contentHeight;

  // The paper/mobile reader is page-flip based, not scroll based. In portrait
  // spread mode the two pages are stacked vertically; using pure width-fit
  // would put page 2 below the clipped viewport and make "双页" look unchanged.
  if (options.zoomMode === 'fit-width' && options.spread && options.orientation === 'vertical') {
    return clampScale(Math.min(widthScale, heightScale));
  }
  if (options.zoomMode === 'fit-width') return clampScale(widthScale);
  return clampScale(Math.min(widthScale, heightScale));
}
