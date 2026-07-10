import type { ScreenOverlay } from '../core/contracts';
import type { PersistedAiTurn, PersistedMark } from '../core/store-format';
import { bus, state } from '../app/state';
import { correctedMarkedTextForPhysicalPenLine } from '../app/mark-text';
import { getBookAiTurns, getFoldedMarks } from '../local/store';

/**
 * 侧栏 = 标记记录历史（只读）。默认隐藏，按钮拉出。
 * 操作权（收下/改写/散去）归旁注低语；这里仅反映状态、提供回看与定位。
 */

const TYPE_LABEL: Record<string, string> = {
  question: '问', note: '思', link: '联', suggestion_card: '提', highlight: '注',
};

let cardsEl: HTMLElement;
let footEl: HTMLElement;
let countEl: HTMLElement;
const recordCardEls = new Map<string, HTMLElement>();
let rebuildTimer: number | null = null;
let rebuildSeq = 0;
let recordStats = { total: 0, markOnly: 0, bound: 0, aiOnly: 0, kept: 0, dismissed: 0 };

export type InsightRecord = {
  id: string;
  kind: 'mark' | 'ai' | 'bound';
  label: string;
  anchorText: string;
  aiText?: string;
  pageId: string;
  pageIndex: number | null;
  createdAt: string;
  state?: string;
  mark?: PersistedMark;
  turn?: PersistedAiTurn;
  overlay?: ScreenOverlay;
  order: number;
};

function setInteractiveCard(item: HTMLElement, onActivate: () => void): void {
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.addEventListener('click', onActivate);
  item.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onActivate();
  });
}

function refreshFoot(): void {
  const { total, markOnly, bound, aiOnly, kept, dismissed } = recordStats;
  countEl.textContent = total ? String(total) : '';
  footEl.textContent = total
    ? `绑定 ${bound} · 标记 ${markOnly}${aiOnly ? ` · AI ${aiOnly}` : ''}${kept ? ` · 收下 ${kept}` : ''}${dismissed ? ` · 散去 ${dismissed}` : ''}`
    : '';
}

function pageIndexFromPageId(pageId: string): number | null {
  const m = pageId.match(/_(\d+)$/);
  return m ? Number(m[1]) : null;
}

function hasImpossiblePageNormBbox(mark: PersistedMark): boolean {
  if (mark.coord_space === 'reader_px' || mark.surface_coord_space === 'reader_px') return false;
  const bbox = mark.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) return true;
  const [x, y, w, h] = bbox.map((value) => Number(value));
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return true;
  return x < -0.05 || y < -0.05 || w > 1.1 || h > 1.1 || x + w > 1.05 || y + h > 1.05;
}

function panelHost(): HTMLElement {
  return cardsEl;
}

function ensureEmptyHint(): void {
  const host = panelHost();
  if (recordCardEls.size) {
    host.querySelector('.empty-hint')?.remove();
    return;
  }
  if (!host.querySelector('.empty-hint')) {
    const p = document.createElement('p');
    p.className = 'empty-hint';
    p.textContent = '标注后，AI 旁注和标记记录会在这里留存回看';
    host.appendChild(p);
  }
}

function markToolLabel(mark: Pick<PersistedMark, 'tool' | 'feature_type'>): { tag: string; label: string } {
  if (mark.tool === 'highlighter') return { tag: '亮', label: '高亮' };
  if (mark.tool === 'underline') return { tag: '线', label: '下划线' };
  const origin = String((mark as Pick<PersistedMark, 'origin'>).origin || '');
  if (origin === 'ai_pen' || origin === 'aipen') return { tag: 'AI', label: 'AI 笔' };
  if (mark.feature_type === 'handwriting') return { tag: '写', label: '手写' };
  return { tag: '笔', label: '笔迹' };
}

function markBodyText(mark: Pick<PersistedMark, 'marked_text' | 'tool' | 'feature_type'>): string {
  const text = mark.marked_text?.trim();
  if (text) return text;
  if (mark.tool === 'highlighter') return '高亮已记录';
  if (mark.tool === 'underline') return '下划线已记录';
  return mark.feature_type === 'markup' ? '圈选标记已记录' : '自由笔迹已记录';
}

function displayMark(mark: PersistedMark): PersistedMark {
  const correctedText = mark.kind_source !== 'runtime-sync' && (mark.page_id === state.pageId || mark.page_index === state.pageIndex)
    ? correctedMarkedTextForPhysicalPenLine(mark, state.textBlocks)
    : '';
  return correctedText ? { ...mark, marked_text: correctedText, scored_type: 'underline' } : mark;
}

