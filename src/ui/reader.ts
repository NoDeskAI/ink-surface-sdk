import type { ReflowBlock } from '../core/reflow';
import { bus, settings, state } from '../app/state';
import { reflowProviders } from '../providers/reflow';

/**
 * 重排阅读面（settings.viewMode === 'reader' 时显形）。
 * 把当前页文本层重排成干净版心；每块 data-bbox 记着它在原页的归一化坐标，
 * 供后续「在重排视图上标注 → 映射回原页」用（v1 先只渲染）。
 */

let el: HTMLElement;

function render(blocks: ReflowBlock[]): void {
  el.innerHTML = '';
  if (!blocks.length) {
    const empty = document.createElement('p');
    empty.className = 'reader-empty';
    empty.textContent = '这一页没有可重排的文本层（扫描版或空白页）。';
    el.appendChild(empty);
    return;
  }
  const col = document.createElement('article');
  col.className = 'reader-col';
  for (const b of blocks) {
    const node = document.createElement(b.type === 'heading' ? 'h2' : 'p');
    if (b.type === 'heading') node.dataset.level = String(b.level);
    node.className = b.type === 'heading' ? 'reader-h' : 'reader-p';
    node.dataset.bbox = b.source.map((n) => n.toFixed(4)).join(',');
    node.textContent = b.text;
    col.appendChild(node);
  }
  el.appendChild(col);
}

async function rebuild(): Promise<void> {
  if (settings.viewMode !== 'reader') return;
  el.innerHTML = '<p class="reader-empty">正在重排…</p>';
  try {
    const blocks = await reflowProviders[settings.reflowProvider](state.textBlocks);
    if (settings.viewMode === 'reader') render(blocks);
  } catch (e) {
    el.innerHTML = '';
    const err = document.createElement('p');
    err.className = 'reader-empty';
    err.textContent = `重排失败：${(e as Error).message}`;
    el.appendChild(err);
  }
}

export function initReader(readerEl: HTMLElement): void {
  el = readerEl;
  bus.on('view:changed', rebuild);
  bus.on('page:rendered', rebuild);
  bus.on('settings:changed', rebuild); // 切重排引擎即重排（rebuild 自身只在 reader 模式生效）
}
