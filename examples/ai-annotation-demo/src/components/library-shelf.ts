import type { LibraryShelfItem } from '../local/store';
import { libraryItemAction, libraryStatusLabel } from '../library/shelf-model';
export { libraryItemAction, libraryStatusLabel } from '../library/shelf-model';
export type { LibraryItemAction, LibraryItemActionKind } from '../library/shelf-model';

export interface ReaderPageInfo {
  current: number;
  total: number;
  estimated: boolean;
}

export type ReaderPageInfoFn = (
  pageIndex: number,
  pageCount: number,
  readerPageIndex: number,
  readerPageCount: number,
) => ReaderPageInfo;

export interface ShelfProgressOptions {
  readerPageInfo?: ReaderPageInfoFn;
}

export interface LibraryBookCardOptions {
  active?: boolean;
  mode?: 'web' | 'paper';
  showMeta?: boolean;
  showStatus?: boolean;
  showAction?: boolean;
  onOpen?: (item: LibraryShelfItem) => void;
  onDelete?: (item: LibraryShelfItem) => void;
  onCoverHydrateNeeded?: (item: LibraryShelfItem) => void;
  progress?: ShelfProgressOptions;
}

export interface LibraryShelfRenderOptions extends LibraryBookCardOptions {
  title?: string;
  caption?: string;
  emptyHint?: string;
  showImport?: boolean;
  onImport?: () => void;
  itemFilter?: (item: LibraryShelfItem) => boolean;
  activeDocumentId?: string | null;
  activeDocumentIds?: ReadonlySet<string>;
}

export function isUserVisibleLibraryItem(item: LibraryShelfItem): boolean {
  const id = String(item.document_id || '').toLowerCase();
  const name = String(item.filename || '').toLowerCase();
  if (/inkloop v1 demo|product e2e|v1 product e2e|last verify|verify|测试文档/.test(name)) return false;
  if (/^doc_v1_/.test(id)) return false;
  if (id.includes('test') || id.includes('e2e')) return false;
  return true;
}

export function shelfKindLabel(item: Pick<LibraryShelfItem, 'filename' | 'mime_type'>): string {
  if (/\.epub$/i.test(item.filename) || item.mime_type === 'application/epub+zip') return 'EPUB';
  if (/\.(md|markdown)$/i.test(item.filename) || item.mime_type === 'text/markdown') return 'MD';
  return 'PDF';
}

export function shelfTitle(filename: string): string {
  const cleaned = String(filename || '').replace(/\.(pdf|epub|md|markdown)$/i, '').trim();
  return cleaned || '未命名';
}

export function coverSigil(title: string, kind: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim();
  const ux = /ux/i.test(normalized) ? 'UX' : '';
  if (ux) return ux;
  const ascii = normalized.match(/[A-Za-z0-9]/g)?.slice(0, 2).join('').toUpperCase();
  if (ascii && ascii.length >= 2) return ascii;
  const cjk = [...normalized.replace(/[^\p{Script=Han}]/gu, '')].slice(0, 2).join('');
  return cjk || kind.slice(0, 2).toUpperCase();
}

export function libraryItemCoverImage(item: LibraryShelfItem): string | undefined {
  return item.doc?.cover_image_data_url ?? item.cover_image_data_url;
}

