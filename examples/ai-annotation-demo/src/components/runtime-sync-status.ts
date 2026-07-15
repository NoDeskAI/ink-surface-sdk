export type RuntimeSyncUiState = 'queued' | 'syncing' | 'pulling' | 'synced' | 'failed' | 'dead_letter';

export const RUNTIME_SYNC_RETRY_DEAD_LETTERS_EVENT = 'inkloop:runtime-sync-retry-dead-letters';

export interface RuntimeSyncStatusDetail {
  state: RuntimeSyncUiState;
  at: string;
  reason?: string;
  doc_id?: string;
  device_id?: string;
  pending_event_count?: number;
  dead_letter_count?: number;
  pushed?: number;
  pulled?: number;
  error?: string;
  api_base?: string;
}

const STYLE_ID = 'inkloop-runtime-sync-status-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .runtime-sync-status {
      position: fixed;
      left: 14px;
      bottom: 14px;
      z-index: 70;
      max-width: min(260px, calc(100vw - 28px));
      border: 1px solid rgba(34, 34, 34, 0.18);
      border-radius: 7px;
      background: rgba(255, 255, 251, 0.96);
      color: #222;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.10);
      padding: 6px 8px;
      font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      transition: opacity 160ms ease, transform 160ms ease;
      pointer-events: none;
    }
    .runtime-sync-status-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .runtime-sync-status[data-state="synced"] {
      color: #526052;
      border-color: rgba(64, 94, 64, 0.18);
      box-shadow: none;
    }
    .runtime-sync-status[data-state="synced"] .runtime-sync-status-meta {
      display: none;
    }
    .runtime-sync-status[data-state="failed"] {
      color: #7a1f18;
      border-color: rgba(122, 31, 24, 0.28);
      background: rgba(255, 248, 246, 0.98);
    }
    .runtime-sync-status[data-state="dead_letter"] {
      color: #714c0b;
      border-color: rgba(113, 76, 11, 0.28);
      background: rgba(255, 251, 240, 0.98);
    }
    .runtime-sync-status-title {
      font-weight: 650;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1;
    }
    .runtime-sync-status-meta {
      margin-top: 2px;
      color: currentColor;
      opacity: 0.72;
      white-space: normal;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .runtime-sync-action {
      border: 1px solid currentColor;
      border-radius: 6px;
      background: transparent;
      color: currentColor;
      font: inherit;
      font-weight: 650;
      padding: 3px 7px;
      pointer-events: auto;
      white-space: nowrap;
    }
    .runtime-sync-action[hidden] {
      display: none;
    }
    .runtime-sync-action:disabled {
      opacity: 0.58;
    }
    body.eink-shell .runtime-sync-status {
      left: 8px;
      bottom: 8px;
      max-width: min(220px, calc(100vw - 16px));
      border-radius: 4px;
      box-shadow: none;
      background: #fff;
      color: #111;
    }
  `;
  document.head.appendChild(style);
}

function titleFor(detail: RuntimeSyncStatusDetail): string {
  const pending = detail.pending_event_count ?? 0;
  const deadLetters = detail.dead_letter_count ?? 0;
  // state 优先于计数：无本地积压的 pull 失败也是真失败，不能被双计数吃成"已同步"。
  if (detail.state === 'failed') return '标记同步失败';
  if (detail.state === 'syncing') return pending > 0 ? `标记同步中 ${pending}` : '标记同步中';
  if (detail.state === 'pulling') return '正在检查标记';
  if (pending > 0) return `标记待同步 ${pending}`;
  if (deadLetters > 0) return `有 ${deadLetters} 条历史标记未同步`;
  return '标记已同步';
}

function metaFor(detail: RuntimeSyncStatusDetail): string {
  const parts: string[] = [];
  if (detail.doc_id) parts.push(detail.doc_id);
  if (detail.pushed) parts.push(`推送 ${detail.pushed}`);
  if (detail.pulled) parts.push(`拉取 ${detail.pulled}`);
  if (detail.error) parts.push(detail.error);
  if (detail.api_base) parts.push(`CloudHub ${detail.api_base}`);
  return parts.join(' · ');
}

function safeLocalStorageValue(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function errorReport(detail: RuntimeSyncStatusDetail): string {
  const payload = {
    kind: 'inkloop.runtime_sync_error',
    state: detail.state,
    error: detail.error || '',
    reason: detail.reason || '',
    doc_id: detail.doc_id || '',
    device_id: detail.device_id || '',
    pending_event_count: detail.pending_event_count ?? 0,
    dead_letter_count: detail.dead_letter_count ?? 0,
    pushed: detail.pushed ?? 0,
    pulled: detail.pulled ?? 0,
    api_base: detail.api_base || '',
    api_route: safeLocalStorageValue('inkloop.apiRoute'),
    cloud_hub_port: safeLocalStorageValue('inkloop.cloudHubPort'),
    page_url: location.href,
    origin: location.origin,
    user_agent: navigator.userAgent,
    at: detail.at,
  };
  return JSON.stringify(payload, null, 2);
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Local HTTP on iPad Safari can expose clipboard but reject writes; fall back to execCommand.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('copy command failed');
}

export function initRuntimeSyncStatus(): void {
  if (typeof document === 'undefined') return;
  ensureStyle();
  const node = document.createElement('div');
  node.className = 'runtime-sync-status';
  node.dataset.state = 'synced';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.hidden = true;
  const row = document.createElement('div');
  row.className = 'runtime-sync-status-row';
  const title = document.createElement('div');
  title.className = 'runtime-sync-status-title';
  const copy = document.createElement('button');
  copy.className = 'runtime-sync-action runtime-sync-copy';
  copy.type = 'button';
  copy.textContent = '复制错误';
  copy.hidden = true;
  const retry = document.createElement('button');
  retry.className = 'runtime-sync-action runtime-sync-retry';
  retry.type = 'button';
  retry.textContent = '重试一次';
  retry.hidden = true;
  const meta = document.createElement('div');
  meta.className = 'runtime-sync-status-meta';
  row.append(title, retry, copy);
  node.append(row, meta);
  document.body.appendChild(node);
  let latest: RuntimeSyncStatusDetail | null = null;
  let hideTimer: number | null = null;

  function scheduleHide(detail: RuntimeSyncStatusDetail): void {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    // 只有真 synced 且双计数归零才自动隐藏；failed/dead_letter 挂住等用户处理。
    if (detail.state !== 'synced' || (detail.pending_event_count ?? 0) > 0 || (detail.dead_letter_count ?? 0) > 0) return;
    hideTimer = window.setTimeout(() => {
      node.hidden = true;
      hideTimer = null;
    }, detail.pulled || detail.pushed ? 1800 : 1100);
  }

  copy.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!latest) return;
    const previous = copy.textContent || '复制错误';
    try {
      await copyText(errorReport(latest));
      copy.textContent = '已复制';
      window.setTimeout(() => { copy.textContent = previous; }, 1200);
    } catch (error) {
      copy.textContent = '复制失败';
      console.warn('Failed to copy runtime sync error', error);
      window.setTimeout(() => { copy.textContent = previous; }, 1600);
    }
  });

  retry.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    retry.disabled = true;
    retry.textContent = '重试中';
    document.dispatchEvent(new CustomEvent(RUNTIME_SYNC_RETRY_DEAD_LETTERS_EVENT));
  });

  document.addEventListener('inkloop:runtime-sync-status', (event) => {
    const detail = (event as CustomEvent<RuntimeSyncStatusDetail>).detail;
    if (!detail) return;
    latest = detail;
    node.hidden = false;
    node.dataset.state = detail.state;
    title.textContent = titleFor(detail);
    meta.textContent = metaFor(detail);
    meta.hidden = !meta.textContent;
    copy.hidden = detail.state !== 'failed' && !detail.error;
    retry.disabled = false;
    retry.textContent = '重试一次';
    retry.hidden = (detail.pending_event_count ?? 0) > 0 || (detail.dead_letter_count ?? 0) === 0;
    (window as unknown as { __inkloopRuntimeSyncStatus?: RuntimeSyncStatusDetail }).__inkloopRuntimeSyncStatus = detail;
    scheduleHide(detail);
  });
}
