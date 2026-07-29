import './meeting-postprocess-market.css';

type Template = { id: string; version: string; label: string; prompt: string };
type Fixture = { id: string; title: string; utterances: number; bytes: number };
type SavedPrompt = { id: string; template_id: string; base_version: string; name: string; prompt: string; model: string; created_at: string };
type Bootstrap = { default_model: string; models: string[]; templates: Template[]; fixtures: Fixture[]; saved_prompts: SavedPrompt[] };
type ModelCall = { index: number; duration_ms: number; status: string; error?: string };
type RunResult = {
  template_id: string; template_version: string; model: string; elapsed_ms: number; model_calls: ModelCall[];
  output_kind: 'html' | 'summary_cards'; html?: string; markdown?: string; cards?: Record<string, unknown>;
  input_stats: { utterances: number; handwriting: number };
};
type RunStatus = {
  run_id: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; stage: string; elapsed_ms: number;
  model_calls: Array<ModelCall & { started_at?: string; duration_ms: number | null }>; result?: RunResult; error?: string;
};
const ACTIVE_RUN_KEY = 'inkloop.postprocess-market.active-run';

const rootElement = document.querySelector<HTMLElement>('#postprocess-market');
if (!rootElement) throw new Error('missing #postprocess-market');
const root: HTMLElement = rootElement;

const state: {
  bootstrap: Bootstrap | null;
  templateId: string;
  prompt: string;
  model: string;
  fixtureId: string;
  transcript: string;
  conclusions: string;
  impressions: string;
  painPoints: string;
  mode: 'fixture' | 'paste';
  result: RunResult | null;
  running: boolean;
  runId: string;
  runStage: string;
  runElapsedMs: number;
  runningCalls: RunStatus['model_calls'];
  error: string;
  dirty: boolean;
  activeTab: 'preview' | 'json' | 'trace';
  historyOpen: boolean;
} = {
  bootstrap: null, templateId: '', prompt: '', model: '', fixtureId: '', transcript: '', conclusions: '', impressions: '', painPoints: '', mode: 'fixture',
  result: null, running: false, runId: '', runStage: '', runElapsedMs: 0, runningCalls: [], error: '', dirty: false, activeTab: 'preview', historyOpen: false,
};

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] || char);
}