export function formatShelfDate(iso: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const p = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function defaultReaderPageInfo(
  pageIndex: number,
  pageCount: number,
  readerPageIndex: number,
  readerPageCount: number,
): ReaderPageInfo {
  const sourceTotal = Math.max(1, pageCount || 1);
  const localCount = Math.max(1, readerPageCount || 1);
  const sourceIndex = Math.min(Math.max(0, pageIndex || 0), sourceTotal - 1);
  const localIndex = Math.min(Math.max(0, readerPageIndex || 0), localCount - 1);
  return {
    current: sourceIndex * localCount + localIndex + 1,
    total: sourceTotal * localCount,
    estimated: true,
  };
}

export function shelfProgress(item: LibraryShelfItem, options: ShelfProgressOptions = {}): { percent: number; label: string } {
  const doc = item.doc;
  const saved = doc?.last_read_progress;
  const pageCount = Math.max(1, saved?.page_count ?? doc?.page_count ?? item.page_count ?? 1);
  const hasSavedProgress = !!saved || typeof doc?.last_read_page === 'number';
  if (!hasSavedProgress) return { percent: 0, label: '未读' };
  const pageIndex = Math.min(Math.max(0, saved?.page_index ?? doc?.last_read_page ?? 0), pageCount - 1);
  const readerPageCount = Math.max(1, saved?.reader_page_count ?? 1);
  const readerPageIndex = Math.min(Math.max(0, saved?.reader_page_index ?? 0), readerPageCount - 1);
  const fallbackPercent = (pageIndex + (saved?.view_mode === 'reader' ? (readerPageIndex + 1) / readerPageCount : 1)) / pageCount;
  const percent = Math.min(1, Math.max(0, saved?.percent ?? fallbackPercent));
  const percentText = `${Math.max(1, Math.round(percent * 100))}%`;
  if (saved?.view_mode === 'reader' && readerPageCount > 1) {
    const info = (options.readerPageInfo ?? defaultReaderPageInfo)(pageIndex, pageCount, readerPageIndex, readerPageCount);
    return { percent, label: `${info.current}/${info.total} · ${percentText}` };
  }
  return { percent, label: `${pageIndex + 1}/${pageCount} · ${percentText}` };
}

function addClickableBehavior(node: HTMLElement, run: () => void): void {
  node.addEventListener('click', run);
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    run();
  });
}

function installDeleteReveal(card: HTMLElement, deleteButton: HTMLButtonElement): void {
  let revealTimer: number | undefined;
  let hideTimer: number | undefined;
  let suppressNextCardClick = false;
  const clearRevealTimer = (): void => {
    if (revealTimer !== undefined) window.clearTimeout(revealTimer);
    revealTimer = undefined;
  };
  const reveal = (): void => {
    clearRevealTimer();
    if (hideTimer !== undefined) window.clearTimeout(hideTimer);
    card.classList.add('show-delete');
    hideTimer = window.setTimeout(() => {
      card.classList.remove('show-delete');
      hideTimer = undefined;
    }, 4200);
  };
  const hide = (): void => {
    clearRevealTimer();
    if (hideTimer !== undefined) window.clearTimeout(hideTimer);
    hideTimer = undefined;
    card.classList.remove('show-delete');
  };
  card.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target as HTMLElement | null)?.closest('.book-delete')) return;
    clearRevealTimer();
    revealTimer = window.setTimeout(() => {
      suppressNextCardClick = true;
      reveal();
    }, 520);
  });
  card.addEventListener('pointermove', clearRevealTimer);
  card.addEventListener('pointercancel', clearRevealTimer);
  card.addEventListener('pointerup', clearRevealTimer);
  card.addEventListener('mouseleave', () => {
    clearRevealTimer();
  });
  card.addEventListener('click', (event) => {
    if (!suppressNextCardClick) return;
    suppressNextCardClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  deleteButton.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    reveal();
  });
  deleteButton.addEventListener('focus', reveal);
  deleteButton.addEventListener('blur', () => {
    if (!card.matches(':hover')) hide();
  });
}