function aiText(turn: PersistedAiTurn): string {
  return (turn.user_edited_text || turn.ai_reply || turn.overlay.display_text || '').replace(/\s+/g, ' ').trim();
}

function turnOverlay(turn: PersistedAiTurn): ScreenOverlay {
  return { ...turn.overlay, display_text: aiText(turn) || turn.overlay.display_text, state: turn.overlay_state };
}

function markOrder(mark: PersistedMark): number {
  return mark.seq || Date.parse(mark.created_at) || mark.abs_timestamp || 0;
}

function turnOrder(turn: PersistedAiTurn): number {
  return turn.seq || Date.parse(turn.created_at) || 0;
}

function bboxCenter(bbox: [number, number, number, number]): { x: number; y: number } {
  return { x: bbox[0] + bbox[2] / 2, y: bbox[1] + bbox[3] / 2 };
}

function bboxDistance(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ac = bboxCenter(a);
  const bc = bboxCenter(b);
  return Math.hypot(ac.x - bc.x, ac.y - bc.y);
}

function isAiPenMark(mark: PersistedMark): boolean {
  const origin = String(mark.origin || '');
  return origin === 'ai_pen' || origin === 'aipen' || mark.strokes?.some((stroke) => stroke.tool === 'aipen');
}

function turnAnchorBbox(turn: PersistedAiTurn): [number, number, number, number] {
  return turn.inference_view?.anchor_bbox ?? turn.overlay.geometry.anchor_bbox;
}

function sameTurnPage(mark: PersistedMark, turn: PersistedAiTurn): boolean {
  const turnPageIndex = turn.page_index ?? pageIndexFromPageId(turn.page_id);
  return mark.page_id === turn.page_id && (turnPageIndex === null || mark.page_index === turnPageIndex);
}

function aiPenCandidatesForTurn(turn: PersistedAiTurn, marks: Iterable<PersistedMark>): PersistedMark[] {
  const pageIndex = turn.page_index ?? pageIndexFromPageId(turn.page_id);
  return [...marks].filter((mark) =>
    isAiPenMark(mark)
    && mark.page_id === turn.page_id
    && (pageIndex === null || mark.page_index === pageIndex)
  );
}

function nearestMark(anchorBbox: [number, number, number, number], marks: PersistedMark[]): { mark: PersistedMark; distance: number } | null {
  let best: { mark: PersistedMark; distance: number } | null = null;
  for (const mark of marks) {
    const distance = bboxDistance(anchorBbox, mark.bbox);
    if (!best || distance < best.distance) best = { mark, distance };
  }
  return best;
}

function resolveAnchoredMarksForTurn(
  turn: PersistedAiTurn,
  markById: Map<string, PersistedMark>,
  anchoredMarks: PersistedMark[],
  consumedMarkIds: Set<string>,
): PersistedMark[] {
  const anchorBbox = turnAnchorBbox(turn);
  const candidates = aiPenCandidatesForTurn(turn, markById.values());
  if (!candidates.length) return anchoredMarks;

  const unconsumed = candidates.filter((mark) => !consumedMarkIds.has(mark.mark_id));
  const nearestUnconsumed = nearestMark(anchorBbox, unconsumed);
  if (!anchoredMarks.length) return nearestUnconsumed ? [nearestUnconsumed.mark] : anchoredMarks;

  if (anchoredMarks.length !== 1 || !nearestUnconsumed || nearestUnconsumed.mark.mark_id === anchoredMarks[0].mark_id) {
    return anchoredMarks;
  }

  const anchoredDistance = bboxDistance(anchorBbox, anchoredMarks[0].bbox);
  const anchoredAlreadyUsed = consumedMarkIds.has(anchoredMarks[0].mark_id);
  const nearestIsClearlyBetter = nearestUnconsumed.distance + 0.015 < anchoredDistance * 0.72;
  if (anchoredAlreadyUsed || nearestIsClearlyBetter) return [nearestUnconsumed.mark];

  return anchoredMarks;
}

function scoreTurnForAiPenMark(turn: PersistedAiTurn, mark: PersistedMark): number {
  if (!sameTurnPage(mark, turn)) return Number.NEGATIVE_INFINITY;
  const reply = aiText(turn);
  if (!reply) return Number.NEGATIVE_INFINITY;
  const distance = bboxDistance(turnAnchorBbox(turn), mark.bbox);
  const exact = (turn.anchor?.mark_ids ?? []).includes(mark.mark_id);
  return (exact ? 1000 : 120) - distance * 900 + (turn.seq || 0) / 1_000_000;
}

