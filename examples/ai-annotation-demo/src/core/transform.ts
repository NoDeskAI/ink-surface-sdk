/**
 * Transform 栈 —— 坐标换算只发生在这里（决策 D1 的代码化身）。
 * 页面归一化坐标 [0,1]² ⇄ 页面 CSS 像素。缩放只改变 pageCss，归一化值不变。
 */

export const pageCss = { w: 0, h: 0 };
export interface PageViewportRegion {
  pageId: string;
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

let pageRegions: PageViewportRegion[] = [];

/** 右侧留白（AI 输出落点）布局常量。边注从页面右缘向外溢出，不参与页面居中。 */
export const GUTTER_W = 300;   // 留白总宽（px）
export const GUTTER_PAD = 20;  // 留白内容离页面右缘的左边距（px）

export function setPageSize(w: number, h: number): void {
  pageCss.w = w;
  pageCss.h = h;
}

export function setPageRegions(regions: PageViewportRegion[]): void {
  pageRegions = regions.filter((r) => r.w > 0 && r.h > 0);
}

export function activePageRegions(): PageViewportRegion[] {
  return [...pageRegions];
}

export function pageRegionForId(pageId: string | null | undefined): PageViewportRegion | null {
  if (!pageId) return null;
  return pageRegions.find((r) => r.pageId === pageId) ?? null;
}

export function pageRegionAtPx(px: number, py: number): PageViewportRegion | null {
  const hit = pageRegions.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
  if (hit) return hit;
  return pageRegions[0] ?? null;
}

export const normToPx = (nx: number, ny: number, pageId?: string | null) => {
  const region = pageRegionForId(pageId) ?? pageRegions[0];
  if (region) return { x: region.x + nx * region.w, y: region.y + ny * region.h };
  return { x: nx * pageCss.w, y: ny * pageCss.h };
};
export const pxToNorm = (px: number, py: number, pageId?: string | null) => {
  const region = pageRegionForId(pageId) ?? pageRegionAtPx(px, py);
  if (region) return { x: (px - region.x) / region.w, y: (py - region.y) / region.h };
  return { x: px / pageCss.w, y: py / pageCss.h };
};

export interface SelfTestResult {
  ok: boolean;
  maxErr: number;
  samples: number;
}

export function selfTest(samples = 1000): SelfTestResult {
  if (!pageCss.w || !pageCss.h) return { ok: false, maxErr: NaN, samples: 0 };
  let maxErr = 0;
  for (let i = 0; i < samples; i++) {
    const nx = Math.random();
    const ny = Math.random();
    const p = normToPx(nx, ny);
    const back = pxToNorm(p.x, p.y);
    maxErr = Math.max(maxErr, Math.abs(back.x - nx), Math.abs(back.y - ny));
  }
  return { ok: maxErr < 1e-9, maxErr, samples };
}