function formatMs(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${ms} ms`;
}

function selectedTemplate(): Template | undefined {
  return state.bootstrap?.templates.find((item) => item.id === state.templateId);
}

function savedForTemplate(): SavedPrompt[] {
  return (state.bootstrap?.saved_prompts || []).filter((item) => item.template_id === state.templateId);
}

function renderSummaryCards(cards: Record<string, unknown>): string {
  const sections = Array.isArray(cards.template_sections) ? cards.template_sections as Array<Record<string, unknown>> : [];
  const generic: Array<[string, string]> = [['decisions', '结论与决策'], ['action_items', '待办事项'], ['key_points', '讨论脉络'], ['highlights', '关键提取'], ['risks', '深度洞察'], ['open_questions', '待确认事项']];
  const body = sections.length
    ? sections.map((section) => `<section><p class="preview-kicker">${esc(section.id)}</p><h2>${esc(section.title)}</h2>${section.summary ? `<p>${esc(section.summary)}</p>` : ''}<div class="preview-list">${(Array.isArray(section.items) ? section.items : []).map((item) => { const row = item as Record<string, unknown>; return `<article>${row.label ? `<b>${esc(row.label)}</b>` : ''}<p>${esc(row.text)}</p>${row.speaker ? `<small>${esc(row.speaker)}</small>` : ''}</article>`; }).join('')}</div></section>`).join('')
    : generic.map(([key, title]) => {
      const items = Array.isArray(cards[key]) ? cards[key] as Array<Record<string, unknown>> : [];
      if (!items.length) return '';
      return `<section><h2>${title}</h2><div class="preview-list">${items.map((item) => `<article><p>${esc(item.text || item.task)}</p>${item.owner ? `<small>${esc(item.owner)}</small>` : ''}</article>`).join('')}</div></section>`;
    }).join('');
  return `<div class="document-preview"><header><span>INKLOOP / POSTPROCESS</span><h1>${esc(cards.theme || '会议纪要')}</h1><p>${esc(cards.overview || '')}</p></header>${body || '<p class="empty">模型没有返回可展示板块。</p>'}</div>`;
}

function previewHtml(): string {
  if (state.running) return `<div class="preview-state"><span class="spinner"></span><h2>${esc(state.runStage || '正在生成')}</h2><p>已等待 <b>${formatMs(state.runElapsedMs)}</b> · ${esc(state.model)}</p><div class="live-calls">${state.runningCalls.map((call) => `<span class="${call.status}">CALL ${call.index} · ${call.status === 'running' ? '处理中' : call.duration_ms === null ? call.status : formatMs(call.duration_ms)}</span>`).join('')}</div><small>任务已在后台运行，页面短暂刷新后仍可恢复。</small></div>`;
  if (state.error) return `<div class="preview-state error-state"><span>!</span><h2>生成失败</h2><p>${esc(state.error)}</p></div>`;
  if (!state.result) return `<div class="preview-state"><span class="empty-glyph">⌁</span><h2>等待第一次运行</h2><p>选择真实数据，调整提示词与模型，然后点击“运行生成”。</p></div>`;
  if (state.activeTab === 'json') return `<pre class="json-output">${esc(JSON.stringify(state.result, null, 2))}</pre>`;
  if (state.activeTab === 'trace') return `<div class="trace-view"><h2>本次运行链路</h2>${state.result.model_calls.map((call) => `<article><span>CALL ${String(call.index).padStart(2, '0')}</span><b>${formatMs(call.duration_ms)}</b><em class="${call.status}">${esc(call.status)}</em>${call.error ? `<p>${esc(call.error)}</p>` : ''}</article>`).join('')}</div>`;
  return state.result.output_kind === 'html'
    ? `<iframe class="result-frame" title="完整版访谈 HTML 预览" sandbox="" srcdoc="${esc(state.result.html)}"></iframe>`
    : renderSummaryCards(state.result.cards || {});
}

function render(): void {
  if (!state.bootstrap) {
    root.innerHTML = `<div class="boot-state"><span class="spinner"></span><p>正在读取模板与真实测试数据…</p></div>`;
    return;
  }
  const template = selectedTemplate()!;
  const fixtures = state.bootstrap.fixtures;
  const saved = savedForTemplate();
  const result = state.result;
  root.innerHTML = `
    <div class="market-shell">
      <header class="topbar">
        <div class="brand"><span class="brand-mark">I</span><div><strong>InkLoop</strong><small>POSTPROCESS MARKET</small></div></div>
        <div class="top-status"><i></i><span>本地调试环境</span><b>正式数据不受影响</b></div>
        <div class="top-actions">
          <button class="ghost" data-action="history">版本历史 <span>${saved.length}</span></button>
          <button class="save" data-action="save">保存当前提示词</button>
          <button class="run" data-action="run" ${state.running ? 'disabled' : ''}>${state.running ? '生成中…' : '运行生成'} <kbd>⌘↵</kbd></button>
        </div>
      </header>

      <div class="workspace">
        <aside class="config-pane">
          <div class="pane-title"><span>01</span><div><h2>模板与模型</h2><p>配置本次实验变量</p></div></div>
          <label>场景模板<select id="template-select">${state.bootstrap.templates.map((item) => `<option value="${esc(item.id)}" ${item.id === state.templateId ? 'selected' : ''}>${esc(item.label)} · ${esc(item.version)}</option>`).join('')}</select></label>
          <label>推理模型<div class="model-row"><input id="model-input" list="model-options" value="${esc(state.model)}"><datalist id="model-options">${state.bootstrap.models.map((model) => `<option value="${esc(model)}"></option>`).join('')}</datalist><span>API</span></div></label>
          <div class="prompt-heading"><label for="prompt-editor">模板提示词</label><span class="${state.dirty ? 'dirty' : ''}">${state.dirty ? '有未保存修改' : '已同步基线'}</span></div>
          <textarea id="prompt-editor" spellcheck="false">${esc(state.prompt)}</textarea>
          <div class="prompt-meta"><span>${state.prompt.length.toLocaleString()} 字符</span><button data-action="reset">恢复 ${esc(template.version)}</button></div>
        </aside>

        <section class="input-pane">
          <div class="pane-title"><span>02</span><div><h2>会议事实输入</h2><p>仅用于当前调试运行</p></div></div>
          <div class="segmented"><button data-mode="fixture" class="${state.mode === 'fixture' ? 'active' : ''}">真实样本库</button><button data-mode="paste" class="${state.mode === 'paste' ? 'active' : ''}">粘贴转写</button></div>
          ${state.mode === 'fixture' ? `
            <label>测试会议<select id="fixture-select">${fixtures.map((item) => `<option value="${esc(item.id)}" ${item.id === state.fixtureId ? 'selected' : ''}>${esc(item.title)}</option>`).join('')}</select></label>
            <div class="fixture-list">${fixtures.map((item) => `<button data-fixture="${esc(item.id)}" class="${item.id === state.fixtureId ? 'active' : ''}"><span>${esc(item.title)}</span><small>${item.utterances} 条发言 · ${(item.bytes / 1024).toFixed(1)} KB</small></button>`).join('')}</div>
          ` : `<label class="transcript-label">原始转写<textarea id="transcript-input" placeholder="[00:12] 访谈者：你平时如何使用白板？&#10;[00:18] 受访者：我通常会……">${esc(state.transcript)}</textarea></label>`}
          <details class="guidance"><summary>用户补充信息 <span>可选 · 每行一条</span></summary>
            <label>当场结论<textarea data-guidance="conclusions" placeholder="例如：用户更关注减少课后整理时间">${esc(state.conclusions)}</textarea></label>
            <label>最深感受<textarea data-guidance="impressions" placeholder="例如：现有流程切换工具过多">${esc(state.impressions)}</textarea></label>
            <label>关注痛点<textarea data-guidance="painPoints" placeholder="例如：重点关注板书复用与分享">${esc(state.painPoints)}</textarea></label>
          </details>
          <div class="provenance-note"><i>✓</i><p><b>事实来源护栏开启</b><br>调试运行使用本地 fixture 或粘贴文本；不会读取 Google Meet、Zoom、Teams 或飞书自动纪要。</p></div>
        </section>

        <section class="output-pane">
          <div class="output-head">
            <div class="pane-title"><span>03</span><div><h2>生成效果</h2><p>${state.running ? `${esc(state.runStage)} · ${formatMs(state.runElapsedMs)}` : result ? `${esc(result.model)} · ${formatMs(result.elapsed_ms)}` : '等待运行'}</p></div></div>
            <div class="output-tabs"><button data-tab="preview" class="${state.activeTab === 'preview' ? 'active' : ''}">预览</button><button data-tab="json" class="${state.activeTab === 'json' ? 'active' : ''}">原始结果</button><button data-tab="trace" class="${state.activeTab === 'trace' ? 'active' : ''}">调用链路</button></div>
          </div>
          ${result ? `<div class="metrics"><span><small>总耗时</small><b>${formatMs(result.elapsed_ms)}</b></span><span><small>模型调用</small><b>${result.model_calls.length}</b></span><span><small>输入发言</small><b>${result.input_stats.utterances}</b></span><span><small>状态</small><b class="success">SUCCESS</b></span></div>` : ''}
          <div class="preview-surface">${previewHtml()}</div>
        </section>
      </div>
      ${state.historyOpen ? `<div class="drawer-backdrop" data-action="history"><aside class="history-drawer" onclick="event.stopPropagation()"><header><div><small>PROMPT HISTORY</small><h2>${esc(template.label)}版本</h2></div><button data-action="history">×</button></header>${saved.length ? saved.map((item) => `<button class="history-item" data-version="${esc(item.id)}"><b>${esc(item.name)}</b><span>${new Date(item.created_at).toLocaleString('zh-CN', { hour12: false })}</span><small>${esc(item.model)} · ${item.prompt.length} 字符</small></button>`).join('') : '<p class="empty">还没有保存过调试版本。</p>'}</aside></div>` : ''}
    </div>`;
  bind();
}

function bind(): void {
  const templateSelect = root.querySelector<HTMLSelectElement>('#template-select');
  templateSelect?.addEventListener('change', () => {
    const next = state.bootstrap!.templates.find((item) => item.id === templateSelect.value)!;
    state.templateId = next.id; state.prompt = next.prompt; state.dirty = false; state.result = null; state.error = '';
    render();
  });
  root.querySelector<HTMLInputElement>('#model-input')?.addEventListener('input', (event) => { state.model = (event.currentTarget as HTMLInputElement).value; });
  root.querySelector<HTMLTextAreaElement>('#prompt-editor')?.addEventListener('input', (event) => {
    state.prompt = (event.currentTarget as HTMLTextAreaElement).value;
    state.dirty = state.prompt !== selectedTemplate()?.prompt;
    const meta = root.querySelector('.prompt-meta span');
    if (meta) meta.textContent = `${state.prompt.length.toLocaleString()} 字符`;
  });
  root.querySelector<HTMLSelectElement>('#fixture-select')?.addEventListener('change', (event) => { state.fixtureId = (event.currentTarget as HTMLSelectElement).value; render(); });
  root.querySelector<HTMLTextAreaElement>('#transcript-input')?.addEventListener('input', (event) => { state.transcript = (event.currentTarget as HTMLTextAreaElement).value; });
  root.querySelectorAll<HTMLTextAreaElement>('[data-guidance]').forEach((textarea) => textarea.addEventListener('input', () => {
    const field = textarea.dataset.guidance as 'conclusions' | 'impressions' | 'painPoints';
    state[field] = textarea.value;
  }));
  root.querySelectorAll<HTMLElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => { state.mode = button.dataset.mode as 'fixture' | 'paste'; render(); }));
  root.querySelectorAll<HTMLElement>('[data-fixture]').forEach((button) => button.addEventListener('click', () => { state.fixtureId = button.dataset.fixture || ''; render(); }));
  root.querySelectorAll<HTMLElement>('[data-tab]').forEach((button) => button.addEventListener('click', () => { state.activeTab = button.dataset.tab as typeof state.activeTab; render(); }));
  root.querySelectorAll<HTMLElement>('[data-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'run') void run();
    if (action === 'save') void save();
    if (action === 'reset') { state.prompt = selectedTemplate()!.prompt; state.dirty = false; render(); }
    if (action === 'history') { state.historyOpen = !state.historyOpen; render(); }
  }));
  root.querySelectorAll<HTMLElement>('[data-version]').forEach((button) => button.addEventListener('click', () => {
    const saved = savedForTemplate().find((item) => item.id === button.dataset.version);
    if (!saved) return;
    state.prompt = saved.prompt; state.model = saved.model; state.dirty = true; state.historyOpen = false; render();
  }));
}

async function run(): Promise<void> {
  if (!state.prompt.trim() || !state.model.trim()) { state.error = '提示词和模型不能为空。'; render(); return; }
  if (state.mode === 'fixture' && !state.fixtureId) { state.error = '请选择一个测试会议。'; render(); return; }
  if (state.mode === 'paste' && !state.transcript.trim()) { state.error = '请先粘贴原始转写。'; render(); return; }
  state.running = true; state.error = ''; state.result = null; render();
  try {
    const response = await fetch('/api/__debug/meeting-postprocess-market/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: state.templateId, prompt: state.prompt, model: state.model,
        fixture_id: state.mode === 'fixture' ? state.fixtureId : undefined,
        transcript: state.mode === 'paste' ? state.transcript : undefined,
        title: state.bootstrap?.fixtures.find((item) => item.id === state.fixtureId)?.title || '粘贴转写调试',
        conclusions: state.conclusions.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        deepest_impressions: state.impressions.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        pain_points: state.painPoints.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      }),
    });
    const payload = await response.json() as { run_id?: string; error?: string };
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (!payload.run_id) throw new Error('服务端没有返回运行 ID');
    state.runId = payload.run_id;
    state.runStage = '任务已提交';
    localStorage.setItem(ACTIVE_RUN_KEY, state.runId);
    await pollRun(state.runId);
  } catch (error) {
    state.error = String((error as Error)?.message || error);
    state.running = false;
    localStorage.removeItem(ACTIVE_RUN_KEY);
    render();
  }
}

async function pollRun(runId: string): Promise<void> {
  while (state.running && state.runId === runId) {
    try {
      const response = await fetch(`/api/__debug/meeting-postprocess-market/runs/${encodeURIComponent(runId)}`);
      const payload = await response.json() as RunStatus & { error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      state.runStage = payload.stage;
      state.runElapsedMs = payload.elapsed_ms;
      state.runningCalls = payload.model_calls || [];
      if (payload.status === 'succeeded' && payload.result) {
        state.result = payload.result;
        state.activeTab = 'preview';
        state.running = false;
        localStorage.removeItem(ACTIVE_RUN_KEY);
        render();
        return;
      }
      if (payload.status === 'failed') throw new Error(payload.error || '生成失败');
      render();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } catch (error) {
      state.error = String((error as Error)?.message || error);
      state.running = false;
      localStorage.removeItem(ACTIVE_RUN_KEY);
      render();
      return;
    }
  }
}

async function save(): Promise<void> {
  const name = window.prompt('给这个提示词版本起个名字', `${selectedTemplate()?.label} ${new Date().toLocaleDateString('zh-CN')}`);
  if (!name?.trim()) return;
  try {
    const response = await fetch('/api/__debug/meeting-postprocess-market/prompts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: state.templateId, base_version: selectedTemplate()?.version, name: name.trim(), prompt: state.prompt, model: state.model }),
    });
    const payload = await response.json() as { saved?: SavedPrompt; error?: string };
    if (!response.ok || !payload.saved) throw new Error(payload.error || `HTTP ${response.status}`);
    state.bootstrap!.saved_prompts.unshift(payload.saved);
    state.dirty = false; render();
  } catch (error) {
    state.error = String((error as Error)?.message || error); render();
  }
}

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void run(); }
});

async function boot(): Promise<void> {
  render();
  try {
    const response = await fetch('/api/__debug/meeting-postprocess-market/bootstrap');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.bootstrap = await response.json() as Bootstrap;
    const first = state.bootstrap.templates[0];
    state.templateId = first.id; state.prompt = first.prompt; state.model = state.bootstrap.default_model;
    state.fixtureId = state.bootstrap.fixtures[0]?.id || '';
    const activeRun = localStorage.getItem(ACTIVE_RUN_KEY);
    if (activeRun) {
      state.runId = activeRun;
      state.running = true;
      state.runStage = '恢复运行状态';
    }
    render();
    if (activeRun) void pollRun(activeRun);
  } catch (error) {
    root.innerHTML = `<div class="boot-state error-state"><h1>调试台加载失败</h1><p>${esc((error as Error).message)}</p><small>请通过 npm run dev 启动本地服务。</small></div>`;
  }
}

void boot();