function ownAiTurnAssignments(records: InsightRecord[], turns: PersistedAiTurn[]): Map<number, PersistedAiTurn> {
  const pairs: Array<{ recordIndex: number; turn: PersistedAiTurn; score: number }> = [];
  records.forEach((record, recordIndex) => {
    if (record.kind !== 'bound' || !record.mark || !isAiPenMark(record.mark)) return;
    for (const turn of turns) {
      const score = scoreTurnForAiPenMark(turn, record.mark);
      if (!Number.isFinite(score)) continue;
      pairs.push({ recordIndex, turn, score });
    }
  });

  pairs.sort((a, b) => b.score - a.score || turnOrder(b.turn) - turnOrder(a.turn));
  const assignedRecords = new Set<number>();
  const assignedTurns = new Set<string>();
  const assignments = new Map<number, PersistedAiTurn>();
  for (const pair of pairs) {
    if (assignedRecords.has(pair.recordIndex) || assignedTurns.has(pair.turn.overlay_id)) continue;
    assignedRecords.add(pair.recordIndex);
    assignedTurns.add(pair.turn.overlay_id);
    assignments.set(pair.recordIndex, pair.turn);
  }
  return assignments;
}

function normalizeAiReplyForDedupe(text: string | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function applyOwnAiReplies(records: InsightRecord[], turns: PersistedAiTurn[]): InsightRecord[] {
  if (!records.some((record) => record.kind === 'bound' && record.mark && isAiPenMark(record.mark))) return records;

  const assignments = ownAiTurnAssignments(records, turns);
  const next = records.map((record, index) => {
    const assignedTurn = assignments.get(index);
    if (!assignedTurn || record.kind !== 'bound' || !record.mark || !isAiPenMark(record.mark)) return record;
    const reply = aiText(assignedTurn);
    return {
      ...record,
      id: `bound:${assignedTurn.overlay_id}:${record.mark.mark_id}`,
      aiText: reply || undefined,
      createdAt: assignedTurn.created_at,
      state: assignedTurn.overlay_state,
      turn: assignedTurn,
      overlay: turnOverlay(assignedTurn),
      order: Math.max(markOrder(record.mark), turnOrder(assignedTurn)),
    };
  });

  const groups = new Map<string, Array<{ index: number; score: number; overlayId: string }>>();
  next.forEach((record, index) => {
    if (record.kind !== 'bound' || !record.mark || !isAiPenMark(record.mark)) return;
    const text = normalizeAiReplyForDedupe(record.aiText);
    if (!text) return;
    const turn = record.turn;
    const score = turn ? scoreTurnForAiPenMark(turn, record.mark) : 0;
    const overlayId = turn?.overlay_id ?? record.overlay?.overlay_id ?? record.id;
    const group = groups.get(text) ?? [];
    group.push({ index, score, overlayId });
    groups.set(text, group);
  });

  for (const group of groups.values()) {
    const distinctTurns = new Set(group.map((entry) => entry.overlayId));
    if (group.length < 2 || distinctTurns.size < 2) continue;
    group.sort((a, b) => b.score - a.score);
    const keep = group[0].index;
    for (const entry of group) {
      if (entry.index === keep) continue;
      next[entry.index] = { ...next[entry.index], aiText: undefined };
    }
  }

  return next;
}

export function buildRecords(marks: PersistedMark[], turns: PersistedAiTurn[]): InsightRecord[] {
  const markById = new Map<string, PersistedMark>();
  for (const mark of marks.filter((m) => !m.is_tombstone && m.document_id === state.documentId && !hasImpossiblePageNormBbox(m)).map(displayMark)) markById.set(mark.mark_id, mark);

  const overlayIdsWithTurn = new Set(turns.map((turn) => turn.overlay_id));
  const visibleTurns = [
    ...turns.filter((turn) => turn.document_id === state.documentId && turn.overlay_state !== 'dismissed'),
    ...state.overlays
      .filter((overlay) => !overlayIdsWithTurn.has(overlay.overlay_id))
      .map((overlay) => ({
        entry_id: overlay.overlay_id,
        document_id: state.documentId ?? '',
        page_id: overlay.page_id,
        page_index: pageIndexFromPageId(overlay.page_id) ?? state.pageIndex,
        seq: Date.parse(overlay.created_at) || 0,
        created_at: overlay.created_at,
        overlay_id: overlay.overlay_id,
        overlay,
        overlay_state: overlay.state,
        user_edited_text: null,
        ai_reply: overlay.display_text,
        anchor: { surface_id: overlay.page_id, mark_ids: [], object_refs: overlay.object_refs ?? [] },
        inference_view: {
          view_id: `fallback_${overlay.overlay_id}`,
          trigger: 'idle',
          narrative: '',
          marked: '',
          page_id: overlay.page_id,
          anchor_bbox: overlay.geometry.anchor_bbox,
          anchor_refs: overlay.object_refs ?? [],
          question: '',
          version: 'fallback',
        },
        prompt_snapshot: '',
        system_prompt_hash: 'fallback',
        settings_snapshot: { inferModel: '', reflowProvider: '' },
        trigger: 'idle',
        model: 'fallback',
        supersedes: null,
      } as PersistedAiTurn)),
  ];

  const consumedMarkIds = new Set<string>();
  const records: InsightRecord[] = [];
  for (const turn of visibleTurns) {
    const rawAnchoredMarks = [...new Set(turn.anchor?.mark_ids ?? [])].map((id) => markById.get(id)).filter((mark): mark is PersistedMark => !!mark);
    const anchoredMarks = resolveAnchoredMarksForTurn(turn, markById, rawAnchoredMarks, consumedMarkIds);
    const reply = aiText(turn);
    if (!anchoredMarks.length) {
      if (!reply) continue;
      const overlay = turnOverlay(turn);
      records.push({
        id: `ai:${turn.overlay_id}`,
        kind: 'ai',
        label: TYPE_LABEL[overlay.overlay_type] ?? 'AI',
        anchorText: reply,
        pageId: turn.page_id,
        pageIndex: turn.page_index ?? pageIndexFromPageId(turn.page_id),
        createdAt: turn.created_at,
        state: turn.overlay_state,
        turn,
        overlay,
        order: turnOrder(turn),
      });
      continue;
    }

    if (!reply) continue;
    for (const mark of anchoredMarks) {
      consumedMarkIds.add(mark.mark_id);
      const { tag, label } = markToolLabel(mark);
      records.push({
        id: `bound:${turn.overlay_id}:${mark.mark_id}`,
        kind: 'bound',
        label: label || tag,
        anchorText: markBodyText(mark),
        aiText: reply || turn.overlay.display_text,
        pageId: mark.page_id || turn.page_id,
        pageIndex: mark.page_index ?? turn.page_index ?? pageIndexFromPageId(mark.page_id),
        createdAt: turn.created_at,
        state: turn.overlay_state,
        mark,
        turn,
        overlay: turnOverlay(turn),
        order: Math.max(markOrder(mark), turnOrder(turn)),
      });
    }
  }

  for (const mark of markById.values()) {
    if (consumedMarkIds.has(mark.mark_id)) continue;
    const { tag } = markToolLabel(mark);
    records.push({
      id: `mark:${mark.mark_id}`,
      kind: 'mark',
      label: tag,
      anchorText: markBodyText(mark),
      pageId: mark.page_id,
      pageIndex: typeof mark.page_index === 'number' ? mark.page_index : pageIndexFromPageId(mark.page_id),
      createdAt: mark.created_at,
      state: 'recorded',
      mark,
      order: markOrder(mark),
    });
  }
  return applyOwnAiReplies(records, visibleTurns)
    .sort((a, b) => b.order - a.order || b.createdAt.localeCompare(a.createdAt));
}

function renderRecord(record: InsightRecord): HTMLElement {
  const item = document.createElement('article');
  item.className = `hist ${record.kind}${record.overlay?.result_type === 'error' ? ' error' : ''}`;
  item.dataset.state = record.state ?? '';

  const top = document.createElement('div');
  top.className = 'hist-top';
  const tag = document.createElement('span');
  tag.className = 'hist-tag';
  tag.textContent = record.label;
  const page = document.createElement('span');
  page.className = 'hist-page';
  page.textContent = `${record.pageIndex === null ? '当前页' : `第 ${record.pageIndex + 1} 页`}`;
  top.append(tag, page);

  const anchor = document.createElement('div');
  anchor.className = 'hist-anchor';
  const anchorLabel = document.createElement('span');
  anchorLabel.className = 'hist-line-label';
  anchorLabel.textContent = record.kind === 'ai' ? 'AI 返回' : '锚定标记';
  const anchorBody = document.createElement('div');
  anchorBody.className = 'hist-body';
  anchorBody.textContent = record.anchorText;
  anchor.append(anchorLabel, anchorBody);

  const children: Node[] = [top, anchor];
  if (record.kind === 'bound' && record.aiText) {
    const ai = document.createElement('div');
    ai.className = 'hist-ai';
    const aiLabel = document.createElement('span');
    aiLabel.className = 'hist-line-label';
    aiLabel.textContent = 'AI 返回';
    const aiBody = document.createElement('div');
    aiBody.className = 'hist-body';
    aiBody.textContent = record.aiText;
    ai.append(aiLabel, aiBody);
    children.push(ai);
  }
  item.replaceChildren(...children);

  if (record.mark) {
    item.addEventListener('mouseenter', () => bus.emit('mark:hover', record.mark!.mark_id));
    if (record.overlay) item.addEventListener('mouseenter', () => bus.emit('whisper:reveal', record.overlay!.overlay_id));
    setInteractiveCard(item, () => bus.emit('mark:focus', {
      markId: record.mark!.mark_id,
      documentId: record.mark!.document_id,
      pageId: record.mark!.page_id,
      pageIndex: record.pageIndex,
      bbox: record.mark!.bbox,
    }));
  } else if (record.overlay) {
    item.addEventListener('mouseenter', () => bus.emit('whisper:reveal', record.overlay!.overlay_id));
    setInteractiveCard(item, () => bus.emit('reader:source-focus', record.overlay));
  }
  return item;
}

async function rebuildRecords(placement: 'first' | 'keep' = 'keep'): Promise<void> {
  const documentId = state.documentId;
  const seq = ++rebuildSeq;
  if (!documentId) {
    clearRecords();
    return;
  }
  const [marks, turns] = await Promise.all([
    getFoldedMarks(documentId).catch(() => [] as PersistedMark[]),
    getBookAiTurns(documentId).catch(() => [] as PersistedAiTurn[]),
  ]);
  if (seq !== rebuildSeq || state.documentId !== documentId) return;
  const records = buildRecords(marks, turns);
  recordStats = {
    total: records.length,
    markOnly: records.filter((record) => record.kind === 'mark').length,
    bound: records.filter((record) => record.kind === 'bound').length,
    aiOnly: records.filter((record) => record.kind === 'ai').length,
    kept: records.filter((record) => record.state === 'accepted' || record.state === 'edited').length,
    dismissed: turns.filter((turn) => turn.document_id === documentId && turn.overlay_state === 'dismissed').length,
  };
  recordCardEls.clear();
  const host = panelHost();
  host.replaceChildren();
  for (const record of records) {
    const item = renderRecord(record);
    recordCardEls.set(record.id, item);
    host.appendChild(item);
  }
  ensureEmptyHint();
  refreshFoot();
  if (placement === 'first') cardsEl.scrollTop = 0;
}

function scheduleRebuild(placement: 'first' | 'keep' = 'keep', delayMs = 40): void {
  if (rebuildTimer !== null) window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    rebuildTimer = null;
    void rebuildRecords(placement);
  }, delayMs);
}

