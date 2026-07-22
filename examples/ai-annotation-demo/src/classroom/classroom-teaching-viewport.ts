import type { ClassroomPageGeometry, ClassroomPageViewport, ClassroomWorldBBox } from 'ink-surface-sdk/runtime-schema';
import { gridSpacing, visibleWorldRect, worldToCssMatrix, zoomViewportAt, panViewport, type ScreenPoint } from './classroom-world-model';

export interface TeachingViewportLayers {
  viewport: HTMLElement;
  world: HTMLElement;
  page: HTMLElement;
  ink: SVGSVGElement;
  focus: HTMLElement;
  selection?: HTMLElement;
  status?: HTMLElement;
}

export class ClassroomTeachingViewport {
  private view: ClassroomPageViewport = { center_x_world: 0, center_y_world: 0, zoom_scale: 1 };
  private geometry?: ClassroomPageGeometry;
  private resizeObserver?: ResizeObserver;

  constructor(readonly layers: TeachingViewportLayers, private readonly onViewChange?: (view: ClassroomPageViewport) => void) {
    layers.viewport.classList.add('teaching-viewport');
    layers.world.classList.add('teaching-world');
    layers.page.classList.add('teaching-page');
    layers.ink.classList.add('teaching-ink');
    layers.focus.classList.add('teaching-focus');
    layers.viewport.tabIndex ||= 0;
    layers.viewport.setAttribute('role', 'application');
    layers.viewport.setAttribute('aria-label', '无限教学画布。画笔书写，空格拖动平移，滚轮缩放。');
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.render());
      this.resizeObserver.observe(layers.viewport);
    }
  }

  setPageGeometry(geometry?: ClassroomPageGeometry): void {
    this.geometry = geometry;
    if (!geometry) {
      this.layers.page.hidden = true;
      this.layers.status && (this.layers.status.textContent = '教材未加载，点阵和板书仍可使用');
      return;
    }
    this.layers.page.hidden = false;
    this.layers.page.style.left = `${-geometry.width_world / 2}px`;
    this.layers.page.style.top = `${-geometry.height_world / 2}px`;
    this.layers.page.style.width = `${geometry.width_world}px`;
    this.layers.page.style.height = `${geometry.height_world}px`;
    this.layers.status && (this.layers.status.textContent = '');
    this.render();
  }

  setView(view: ClassroomPageViewport): void { this.view = { ...view }; this.render(); }
  getView(): ClassroomPageViewport { return { ...this.view }; }
  size(): { width: number; height: number } { return { width: this.layers.viewport.clientWidth, height: this.layers.viewport.clientHeight }; }

  pan(screenDx: number, screenDy: number): ClassroomPageViewport {
    this.view = panViewport(this.view, screenDx, screenDy); this.render(); this.onViewChange?.(this.getView()); return this.getView();
  }

  zoomAt(anchor: ScreenPoint, nextZoom: number): ClassroomPageViewport {
    this.view = zoomViewportAt(this.view, this.size(), anchor, nextZoom); this.render(); this.onViewChange?.(this.getView()); return this.getView();
  }

  visibleRect(overscanScreens = 1): ClassroomWorldBBox { return visibleWorldRect(this.view, this.size(), overscanScreens); }

  showError(message: string): void {
    if (this.layers.status) this.layers.status.textContent = `${message}。点阵和已同步板书仍可使用，可重试教材加载。`;
    this.layers.page.hidden = true;
  }

  render(): void {
    const size = this.size(); if (!(size.width > 0 && size.height > 0)) return;
    this.layers.world.style.transform = worldToCssMatrix(this.view, size);
    const spacing = gridSpacing(this.view.zoom_scale);
    const screenSpacing = spacing.minor * this.view.zoom_scale;
    const originX = size.width / 2 - this.view.center_x_world * this.view.zoom_scale;
    const originY = size.height / 2 - this.view.center_y_world * this.view.zoom_scale;
    this.layers.viewport.style.setProperty('--grid-size', `${screenSpacing}px`);
    this.layers.viewport.style.setProperty('--grid-x', `${originX}px`);
    this.layers.viewport.style.setProperty('--grid-y', `${originY}px`);
    this.layers.viewport.dataset.zoom = `${Math.round(this.view.zoom_scale * 100)}%`;
  }

  destroy(): void { this.resizeObserver?.disconnect(); }
}
