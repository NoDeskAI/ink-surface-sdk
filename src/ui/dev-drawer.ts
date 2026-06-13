import { selfTest } from '../core/transform';
import { snapshot } from '../core/metrics';
import { downloadTrace } from '../core/trace';
import { bus, state, settings, type Placement } from '../app/state';
import { OCR_PROVIDER_LABELS } from '../providers/ocr';
import { INFER_PROVIDER_LABELS } from '../providers/inference';

/**
 * 开发抽屉 —— 规范要求：Debug 信息只在开发/研究模式出现，普通用户不被打扰。
 * 唤出方式：URL ?dev=1 自动展开；快捷键 d；顶栏 ⋯ 按钮。
 */

let drawer: HTMLElement;
let traceLog: HTMLElement;
let metricsBody: HTMLElement;
let selftestEl: HTMLElement;

function fillSelect(sel: HTMLSelectElement, labels: Record<string, string>, current: string): void {
  sel.innerHTML = '';
  for (const [value, label] of Object.entries(labels)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderMetrics(): void {
  metricsBody.innerHTML = snapshot()
    .map((r) => `<tr><td>${r.label}</td><td>${r.last == null ? '–' : r.last + 'ms'}</td><td>${r.p50 == null ? '–' : r.p50 + 'ms'}</td></tr>`)
    .join('');
}

function runSelfTest(): void {
  const r = selfTest();
  if (!r.samples) {
    selftestEl.textContent = '坐标自测：等待页面渲染';
    selftestEl.dataset.ok = '';
    return;
  }
  selftestEl.textContent = `坐标自测：${r.ok ? '✓' : '✗'} ${r.samples}pts maxErr=${r.maxErr.toExponential(1)} @zoom ${Math.round(state.zoom * 100)}%`;
  selftestEl.dataset.ok = String(r.ok);
}

export function toggleDrawer(force?: boolean): void {
  drawer.hidden = force === undefined ? !drawer.hidden : !force;
}

/** AI 行为设置：各项独立绑定，改动即写回 settings 并广播 settings:changed。 */
function initSettings(): void {
  const $id = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const placement = $id<HTMLSelectElement>('set-placement');
  const reflow = $id<HTMLSelectElement>('set-reflow');
  const gesture = $id<HTMLInputElement>('set-gesture');
  const idle = $id<HTMLInputElement>('set-idle');
  const idleSec = $id<HTMLInputElement>('set-idle-sec');

  // 从 settings 初始化控件
  placement.value = settings.placement;
  reflow.value = settings.reflowProvider;
  gesture.checked = settings.gesture.enabled;
  idle.checked = settings.idle.enabled;
  idleSec.value = String(settings.idle.seconds);

  const changed = () => bus.emit('settings:changed');
  placement.addEventListener('change', () => { settings.placement = placement.value as Placement; changed(); });
  reflow.addEventListener('change', () => { settings.reflowProvider = reflow.value; changed(); });
  gesture.addEventListener('change', () => { settings.gesture.enabled = gesture.checked; changed(); });
  idle.addEventListener('change', () => { settings.idle.enabled = idle.checked; changed(); });
  idleSec.addEventListener('change', () => {
    const n = Math.min(30, Math.max(1, Number(idleSec.value) || settings.idle.seconds));
    settings.idle.seconds = n;
    idleSec.value = String(n);
    changed();
  });
}

export function initDevDrawer(els: {
  drawer: HTMLElement;
  ocrSelect: HTMLSelectElement;
  inferSelect: HTMLSelectElement;
  metricsBody: HTMLElement;
  traceLog: HTMLElement;
  selftest: HTMLElement;
  downloadBtn: HTMLElement;
  closeBtn: HTMLElement;
}): void {
  drawer = els.drawer;
  traceLog = els.traceLog;
  metricsBody = els.metricsBody;
  selftestEl = els.selftest;

  initSettings();
  fillSelect(els.ocrSelect, OCR_PROVIDER_LABELS, state.ocrProvider);
  fillSelect(els.inferSelect, INFER_PROVIDER_LABELS, state.inferProvider);
  els.ocrSelect.addEventListener('change', () => { state.ocrProvider = els.ocrSelect.value; });
  els.inferSelect.addEventListener('change', () => { state.inferProvider = els.inferSelect.value; });
  els.downloadBtn.addEventListener('click', () => downloadTrace());
  els.closeBtn.addEventListener('click', () => toggleDrawer(false));

  bus.on('metrics', renderMetrics);
  bus.on('page:rendered', runSelfTest);
  bus.on('trace', (kind, obj) => {
    const o = obj as { trace_id?: string; event_id?: string };
    const line = document.createElement('div');
    line.textContent = `${String(kind).padEnd(24)}${o.trace_id ?? o.event_id ?? ''}`;
    traceLog.appendChild(line);
    traceLog.scrollTop = traceLog.scrollHeight;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'd' && !(e.target as HTMLElement)?.isContentEditable
      && !['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName ?? '')) {
      toggleDrawer();
    }
  });

  if (new URLSearchParams(location.search).get('dev') === '1') toggleDrawer(true);
  renderMetrics();
  runSelfTest();
}