function addMarkRecord(mark: PersistedMark | Omit<PersistedMark, 'entry_id' | 'seq' | 'created_at'>): void {
  const { tag: tagText, label } = markToolLabel(mark);
  void tagText; void label;
  scheduleRebuild('first');
}

function clearRecords(): void {
  recordCardEls.clear();
  recordStats = { total: 0, markOnly: 0, bound: 0, aiOnly: 0, kept: 0, dismissed: 0 };
  panelHost().replaceChildren();
  ensureEmptyHint();
  refreshFoot();
}

function relayoutPanelDeferred(placement: 'first' | 'keep' = 'keep'): void {
  requestAnimationFrame(() => {
    if (placement === 'first') cardsEl.scrollTop = 0;
  });
}

export function initInsightPanel(els: { cards: HTMLElement; foot: HTMLElement; count: HTMLElement }): void {
  cardsEl = els.cards;
  footEl = els.foot;
  countEl = els.count;
  bus.on('document:loaded', () => { clearRecords(); scheduleRebuild('first'); });
  bus.on('marks:restored', () => scheduleRebuild('first'));
  bus.on('mark:recorded', (mark) => addMarkRecord(mark as PersistedMark));
  bus.on('mark:erase', () => scheduleRebuild('keep'));
  bus.on('mark:erased', () => scheduleRebuild('keep'));
  bus.on('page:rendered', () => scheduleRebuild('keep'));
  bus.on('overlay:add', () => scheduleRebuild('first', 140));
  bus.on('overlay:remove', () => scheduleRebuild('keep'));
  bus.on('overlay:state', () => scheduleRebuild('keep', 120));
  bus.on('aiturn:appended', () => scheduleRebuild('first'));
  bus.on('insight:visibility', (open) => { if (open) relayoutPanelDeferred('keep'); });
}
