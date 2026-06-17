/**
 * dev 可视化叠层（精度/粒度诊断用）。settings.devOverlay 开关，默认关。
 *
 *  · 在页面上画出 SurfaceIndex 每个对象的 bbox（淡框，按 type 着色）。
 *  · 命中的 target 对象高亮成绿色实框——"我圈了几个字却点亮了整段"这类精度问题一眼可见。
 *  · 标记 region（HMP.target_region）用红虚线框。
 *  · 右上角浮窗实时显示最新 HMP 的全字段。
 *
 * 叠层 pointer-events:none，不挡笔；坐标用 pageCss（与 ink/whisper 同一套），翻页/缩放随 page:rendered 重绘。
 */
import { bus, state, settings } from '../app/state';
import { pageCss } from '../core/transform';
import type { HMP } from '../core/contracts';

let layer: HTMLDivElement | null = null;
let float: HTMLDivElement | null = null;
let lastHmp: HMP | null = null;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
const MODE_COLOR: Record<string, string> = { anchored: '#22c55e', self_content: '#f59e0b', mixed: '#3b82f6', unknown: '#ef4444' };

function ensureEls(): void {
  if (!layer) {
    const stage = document.getElementById('stage');
    if (stage) { layer = document.createElement('div'); layer.id = 'bbox-overlay'; stage.appendChild(layer); }
  }
  if (!float) { float = document.createElement('div'); float.id = 'hmp-float'; document.body.appendChild(float); }
}

const on = (): boolean => !!settings.devOverlay;
const toPx = (b: number[]) => ({ left: b[0] * pageCss.w, top: b[1] * pageCss.h, width: b[2] * pageCss.w, height: b[3] * pageCss.h });

function drawObjects(): void {
  if (!layer) return;
  layer.style.width = pageCss.w + 'px';
  layer.style.height = pageCss.h + 'px';
  const si = state.surfaceIndex;
  if (!on() || !si) { layer.innerHTML = ''; return; }
  const refs = new Set(lastHmp?.target_object_refs ?? []);
  let html = si.objects.map((o) => {
    const p = toPx(o.bbox);
    const hit = refs.has(o.id) ? ' hit' : '';
    return `<div class="bbox-rect t-${esc(o.type)}${hit}" style="left:${p.left}px;top:${p.top}px;width:${p.width}px;height:${p.height}px" title="${esc(o.id)} · ${esc(o.type)}"><span class="bbox-tag">${esc(o.id)}</span></div>`;
  }).join('');
  if (lastHmp) {
    const m = toPx(lastHmp.target_region);
    html += `<div class="bbox-mark" style="left:${m.left}px;top:${m.top}px;width:${m.width}px;height:${m.height}px"></div>`;
  }
  layer.innerHTML = html;
}

function drawFloat(): void {
  if (!float) return;
  if (!on()) { float.style.display = 'none'; return; }
  float.style.display = 'block';
  const h = lastHmp;
  if (!h) { float.innerHTML = '<div class="hf-head">HMP 浮窗</div><div class="hf-empty">圈/划/写一处…</div>'; return; }
  const objs = state.surfaceIndex?.objects ?? [];
  const targets = h.target_object_refs.map((id) => {
    const o = objs.find((x) => x.id === id);
    return o ? `${esc(o.id)}「${esc((o.text || '·' + o.type).slice(0, 18))}」` : `${esc(id)}(缺)`;
  });
  const color = MODE_COLOR[h.mode] ?? '#888';
  float.innerHTML = `<div class="hf-head" style="border-color:${color}">HMP · <b style="color:${color}">${esc(h.mode)}</b> / ${esc(h.action)}</div>`
    + `<div class="hf-row"><span>target</span><b>${targets.length ? targets.join('　') : '<i style="color:#ef4444">空（未命中）</i>'}</b></div>`
    + `<div class="hf-row"><span>object_hint</span><b>${esc(h.object_hint)}</b></div>`
    + `<div class="hf-row"><span>text_hint</span><b>${esc(h.text_hint || '—')}</b></div>`
    + `<div class="hf-row"><span>region</span><b>[${h.target_region.map((n) => n.toFixed(3)).join(', ')}]</b></div>`
    + `<div class="hf-row"><span>confidence</span><b>${h.confidence.toFixed(2)}</b> · v${esc(h.version)}</div>`
    + `<div class="hf-row"><span>refs/证据</span><b>${h.target_object_refs.length}</b> · crop ${h.crop_ref ? '✓' : '✗'} · vec ${h.vector_ref ? '✓' : '✗'}</div>`;
}

function refresh(): void { ensureEls(); drawObjects(); drawFloat(); }

export function initDevOverlay(): void {
  ensureEls();
  bus.on('surface:indexed', () => { lastHmp = null; refresh(); });
  bus.on('hmp:updated', (h) => { lastHmp = h as HMP; refresh(); });
  bus.on('page:rendered', refresh);
  bus.on('settings:changed', refresh);
  refresh();
}