export function createLibraryBookCard(item: LibraryShelfItem, options: LibraryBookCardOptions = {}): HTMLElement {
  const kind = shelfKindLabel(item);
  const title = shelfTitle(item.filename);
  const coverImage = libraryItemCoverImage(item);
  const progress = shelfProgress(item, options.progress);
  const action = libraryItemAction(item);
  const busy = !!options.active;
  const card = document.createElement('div');
  card.className = 'bcard library-book-card';
  if (options.mode) card.classList.add(`library-book-card-${options.mode}`);
  if (busy) card.classList.add('busy');
  card.dataset.kind = kind.toLowerCase();
  card.dataset.sync = item.sync_status;
  card.dataset.action = action.kind;
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.title = title;
  card.setAttribute('aria-label', `${title}，${libraryStatusLabel(item)}，${busy ? '处理中' : action.label}`);

  if (options.onDelete) {
    const deleteButton = document.createElement('button');
    deleteButton.className = 'book-delete';
    deleteButton.type = 'button';
    deleteButton.title = `删除 ${title}`;
    deleteButton.setAttribute('aria-label', `删除 ${title}`);
    deleteButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    deleteButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onDelete?.(item);
    });
    installDeleteReveal(card, deleteButton);
    card.appendChild(deleteButton);
  }

  const cover = document.createElement('div');
  cover.className = 'cover';
  if (coverImage) {
    cover.classList.add('cover-image');
    const img = document.createElement('img');
    img.alt = '';
    img.src = coverImage;
    cover.appendChild(img);
  } else {
    const coverKind = document.createElement('div');
    coverKind.className = 'cover-kind';
    coverKind.textContent = kind;
    const coverTitle = document.createElement('div');
    coverTitle.className = 'cover-title';
    coverTitle.textContent = coverSigil(title, kind);
    cover.append(coverKind, coverTitle);
    options.onCoverHydrateNeeded?.(item);
  }

  const name = document.createElement('div');
  name.className = 'book-name';
  name.textContent = title;

  const progressWrap = document.createElement('div');
  progressWrap.className = 'book-progress';
  const progressBar = document.createElement('div');
  progressBar.className = 'book-progress-bar';
  const progressFill = document.createElement('span');
  progressFill.style.width = `${Math.round(progress.percent * 100)}%`;
  progressBar.appendChild(progressFill);
  const progressLabel = document.createElement('div');
  progressLabel.className = 'book-progress-label';
  progressLabel.textContent = progress.label;
  progressWrap.append(progressBar, progressLabel);

  card.append(cover, name, progressWrap);

  if (options.showMeta) {
    const meta = document.createElement('div');
    meta.className = 'book-meta';
    const parts = [kind, item.page_count ? `${item.page_count} 页` : '', formatShelfDate(item.updated_at)].filter(Boolean);
    meta.textContent = parts.join(' · ');
    card.appendChild(meta);
  }

  if (options.showStatus) {
    const status = document.createElement('div');
    status.className = 'book-status';
    status.dataset.sync = item.sync_status;
    status.textContent = libraryStatusLabel(item);
    card.appendChild(status);
  }

  if (options.showAction) {
    const actionEl = document.createElement('div');
    actionEl.className = 'book-action';
    actionEl.textContent = busy ? '处理中...' : action.label;
    card.appendChild(actionEl);
  }

  if (options.onOpen) addClickableBehavior(card, () => options.onOpen?.(item));
  return card;
}

export function createLibraryImportCard(onImport?: () => void, options: { mode?: 'web' | 'paper' } = {}): HTMLElement {
  const card = document.createElement('div');
  card.className = 'bcard imp library-import-card';
  if (options.mode) card.classList.add(`library-import-card-${options.mode}`);
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.setAttribute('aria-label', '导入文件');
  card.innerHTML = '<div class="pl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg></div><div class="il">导入文件</div><div class="is">PDF · EPUB · MD</div>';
  if (onImport) addClickableBehavior(card, onImport);
  return card;
}

export function renderLibraryShelf(container: HTMLElement, items: LibraryShelfItem[], options: LibraryShelfRenderOptions = {}): void {
  const visibleItems = items.filter(options.itemFilter ?? isUserVisibleLibraryItem);
  container.replaceChildren();

  const root = document.createElement('section');
  root.className = `ink-library-shelf ink-library-shelf-${options.mode ?? 'web'}`;

  if (options.title || options.caption) {
    const head = document.createElement('div');
    head.className = 'ink-library-shelf-head';
    if (options.title) {
      const title = document.createElement('h2');
      title.textContent = options.title;
      head.appendChild(title);
    }
    if (options.caption) {
      const caption = document.createElement('p');
      caption.textContent = options.caption;
      head.appendChild(caption);
    }
    root.appendChild(head);
  }

  if (!visibleItems.length && options.emptyHint) {
    const empty = document.createElement('div');
    empty.className = 'ink-library-empty';
    empty.textContent = options.emptyHint;
    root.appendChild(empty);
  }

  const grid = document.createElement('div');
  grid.className = 'shelf-grid ink-library-grid';
  for (const item of visibleItems) {
    grid.appendChild(createLibraryBookCard(item, {
      ...options,
      active: options.activeDocumentIds?.has(item.document_id)
        || (options.activeDocumentId ? item.document_id === options.activeDocumentId : options.active),
    }));
  }
  if (options.showImport !== false) grid.appendChild(createLibraryImportCard(options.onImport, { mode: options.mode }));
  root.appendChild(grid);
  container.appendChild(root);
}
