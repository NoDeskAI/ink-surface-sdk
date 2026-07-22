import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { ClassroomConfirmedFocus, ClassroomTeacherView, RuntimeNormBBox } from 'ink-surface-sdk/runtime-schema';
import { pdfScaleForBox, type PdfPageBox, type PdfViewportBox, type PdfZoomMode } from '../surface/page-layout';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function normalizedBoxStyle(box: RuntimeNormBBox): { left: string; top: string; width: string; height: string } {
  return { left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${box[2] * 100}%`, height: `${box[3] * 100}%` };
}

export function textbookScale(page: PdfPageBox, viewport: PdfViewportBox, zoomMode: PdfZoomMode, zoomPercent: number): number {
  return pdfScaleForBox({ page, viewport, zoomMode, zoomPercent, spread: false, orientation: 'vertical', gap: 0 });
}

export class TextbookRenderer {
  private document?: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  private bytes?: ArrayBuffer;
  private renderRevision = 0;
  private loadRevision = 0;
  private lastPageIndex = -1;

  constructor(readonly canvas: HTMLCanvasElement, readonly focus: HTMLElement) {}

  async load(bytes: ArrayBuffer): Promise<number> {
    const loadRevision = ++this.loadRevision;
    this.renderRevision += 1;
    const task = pdfjs.getDocument({ data: bytes.slice(0) });
    const nextDocument = await task.promise;
    if (loadRevision !== this.loadRevision) {
      await nextDocument.destroy().catch(() => undefined);
      return 0;
    }
    const previous = this.document;
    this.document = nextDocument;
    this.bytes = bytes.slice(0);
    this.lastPageIndex = -1;
    if (previous) await previous.destroy().catch(() => undefined);
    return nextDocument.numPages;
  }

  async render(view: ClassroomTeacherView): Promise<void> {
    if (!this.document) throw new Error('textbook_not_loaded');
    const revision = ++this.renderRevision;
    const document = this.document;
    const page = await document.getPage(view.page_index + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(1, Math.min(2.5, (view.viewport?.zoom_scale ?? view.zoom_percent / 100) * Math.max(1, window.devicePixelRatio || 1)));
    const viewport = page.getViewport({ scale });
    if (revision !== this.renderRevision || document !== this.document) return;
    const staging = this.canvas.ownerDocument.createElement('canvas');
    staging.width = Math.floor(viewport.width); staging.height = Math.floor(viewport.height);
    const task = page.render({ canvasContext: staging.getContext('2d')!, viewport });
    await task.promise;
    if (revision !== this.renderRevision || document !== this.document) return;
    this.canvas.width = staging.width; this.canvas.height = staging.height;
    this.canvas.style.width = `${base.width}px`; this.canvas.style.height = `${base.height}px`;
    this.canvas.getContext('2d')!.drawImage(staging, 0, 0);
    this.lastPageIndex = view.page_index;
  }

  showFocus(value?: ClassroomConfirmedFocus): void {
    if (!value) { this.focus.hidden = true; return; }
    if (value.bbox_norm) Object.assign(this.focus.style, normalizedBoxStyle(value.bbox_norm));
    else if (value.spatial_region) {
      const [x, y, boxWidth, boxHeight] = value.spatial_region.bbox_world;
      const baseWidth = Number.parseFloat(this.canvas.style.width) || this.canvas.width || 1;
      const baseHeight = Number.parseFloat(this.canvas.style.height) || this.canvas.height || 1;
      Object.assign(this.focus.style, { left: `${x + baseWidth / 2}px`, top: `${y + baseHeight / 2}px`, width: `${boxWidth}px`, height: `${boxHeight}px` });
    } else { this.focus.hidden = true; return; }
    this.focus.hidden = false;
  }

  async destroy(): Promise<void> {
    this.loadRevision += 1;
    this.renderRevision += 1;
    const current = this.document;
    this.document = undefined;
    this.bytes = undefined;
    this.lastPageIndex = -1;
    if (current) await current.destroy();
  }
}
