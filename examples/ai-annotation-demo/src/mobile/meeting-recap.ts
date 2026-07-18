/**
 * WS2-C「会后记录」—— 会议转写 + 手写档案 +（近似）时间对照。
 * 挂在会议详情(renderDetail)里：关联飞书妙记 → 读转写 + 手写档案 → AI 思路总结。
 *
 * ⚠️「近似对照」非「精确对齐」：t0 用 panel 会议 start_time 近似·mark 时间是落账时刻偏后·
 * 全程用「附近/同时段」语义 + 明示校准状态（未校准/约对齐/已人工校准），绝不当精确。
 */
import { esc } from '../core/escape';
import { confirmSheet, infoSheet, pickOneSheet } from './sheet';
import { getMeeting, mutateMeeting, updateMeeting, getFoldedMarks, getFoldedMarksByContext, getCachedMinute, putCachedMinute } from '../local/store';
import { apiUrl, authFetch, getJson, postJson, postNdjson } from '../core/api';
import { settings } from '../app/state';
import { listRecentPanelMeetings, getMinuteTranscript, getMeetingNoteTranscript, resolveMeetingInstance, bindPanelMinute, getPanelMeetingSummary, generatePanelMeetingSummary, type PanelFeishuMeeting, type PanelMeetingSummaryStatus } from '../integration/panel-feishu/client';
import { parseSrtTranscript, type TranscriptCue } from '../integration/panel-feishu/align';
import type { RecapSegment } from '../integration/panel-feishu/segment';
import { buildEpaperMeetingTimeline, type EpaperMeetingTimeline } from '../integration/lark-meeting-timeline/epaper-timeline';
import { publishEntityToVault } from '../integration/inksurface/vault-publish-device';
import type { PersistedMeeting, PersistedMark, PanelMeetingSummaryRecord, FeishuNoteSummaryRecord } from '../core/store-format';
import { hasMeetingInk, renderMeetingInkPageSvg, type MeetingInkPage } from './meeting-ink-preview';
import { getGoogleMeetingTranscript } from '../integration/google-meet/client';
import { fetchZoomMeetingTranscript, type ZoomTimestampQuality, type ZoomTranscriptParticipant } from '../integration/zoom/client';
import { meetingPlatformOf, meetingTranscriptSource, providerOccurrenceToken, providerTranscriptCacheToken } from './meeting-platform';
import { markTime } from '../core/mark-time';
import { meetingMarkPhase } from './meeting-home-model';
import { isBoardOcrInFlight, triggerBoardOcr } from '../capture/board-ocr';
import { buildMeetingHandwritingSections, hasMeetingHandwritingSections, meetingHandwritingSectionLines } from '../features/meeting/meeting-summary-handwriting';
import { aggregateProviderParticipants, providerParticipantLines } from '../features/meeting/provider-participants';

const SUMMARY_TRANSCRIPT_CAP = 16000; // 喂 AI 的转写字数软上限（长转写分块留 P5）
type ProviderMeetingSummaryResponse = { summary: PanelMeetingSummaryRecord['summary']; model: string };

const ALIGN_LABEL: Record<NonNullable<PersistedMeeting['align_state']>, string> = {
  uncalibrated: '未校准',
  approx: '约对齐',
  estimated: '日程时间估算',
  event: '会议 t0·录音起点未校准',
  manual: '已人工校准',
};

function localStartMs(m: PersistedMeeting): number {
  const s = m.started_at || m.scheduled_at;
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function fmtClock(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDiff(deltaMs: number): string {
  const s = Math.round(deltaMs / 1000);
  const a = Math.abs(s);
  const sign = s >= 0 ? '+' : '-';
  if (a < 90) return `${sign}${a}s`;
  if (a < 5400) return `${sign}${Math.round(a / 60)}min`;
  return `${sign}${(a / 3600).toFixed(1)}h`;
}

/** detail 里「会后记录」卡的 HTML（含关联状态）。 */
export function renderRecapCard(m: PersistedMeeting): string {
  const platform = meetingPlatformOf(m);
  if (platform === 'google_meet') {
    const status = m.provider_transcript_status === 'ready'
      ? '转写已同步'
      : m.provider_transcript_status === 'not_generated'
        ? '未生成转写'
        : m.provider_transcript_status === 'no_record'
          ? '未找到场次'
          : '等待会后转写';
    return `<section class="msec" id="recap-sec"><div class="msec-h"><span class="mt">会后记录</span><span class="mb">${status}</span></div>`
      + `<div class="matcard" id="recap-open"><span class="ic">${SVG_DOC}</span><div><div class="nm">Google Meet 转写</div>`
      + `<div class="mt">点开读取会后转写和手写档案</div></div></div></section>`;
  }
  if (platform === 'zoom') {
    const status = m.provider_transcript_status === 'ready'
      ? '转写已同步'
      : m.provider_transcript_status === 'not_generated'
        ? zoomTerminalTranscriptMessage(m, false)
        : m.provider_transcript_status === 'no_record'
          ? zoomTerminalTranscriptMessage(m, false)
          : '等待会后转写';
    return `<section class="msec" id="recap-sec"><div class="msec-h"><span class="mt">会后记录</span><span class="mb">${status}</span></div>`
      + `<div class="matcard" id="recap-open"><span class="ic">${SVG_DOC}</span><div><div class="nm">Zoom 会后转写</div>`
      + `<div class="mt">点开读取会后转写和手写档案</div></div></div></section>`;
  }
  if (platform !== 'lark') {
    return `<section class="msec" id="recap-sec"><div class="msec-h"><span class="mt">会后记录</span><span class="mb">暂不支持转写拉取</span></div>`
      + `<div class="empty">该来源暂不支持转写拉取。</div></section>`;
  }
  // 放宽：有飞书会议(feishu_meeting_id)即可进 recap 看 panel 总结；妙记(token)绑了再补转写对轴。
  const associated = !!(m.feishu_meeting_id || m.feishu_minute_token);
  if (associated) {
    const hasMinute = !!m.feishu_minute_token;
    const state = hasMinute ? (m.align_state ? ALIGN_LABEL[m.align_state] : '约对齐') : (m.panel_summary ? 'InkLoop 总结已同步' : '飞书会后记录');
    const linked = [m.feishu_topic, m.panel_meeting_start ? fmtClock(m.panel_meeting_start) : ''].filter(Boolean).join(' · ');
    const nm = hasMinute ? '飞书妙记转写' : '飞书会后记录';
    const desc = hasMinute
      ? `已关联${linked ? '：' + esc(linked) : ''} · 点开读转写 + 手写档案`
      : `已关联飞书会议${linked ? '：' + esc(linked) : ''} · 点开读会后文字记录 + 手写档案`;
    return `<section class="msec" id="recap-sec"><div class="msec-h"><span class="mt">会后记录</span><span class="mb">${esc(state)}</span></div>`
      + `<div class="matcard" id="recap-open"><span class="ic">${SVG_DOC}</span><div><div class="nm">${nm}${m.panel_summary_unread ? ' · <b>新总结</b>' : ''}</div>`
      + `<div class="mt">${desc}</div></div></div>`
      + `<div class="dact" style="padding:8px 0 2px"><button class="hbtn" id="recap-reassoc">改关联会议</button></div></section>`;
  }
  return `<section class="msec" id="recap-sec"><div class="msec-h"><span class="mt">会后记录</span><span class="mb">需关联飞书会议</span></div>`
    + `<div class="empty">把这场会议关联到对应的飞书会议，会后就能读飞书纪要和 InkLoop 总结；妙记绑定后会补齐转写。</div>`
    + `<div class="dact" style="padding:8px 0 2px"><button class="hbtn pri" id="recap-assoc">关联飞书会议</button></div></section>`;
}

const SVG_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z"/><path d="M9 13h6M9 17h6"/></svg>';

/** 关联飞书会议：拉最近会议 → 按时间近推荐 → 单选确认 → 存 token + 三时间字段。 */
async function associate(m: PersistedMeeting): Promise<boolean> {
  const authProblem = await checkFeishuOAuthProblem();
  if (authProblem) {
    await promptFeishuRelogin(authProblem);
    return false;
  }
  let meetings: PanelFeishuMeeting[];
  try {
    meetings = await listRecentPanelMeetings(20);
  } catch (e) {
    const message = String((e as Error)?.message || e);
    if (isOAuthRecoveryError(message)) {
      await promptFeishuRelogin(message);
      return false;
    }
    await infoSheet({ title: '拉取失败', message: `连不上飞书会议源：${message}` });
    return false;
  }
  if (!meetings.length) {
    await infoSheet({ title: '没有可关联的会议', message: '飞书中枢还没有会议事件记录。请确认机器人在会议群里、且会议已结束并生成了妙记。' });
    return false;
  }
  const ls = localStartMs(m);
  const sorted = [...meetings].sort((a, b) => Math.abs((a.start_time ?? 0) - ls) - Math.abs((b.start_time ?? 0) - ls));
  // 时间差大（>30min）→ 不默认选中、标风险（防用户盲点确认关到错会议·codex #1）
  const FAR_MS = 30 * 60 * 1000;
  const items = sorted.map((mt, i) => {
    const dms = mt.start_time && ls ? mt.start_time - ls : null;
    const far = dms != null && Math.abs(dms) > FAR_MS;
    const diff = dms != null ? `相差${fmtDiff(dms)}${far ? '⚠时间差大' : ''}` : '时间未知';
    const dur = mt.start_time && mt.end_time ? `${Math.max(1, Math.round((mt.end_time - mt.start_time) / 60000))}分钟` : '';
    const conf = mt.match?.confidence;
    const tok = mt.minute_token ? (conf === 'exact' ? '妙记·已确认' : conf === 'heuristic' ? '妙记·推测' : '有转写') : '飞书会议记录';
    const no = mt.meeting_no ? `会议号${mt.meeting_no}` : '';
    const tag = i === 0 && !far ? '推荐 · ' : '';
    return { id: mt.meeting_id, label: `${tag}${mt.topic || '(无主题会议)'}`, sub: [fmtClock(mt.start_time), dur, diff, no, tok].filter(Boolean).join(' · ') };
  });
  // 最近一场就时间差很大 → 不预选(defaultId 给个不存在的)·逼用户主动选
  const nearestFar = sorted[0]?.start_time != null && ls > 0 && Math.abs((sorted[0].start_time ?? 0) - ls) > FAR_MS;
  const picked = await pickOneSheet({ title: '关联飞书会议（本地会议：' + (m.title || '') + '）', items, defaultId: nearestFar ? '__none__' : items[0].id, confirm: '确认关联' });
  if (!picked) return false;
  const mt = sorted.find((x) => x.meeting_id === picked);
  if (!mt) return false;
  if (!mt.minute_token && !mt.meeting_id) {
    await infoSheet({ title: '这场会议还没有可读记录', message: '所选会议缺少飞书会议 ID 和妙记 token，暂时不能拉取会后记录。' });
    return false;
  }
  // offset 推断留到读转写时（需 cues）；此处先存 offset=0。
  // mt.start_time = vc all_meeting_started 的会议开始时刻（真 t0）·非录音开始（录音可能晚几秒~分钟·残差由 recap 文案诚实标出）
  await updateMeeting(m.meeting_id, {
    // 短号冒充 meeting_id 时不写（否则周期会实例共享同一短号会互相错配手记）。
    ...(mt.meeting_id && mt.meeting_id !== mt.meeting_no ? { feishu_meeting_id: mt.meeting_id } : {}),
    feishu_meeting_no: mt.meeting_no,
    feishu_topic: mt.topic,
    ...(mt.minute_token ? { feishu_minute_token: mt.minute_token } : {}),
    feishu_minute_url: mt.minute_url ?? undefined,
    panel_meeting_start: mt.start_time,         // 保留 raw panel 值供核对/兜底
    vc_meeting_start_t0: mt.start_time,         // 会议开始真 t0（替掉旧的「假录音 t0」）
    t0_source: 'vc_event',
    align_offset_ms: 0,
    align_state: 'event',
    feishu_match_confirmed_at: new Date().toISOString(),
  });
  // 端侧确认即权威：回写 panel 显式绑定，覆盖它的 topic/时间窗推测（fire-and-forget·失败不阻断本地关联）
  if (mt.minute_token) void bindPanelMinute(mt.meeting_id, mt.minute_token);
  return true;
}

/** 绑定「会后记录」卡的按钮。rerender = 重渲染 detail；openRecap = 进 recap 阅读视图。 */
export function wireRecapCard(root: HTMLElement, meetingId: string, rerender: () => void, openRecap: () => void): void {
  const onAssoc = async (): Promise<void> => {
    const m = await getMeeting(meetingId);
    if (!m) return;
    if (await associate(m)) rerender();
  };
  root.querySelector('#recap-assoc')?.addEventListener('click', () => void onAssoc());
  root.querySelector('#recap-reassoc')?.addEventListener('click', () => void onAssoc());
  root.querySelector('#recap-open')?.addEventListener('click', () => openRecap());
}

// ════ V2 recap：分段对轴时间线（概览段级 ⇄ 详情句级 · 翻页 · 近似对照）════

const TX_PAGE = 36;            // 文字记录每页句数（端侧避免一次性渲太长导致电纸屏卡顿）
const FEISHU_AUTH_CHECK_TIMEOUT_MS = 5000;
const RECAP_LOCAL_TIMEOUT_MS = 5000;
const RECAP_REMOTE_BLOCK_TIMEOUT_MS = 65_000;
const SUMMARY_STREAM_TIMEOUT_MS = 120_000;

type RecapBlockStatus = 'loading' | 'ready' | 'missing' | 'failed' | 'auth_required';
interface RecapBlockLoadState {
  status: RecapBlockStatus;
  message: string;
  cached?: boolean;
}

interface FeishuMeStatus {
  connected?: boolean;
  configured?: boolean;
  oauth?: {
    authenticated?: boolean;
    connected?: boolean;
    configured?: boolean;
    reason?: string;
    missing_scopes?: string[];
    refresh_token_present?: boolean;
  };
}

/** overview=会后概览(默认主体) · detail=手写段详情(overview 下钻) · transcript=原始发言详情页 · feishu=飞书官方智能纪要 · summary=思路总结整页 · panel=InkLoop总结整页——
 *  左侧 #recap-nav 入口彼此平级（点入口直切·非抽屉）。 */
interface RecapV2 {
  meeting: PersistedMeeting;
  segments: RecapSegment[];
  cues: TranscriptCue[];
  view: 'overview' | 'detail' | 'transcript' | 'feishu' | 'summary' | 'panel';
  detailIdx: number;            // detail 视图当前段下标
  ovPage: number;               // 概览翻页
  dtPage: number;               // 详情翻页
  txPage: number;               // 原始文字记录翻页
  bodyEl: HTMLElement;          // 供 recapHandleBack / 各页重渲复用
  transcriptMissing: boolean;   // 转写为空/未就绪但仍展示手写档案（提示用·防误以为没内容）
  feishuSummary: FeishuNoteSummaryRecord | null; // 飞书官方智能纪要，和转写/InkLoop 总结分开展示。
  panelSummary: PanelMeetingSummaryRecord | null; // L5：panel 五要素总结（独立整页·和时间脊互补）
  panelSummaryStatus: string;   // loading / ready / not_generated / generating / failed（missing_minute 仅兼容旧缓存）
  timeline: EpaperMeetingTimeline;
  marksById: Map<string, PersistedMark>; // 详情页需要完整 strokes；时间线只保留轻量 SegmentMark。
  markSourceMeeting: PersistedMeeting | null; // 手写可能来自同系列会议的本地手记，用于恢复未重新关联的笔迹。
  transcriptLoad: RecapBlockLoadState;
  noteLoad: RecapBlockLoadState;
  marksLoad: RecapBlockLoadState;
  panelSummaryError?: string;
  providerTimestampQuality?: ZoomTimestampQuality;
}
let recapState: RecapV2 | null = null;
const providerPanelSummaryInFlight = new Map<string, Promise<PanelMeetingSummaryRecord | null>>();
// 防异步串会：打开 A 后快速返回/打开 B，A 的晚到结果（转写/AI 摘要）不能覆盖 B 的视图/状态。
let recapLoadSeq = 0;
export function resetRecapView(): void { recapLoadSeq++; recapState = null; delete document.body.dataset.recapView; updateExportButton(); updateRecapNav(); }
function recapAlive(seq: number, bodyEl: HTMLElement): boolean {
  // 含 data-mode：底部导航离开会议页后，晚到的异步 digest 不再更新隐藏 state/缓存（codex A#5）。
  return seq === recapLoadSeq && document.body.dataset.mode === 'meet' && document.body.dataset.mtg === 'recap' && document.body.contains(bodyEl);
}

/** 顶栏「返回」：recap 子页先退回概览（返回 true）；已在概览则交调用方退出 recap（返回 false）。 */
export function recapHandleBack(): boolean {
  if (recapState && recapState.view !== 'overview') {
    recapState.view = 'overview';
    renderRecap(recapState.bodyEl);
    recapState.bodyEl.scrollTop = 0;
    updateRecapNav();
    return true;
  }
  return false;
}

type LoadedTranscript = { srt: string; cues: TranscriptCue[]; sourceToken: string; timestampQuality?: ZoomTimestampQuality };

function transcriptSourceKey(m: PersistedMeeting): string {
  const platform = meetingPlatformOf(m);
  switch (platform) {
    case 'lark':
      return m.feishu_minute_token || (m.feishu_meeting_id ? providerTranscriptCacheToken('lark', m.feishu_meeting_id) : '');
    case 'google_meet':
    case 'microsoft_teams':
      return providerTranscriptCacheToken(platform, m.meeting_id);
    case 'zoom':
      return providerTranscriptCacheToken(platform, m.meeting_id, providerOccurrenceToken(m.scheduled_at));
    case 'manual':
      return '';
  }
}

export function meetingSummaryTranscriptCacheToken(meeting: Pick<PersistedMeeting, 'summary_source'>): string {
  return meeting.summary_source?.transcript_cache_token ?? meeting.summary_source?.feishu_minute_token ?? '';
}

function feishuEpochMs(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

async function loadMinuteTranscript(m: PersistedMeeting, token: string): Promise<LoadedTranscript> {
  const cached = await getCachedMinute(token);
  try {
    const srt = await getMinuteTranscript(token, 'srt');
    if (srt.trim()) {
      await putCachedMinute({ minute_token: token, meeting_id: m.meeting_id, srt, fetched_at: new Date().toISOString() });
      return { srt, cues: parseSrtTranscript(srt), sourceToken: token };
    }
  } catch (e) {
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: token }; // 离线回退缓存
    throw e;
  }
  // 在线拉到空 → 回退缓存（妙记还在生成时别覆盖已有缓存）
  if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: token };
  return { srt: '', cues: [], sourceToken: token };
}

async function loadNoteTranscript(m: PersistedMeeting): Promise<LoadedTranscript | null> {
  const meetingId = m.feishu_meeting_id;
  if (!meetingId) return null;
  const cacheToken = providerTranscriptCacheToken('lark', meetingId);
  const cached = await getCachedMinute(cacheToken);
  try {
    const result = await getMeetingNoteTranscript(meetingId);
    const startMs = feishuEpochMs(result.meeting?.start_time);
    const endMs = feishuEpochMs(result.meeting?.end_time);
    const patch: Partial<PersistedMeeting> = {};
    if (result.meeting?.topic && result.meeting.topic !== m.feishu_topic) patch.feishu_topic = result.meeting.topic;
    if (result.meeting?.meeting_no && result.meeting.meeting_no !== m.feishu_meeting_no) patch.feishu_meeting_no = result.meeting.meeting_no;
    if (result.summary?.content) {
      patch.feishu_note_summary = result.summary;
      patch.feishu_note_summary_status = 'ready';
    } else if (result.status === 'ready' || result.status === 'missing_note' || result.status === 'missing_transcript') {
      patch.feishu_note_summary_status = 'missing';
    }
    if (startMs > 0 && startMs !== m.vc_meeting_start_t0) {
      patch.vc_meeting_start_t0 = startMs;
      patch.t0_source = m.t0_source === 'recording_event' ? m.t0_source : 'vc_event';
      patch.align_state = m.align_state === 'manual' ? m.align_state : 'event';
    }
    if (endMs > 0 && (!m.ended_at || Date.parse(m.ended_at) !== endMs)) patch.ended_at = new Date(endMs).toISOString();
    if (Object.keys(patch).length) {
      await updateMeeting(m.meeting_id, patch);
      Object.assign(m, patch);
    }
    if (result.status === 'ready' && result.transcript?.srt.trim()) {
      const srt = result.transcript.srt;
      await putCachedMinute({
        minute_token: cacheToken,
        meeting_id: m.meeting_id,
        srt,
        title: result.transcript.title || result.meeting?.topic,
        duration_ms: startMs > 0 && endMs > startMs ? endMs - startMs : undefined,
        parser_version: result.transcript.parser_version,
        source_raw_content: result.transcript.raw_content,
        source_segments: result.transcript.segments,
        fetched_at: result.transcript.fetched_at || new Date().toISOString(),
      });
      return { srt, cues: parseSrtTranscript(srt), sourceToken: cacheToken };
    }
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: cacheToken };
    if (result.status === 'ready' || result.status === 'missing_note' || result.status === 'missing_transcript') {
      return { srt: '', cues: [], sourceToken: cacheToken };
    }
    const first = result.errors?.[0];
    throw new Error(first?.message || result.status);
  } catch (e) {
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: cacheToken };
    throw e;
  }
}

export async function loadGoogleTranscript(m: PersistedMeeting): Promise<LoadedTranscript | null> {
  if (meetingTranscriptSource(m) !== 'google_meet_transcript' || !m.calendar_meeting_no || !m.scheduled_at) return null;
  const cacheToken = providerTranscriptCacheToken('google_meet', m.meeting_id);
  const cached = await getCachedMinute(cacheToken);
  try {
    const result = await getGoogleMeetingTranscript({ meetingCode: m.calendar_meeting_no, scheduledAt: m.scheduled_at });
    const patch: Partial<PersistedMeeting> = {};
    if (m.provider_transcript_status !== result.status) patch.provider_transcript_status = result.status;
    if (result.record?.name && result.record.name !== m.provider_meeting_id) patch.provider_meeting_id = result.record.name;
    if (result.transcript?.name && result.transcript.name !== m.provider_transcript_ref) patch.provider_transcript_ref = result.transcript.name;
    const fetchedAt = new Date().toISOString();
    const smartNoteText = result.smart_note?.text?.trim();
    if (smartNoteText) {
      patch.google_smart_note = {
        text: smartNoteText,
        ...(result.smart_note?.export_uri ? { export_uri: result.smart_note.export_uri } : {}),
        fetched_at: fetchedAt,
      };
    }
    const scopeMissing = result.smart_note?.scope_missing === true;
    if (!!m.google_smart_note_scope_missing !== scopeMissing) patch.google_smart_note_scope_missing = scopeMissing;
    if (result.recordings?.length) {
      const recordings = result.recordings.filter((recording) => recording.export_uri?.trim()).map((recording) => ({
        export_uri: recording.export_uri.trim(),
        state: recording.state || 'STATE_UNSPECIFIED',
      }));
      if (recordings.length) patch.google_recordings = recordings;
    }
    const startMs = feishuEpochMs(result.record?.start_time);
    const endMs = feishuEpochMs(result.record?.end_time);
    if (startMs > 0) {
      if (m.vc_meeting_start_t0 !== startMs) patch.vc_meeting_start_t0 = startMs;
      if (m.t0_source !== 'provider_event') patch.t0_source = 'provider_event';
      if (m.align_state !== 'event') patch.align_state = 'event';
      if (!m.started_at || Date.parse(m.started_at) !== startMs) patch.started_at = new Date(startMs).toISOString();
    }
    if (endMs > 0 && (!m.ended_at || Date.parse(m.ended_at) !== endMs)) patch.ended_at = new Date(endMs).toISOString();
    if (Object.keys(patch).length) {
      await updateMeeting(m.meeting_id, patch);
      Object.assign(m, patch);
    }
    if (result.status === 'ready' && result.transcript?.srt.trim()) {
      const srt = result.transcript.srt;
      await putCachedMinute({
        minute_token: cacheToken,
        meeting_id: m.meeting_id,
        srt,
        duration_ms: startMs > 0 && endMs > startMs ? endMs - startMs : undefined,
        fetched_at: new Date().toISOString(),
      });
      return { srt, cues: parseSrtTranscript(srt), sourceToken: cacheToken };
    }
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: cacheToken };
    return { srt: '', cues: [], sourceToken: cacheToken };
  } catch (error) {
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: cacheToken };
    throw error;
  }
}

function sameZoomOccurrence(left: Pick<PersistedMeeting, 'scheduled_at'>, rightToken: string): boolean {
  return providerOccurrenceToken(left.scheduled_at) === rightToken;
}

function persistedZoomParticipants(participants: ZoomTranscriptParticipant[]): NonNullable<PersistedMeeting['provider_participants']> {
  return participants.flatMap((participant) => {
    const name = participant.display_name?.trim();
    const joinedAt = participant.join_time?.trim();
    const leftAt = participant.leave_time?.trim();
    const joinedMs = Date.parse(joinedAt || '');
    const leftMs = Date.parse(leftAt || '');
    if (!name || !joinedAt || !leftAt || !Number.isFinite(joinedMs) || !Number.isFinite(leftMs) || leftMs < joinedMs) return [];
    return [{ name, joined_at: joinedAt, left_at: leftAt, identity: participant.identity_quality }];
  }).sort((left, right) => Date.parse(left.joined_at) - Date.parse(right.joined_at)
    || left.name.localeCompare(right.name, 'zh-CN')
    || left.identity.localeCompare(right.identity));
}

/** Zoom 会后转写：本机缓存先行兜底，在线结果只按实际场次字段做条件写回。 */
export async function loadZoomTranscript(m: PersistedMeeting): Promise<LoadedTranscript | null> {
  if (meetingTranscriptSource(m) !== 'zoom_transcript' || !m.provider_space_name || !m.scheduled_at) return null;
  const occurrenceToken = providerOccurrenceToken(m.scheduled_at);
  const cacheToken = providerTranscriptCacheToken('zoom', m.meeting_id, occurrenceToken);
  const cached = await getCachedMinute(cacheToken);
  try {
    const result = await fetchZoomMeetingTranscript(m.provider_space_name, m.scheduled_at);
    const t0Ms = feishuEpochMs(result.t0 || result.record?.start_time);
    const startMs = feishuEpochMs(result.started_at || result.record?.start_time);
    const endMs = feishuEpochMs(result.ended_at || result.record?.end_time);
    let occurrenceCurrent = false;
    let appliedPatch: Partial<PersistedMeeting> = {};
    const saved = await mutateMeeting(m.meeting_id, (current) => {
      if (!sameZoomOccurrence(current, occurrenceToken)) return null;
      occurrenceCurrent = true;
      const patch: Partial<PersistedMeeting> = {};
      if (current.provider_transcript_status !== result.status) patch.provider_transcript_status = result.status;
      if (current.provider_transcript_reason !== result.reason) patch.provider_transcript_reason = result.reason;
      const participants = persistedZoomParticipants(result.participants || []);
      if (participants.length && JSON.stringify(participants) !== JSON.stringify(current.provider_participants || [])) {
        patch.provider_participants = participants;
      }

      const instanceChanged = !!result.instance_uuid && result.instance_uuid !== current.provider_meeting_id;
      const protectAnchor = current.align_state === 'manual'
        || current.t0_source === 'recording_event'
        || (current.t0_source === 'provider_event' && result.instance_uuid === current.provider_meeting_id);
      if (instanceChanged) {
        patch.provider_meeting_id = result.instance_uuid;
        patch.provider_transcript_ref = result.transcript?.name || undefined;
        if (!protectAnchor) {
          patch.vc_meeting_start_t0 = t0Ms > 0 ? t0Ms : undefined;
          patch.started_at = startMs > 0 ? new Date(startMs).toISOString() : undefined;
          patch.ended_at = endMs > 0 ? new Date(endMs).toISOString() : undefined;
          patch.t0_source = t0Ms > 0 ? 'provider_event' : undefined;
          patch.align_state = t0Ms > 0 ? 'event' : undefined;
        }
      } else {
        if (result.transcript?.name && result.transcript.name !== current.provider_transcript_ref) patch.provider_transcript_ref = result.transcript.name;
        if (t0Ms > 0 && (!protectAnchor || !current.vc_meeting_start_t0)) {
          if (current.vc_meeting_start_t0 !== t0Ms) patch.vc_meeting_start_t0 = t0Ms;
          if (!protectAnchor && current.t0_source !== 'provider_event') patch.t0_source = 'provider_event';
          if (!protectAnchor && current.align_state !== 'event') patch.align_state = 'event';
        }
        if (startMs > 0 && (!protectAnchor || !current.started_at) && Date.parse(current.started_at || '') !== startMs) {
          patch.started_at = new Date(startMs).toISOString();
        }
        if (endMs > 0 && (!protectAnchor || !current.ended_at) && Date.parse(current.ended_at || '') !== endMs) {
          patch.ended_at = new Date(endMs).toISOString();
        }
      }
      appliedPatch = patch;
      return Object.keys(patch).length ? patch : null;
    });
    if (!occurrenceCurrent) return null;
    Object.assign(m, saved ?? appliedPatch);

    const timestampQuality = result.timestamp_quality || result.transcript?.timestamp_quality;
    const readySrt = result.transcript?.srt?.trim() || result.srt?.trim() || '';
    if (result.status === 'ready' && readySrt) {
      await putCachedMinute({
        minute_token: cacheToken,
        meeting_id: m.meeting_id,
        srt: readySrt,
        ...(startMs > 0 && endMs > startMs ? { duration_ms: endMs - startMs } : {}),
        fetched_at: new Date().toISOString(),
      });
      return {
        srt: readySrt,
        cues: parseSrtTranscript(readySrt),
        sourceToken: cacheToken,
        ...(timestampQuality ? { timestampQuality } : {}),
      };
    }
    if (cached?.srt) {
      return {
        srt: cached.srt,
        cues: parseSrtTranscript(cached.srt),
        sourceToken: cacheToken,
        ...(timestampQuality ? { timestampQuality } : {}),
      };
    }
    return {
      srt: '',
      cues: [],
      sourceToken: cacheToken,
      ...(timestampQuality ? { timestampQuality } : {}),
    };
  } catch (error) {
    const current = await getMeeting(m.meeting_id);
    if (!current || !sameZoomOccurrence(current, occurrenceToken)) return null;
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: cacheToken };
    throw error;
  }
}

async function loadCachedTranscript(m: PersistedMeeting): Promise<LoadedTranscript | null> {
  const platform = meetingPlatformOf(m);
  switch (platform) {
    case 'google_meet':
    case 'microsoft_teams': {
      const token = providerTranscriptCacheToken(platform, m.meeting_id);
      const cached = await getCachedMinute(token);
      return cached?.srt ? { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: token } : null;
    }
    case 'zoom': {
      const token = providerTranscriptCacheToken(platform, m.meeting_id, providerOccurrenceToken(m.scheduled_at));
      const cached = await getCachedMinute(token);
      return cached?.srt ? { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: token } : null;
    }
    case 'lark':
      if (m.feishu_minute_token) {
        const cached = await getCachedMinute(m.feishu_minute_token);
        if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: m.feishu_minute_token };
      }
      if (m.feishu_meeting_id) {
        const token = providerTranscriptCacheToken('lark', m.feishu_meeting_id);
        const cached = await getCachedMinute(token);
        if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: token };
      }
      return null;
    case 'manual':
      return null;
  }
}

/** 拉转写：**在线先拉最新**（妙记/飞书 note 可能后续补全/修订）→ 写缓存；离线/失败回退缓存。 */
async function loadTranscript(m: PersistedMeeting): Promise<LoadedTranscript | null> {
  const platform = meetingPlatformOf(m);
  switch (platform) {
    case 'google_meet':
      return loadGoogleTranscript(m);
    case 'zoom':
      return loadZoomTranscript(m);
    case 'lark': {
      let minuteError: unknown = null;
      if (m.feishu_minute_token) {
        try {
          const loaded = await loadMinuteTranscript(m, m.feishu_minute_token);
          if (loaded.cues.length || !m.feishu_meeting_id) return loaded;
        } catch (e) {
          minuteError = e;
        }
      }
      const noteLoaded = await loadNoteTranscript(m);
      if (noteLoaded) return noteLoaded;
      if (minuteError) throw minuteError;
      return null;
    }
    case 'microsoft_teams':
    case 'manual':
      return loadCachedTranscript(m);
  }
}

function isOAuthRecoveryError(message: string): boolean {
  return isFeishuReloginError(message);
}

export function isFeishuReloginError(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = Number(value?.status);
  const code = String(value?.code || '');
  const message = String(value?.message || error || '');
  return status === 401
    || (status === 409 && /reauth_required/i.test(code + message))
    || /reauth_required|OAuth token|oauth_token_expired|oauth_unavailable|refresh_token|missing_scope|重新登录|用户 OAuth/i.test(code + message);
}

export function recapTranscriptMissingMessage(meeting: Partial<PersistedMeeting>): string {
  switch (meetingPlatformOf(meeting)) {
    case 'lark':
      return '本场无转写（未检测到妙记，可能未开启录制）。';
    case 'google_meet':
      if (meeting.provider_transcript_status === 'not_generated') {
        return 'Google 未生成转写（provider_transcript_status=not_generated）。';
      }
      if (meeting.provider_transcript_status === 'no_record') {
        return 'Google 未找到对应实际场次（provider_transcript_status=no_record）。';
      }
      return 'Google 转写尚未生成；当前没有可展示的原始发言。';
    case 'zoom':
      if (meeting.provider_transcript_status === 'no_record' || meeting.provider_transcript_status === 'not_generated') {
        return zoomTerminalTranscriptMessage(meeting, true);
      }
      return '正在等待 Zoom 会后转写生成。';
    case 'microsoft_teams':
    case 'manual':
      return '该来源暂不支持转写拉取。';
  }
}

function zoomTerminalTranscriptMessage(meeting: Partial<PersistedMeeting>, sentence: boolean): string {
  const message = meeting.provider_transcript_reason === 'instance_not_found'
    ? '未找到实际召开的场次'
    : meeting.provider_transcript_reason === 'recording_missing'
      ? '该场次未开启云录制，没有转写'
      : meeting.provider_transcript_reason === 'transcript_not_generated'
        ? '转写尚未生成或未开启'
        : meeting.provider_transcript_status === 'no_record'
          ? '未找到实际召开的场次'
          : '转写未生成（可能未开启云录制）';
  return sentence ? `${message}。` : message;
}

export function recapTranscriptRetryLabel(meeting: Partial<PersistedMeeting>): string | null {
  if (meeting.provider_transcript_status !== 'pending') return null;
  return meetingPlatformOf(meeting) === 'zoom' ? '重试' : '重新检查';
}

export function recapTranscriptSpeakerLabel(meeting: Partial<PersistedMeeting>, speaker?: string): string {
  return speaker || (meetingPlatformOf(meeting) === 'zoom' ? '未知说话人' : '');
}

export function recapTranscriptPageDescription(meeting: Partial<PersistedMeeting>): string {
  switch (meetingPlatformOf(meeting)) {
    case 'google_meet':
      return '这里展示 Google Meet逐句原始发言；不混入智能纪要，也不混入 InkLoop 后处理。';
    case 'lark':
      return '这里展示飞书会后记录里的逐句原始发言；不混入智能纪要，也不混入 InkLoop 后处理。';
    case 'zoom':
      return '这里展示 Zoom 会后录制的逐句原始发言；不混入官方纪要，也不混入 InkLoop 后处理。';
    case 'microsoft_teams':
    case 'manual':
      return '这里展示该来源已缓存的逐句原始发言；不混入官方纪要，也不混入 InkLoop 后处理。';
  }
}

function recapDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`${label}超时`);
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function recapBlockFailure(error: unknown, feishu: boolean): RecapBlockLoadState {
  const message = String((error as Error)?.message || error);
  return feishu && isFeishuReloginError(error)
    ? { status: 'auth_required', message: '需要重新登录飞书后重试。' }
    : { status: 'failed', message: `拉取失败：${message}` };
}

function hasRemoteTranscriptSource(m: PersistedMeeting): boolean {
  switch (meetingPlatformOf(m)) {
    case 'lark':
      return !!(m.feishu_minute_token || m.feishu_meeting_id);
    case 'google_meet':
      return !!(m.calendar_meeting_no && m.scheduled_at);
    case 'zoom':
      return !!(m.provider_space_name && m.scheduled_at);
    case 'microsoft_teams':
    case 'manual':
      return false;
  }
}

function canResolvePanelMeeting(m: PersistedMeeting): boolean {
  if (meetingPlatformOf(m) !== 'lark') return false;
  const no = m.feishu_meeting_no || m.calendar_meeting_no;
  return !!(no && m.scheduled_at && (!m.feishu_meeting_id || m.feishu_meeting_id === no));
}

function updateProviderNoteState(state: RecapV2, error?: unknown): void {
  switch (meetingPlatformOf(state.meeting)) {
    case 'google_meet':
      if (state.meeting.google_smart_note?.text.trim()) state.noteLoad = { status: 'ready', message: 'Google 智能纪要已同步。' };
      else if (error) state.noteLoad = recapBlockFailure(error, false);
      else if (state.meeting.google_smart_note_scope_missing) state.noteLoad = { status: 'missing', message: '需要重新授权 Google（新增 Drive 读取权限）。' };
      else state.noteLoad = { status: 'missing', message: 'Google 未生成智能纪要。' };
      return;
    case 'lark':
      if (state.feishuSummary?.content || state.meeting.feishu_note_summary?.content) state.noteLoad = { status: 'ready', message: '飞书智能纪要已同步。' };
      else if (error) state.noteLoad = recapBlockFailure(error, true);
      else state.noteLoad = { status: 'missing', message: '飞书未生成可读取的智能纪要。' };
      return;
    case 'zoom':
    case 'microsoft_teams':
    case 'manual':
      state.noteLoad = error
        ? recapBlockFailure(error, false)
        : { status: 'missing', message: '该来源暂不支持官方纪要拉取。' };
  }
}

function rebuildRecapTimeline(state: RecapV2): void {
  const marks = [...state.marksById.values()];
  const timeline = buildEpaperMeetingTimeline({
    meeting: state.meeting,
    cues: state.cues,
    marks: marks.map((mk) => ({
      mark_id: mk.mark_id,
      abs_timestamp: mk.abs_timestamp,
      pen_down_at: mk.pen_down_at,
      feature_type: mk.feature_type,
      marked_text: mk.marked_text,
      page_index: mk.page_index,
    })),
    t0AbsMs: meetingT0(state.meeting),
    offsetMs: finiteMs(state.meeting.align_offset_ms),
  });
  state.timeline = timeline;
  state.segments = timeline.segments;
  state.transcriptMissing = !state.cues.length;
}

function authCheckTimeoutSignal(): { signal: AbortSignal; cancel: () => void } {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), FEISHU_AUTH_CHECK_TIMEOUT_MS);
  return { signal: ctl.signal, cancel: () => window.clearTimeout(timer) };
}

async function checkFeishuOAuthProblem(): Promise<string | null> {
  const { signal, cancel } = authCheckTimeoutSignal();
  try {
    const status = await getJson<FeishuMeStatus>('/api/feishu-svc/api/feishu/me', { auth: true, signal });
    const oauth = status.oauth;
    if (status.connected || oauth?.connected || oauth?.authenticated) return null;
    if (status.configured === false || oauth?.configured === false) return '飞书应用还没有配置完成，暂时不能关联飞书会议。';
    const missingScopes = oauth?.missing_scopes?.filter(Boolean) ?? [];
    if (missingScopes.length) return `当前飞书登录缺少会议读取权限：${missingScopes.join(', ')}。`;
    const reason = oauth?.reason || 'oauth_unavailable';
    if (reason === 'oauth_token_expired' && !oauth?.refresh_token_present) {
      return '飞书用户 OAuth token 已过期，且本地没有 refresh_token；需要重新登录一次，之后才能自动续期。';
    }
    if (isOAuthRecoveryError(reason)) return `飞书登录不可用：${reason}。`;
    return null;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return '检查飞书登录状态超时，请确认 Cloud Hub 和飞书服务可用后重试。';
    return null;
  } finally {
    cancel();
  }
}

async function promptFeishuRelogin(message: string): Promise<void> {
  const login = await confirmSheet({
    title: '需要重新登录飞书',
    message: `${message}\n\n重新登录后会自动回到 InkLoop，再刷新这场会议即可关联会后记录。`,
    confirm: '重新登录',
  });
  if (!login) return;
  await startDeviceFeishuLogin().catch(async (err) => {
    await infoSheet({ title: '飞书登录失败', message: String((err as Error)?.message || err) });
  });
}

async function startDeviceFeishuLogin(): Promise<void> {
  const payload = await getJson<{ auth_url: string }>(`/api/feishu-svc/api/feishu/oauth/device/start?redirect=web`, { auth: true });
  if (!payload.auth_url) throw new Error('missing_feishu_auth_url');
  window.location.href = payload.auth_url;
}

function renderTranscriptLoadError(seq: number, meetingId: string, bodyEl: HTMLElement, titleEl: HTMLElement, error: unknown): void {
  const message = String((error as Error)?.message || error);
  if (!isOAuthRecoveryError(message)) {
    bodyEl.innerHTML = `<p class="rc-note">读取会后记录失败：${esc(message)}。</p><button class="hbtn" id="recap-retry">刷新重试</button>`;
    bodyEl.querySelector('#recap-retry')?.addEventListener('click', () => {
      if (recapAlive(seq, bodyEl)) void loadRecapView(meetingId, bodyEl, titleEl);
    });
    return;
  }
  bodyEl.innerHTML =
    `<section class="rc-auth-card">`
    + `<h2>需要重新登录飞书</h2>`
    + `<p>当前飞书 OAuth 已过期，且本地没有 refresh_token。请在当前电子纸上重新授权飞书，授权完成后会回到 InkLoop。</p>`
    + `<p class="mut">${esc(message)}</p>`
    + `<div class="dact"><button class="hbtn pri" id="recap-oauth-login">重新登录飞书</button><button class="hbtn" id="recap-retry">刷新重试</button></div>`
    + `</section>`;
  bodyEl.querySelector('#recap-oauth-login')?.addEventListener('click', () => {
    void startDeviceFeishuLogin().catch(async (e) => {
      await infoSheet({ title: '飞书登录失败', message: String((e as Error)?.message || e) });
    });
  });
  bodyEl.querySelector('#recap-retry')?.addEventListener('click', () => {
    if (recapAlive(seq, bodyEl)) void loadRecapView(meetingId, bodyEl, titleEl);
  });
}

const recapTranscriptRefreshInFlight = new Map<string, { seq: number; task: Promise<void> }>();

async function refreshTranscriptAfterInitialRender(seq: number, bodyEl: HTMLElement, meetingId: string): Promise<void> {
  const running = recapTranscriptRefreshInFlight.get(meetingId);
  if (running?.seq === seq) return running.task;
  const task = (async () => {
    if (!recapState || recapState.meeting.meeting_id !== meetingId) return;
    const current = recapState.meeting;
    const freshMeeting = await recapDeadline(getMeeting(meetingId), RECAP_LOCAL_TIMEOUT_MS, '读取会议')
      .catch(() => null) ?? current;
    try {
      const loaded = await recapDeadline(loadTranscript(freshMeeting), RECAP_REMOTE_BLOCK_TIMEOUT_MS, '拉取转写');
      if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
      recapState.meeting = freshMeeting;
      recapState.cues = loaded?.cues ?? [];
      if (loaded?.timestampQuality) recapState.providerTimestampQuality = loaded.timestampQuality;
      recapState.transcriptLoad = recapState.cues.length
        ? { status: 'ready', message: '原始发言已同步。' }
        : { status: 'missing', message: recapTranscriptMissingMessage(freshMeeting) };
      rebuildRecapTimeline(recapState);
      refreshRecapOverviewBlocks(bodyEl, ['#rc-over-hero', '#rc-participants', '#rc-over-focus', '#rc-transcript-block']);
      if (recapState.view === 'transcript') renderRecap(bodyEl);

      const platform = meetingPlatformOf(freshMeeting);
      if (platform === 'google_meet') {
        updateProviderNoteState(recapState);
        refreshRecapOverviewBlocks(bodyEl, ['#rc-feishu-block']);
        if (recapState.view === 'feishu') renderRecap(bodyEl);
        if (recapState.cues.length && !recapState.panelSummary) void loadProviderPanelSummary(seq, bodyEl, freshMeeting, recapState.cues);
      } else if (platform === 'zoom') {
        updateProviderNoteState(recapState);
        refreshRecapOverviewBlocks(bodyEl, ['#rc-feishu-block']);
        if (recapState.cues.length && !recapState.panelSummary) void loadProviderPanelSummary(seq, bodyEl, freshMeeting, recapState.cues);
      } else if (platform === 'lark') {
        if (loaded?.sourceToken === freshMeeting.feishu_minute_token && freshMeeting.feishu_meeting_id) {
          try {
            const note = await recapDeadline(loadNoteTranscript(freshMeeting), RECAP_REMOTE_BLOCK_TIMEOUT_MS, '拉取飞书纪要');
            if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
            if (!recapState.cues.length && note?.cues.length) recapState.cues = note.cues;
            recapState.feishuSummary = freshMeeting.feishu_note_summary ?? null;
            updateProviderNoteState(recapState);
            rebuildRecapTimeline(recapState);
          } catch (error) {
            // 串会守卫：A 会议的纪要请求等待期间切到 B，A 迟到失败不能污染 B 的 noteLoad
            if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
            updateProviderNoteState(recapState, error);
          }
          refreshRecapOverviewBlocks(bodyEl, ['#rc-over-hero', '#rc-over-focus', '#rc-transcript-block', '#rc-feishu-block']);
          if (recapState?.view === 'feishu' || recapState?.view === 'transcript') renderRecap(bodyEl);
        } else {
          recapState.feishuSummary = freshMeeting.feishu_note_summary ?? null;
          updateProviderNoteState(recapState);
          refreshRecapOverviewBlocks(bodyEl, ['#rc-feishu-block']);
        }
      } else {
        updateProviderNoteState(recapState);
        refreshRecapOverviewBlocks(bodyEl, ['#rc-feishu-block']);
      }
    } catch (error) {
      if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
      if (!recapState.cues.length) recapState.transcriptLoad = recapBlockFailure(error, meetingPlatformOf(freshMeeting) === 'lark');
      else recapState.transcriptLoad = { status: 'ready', cached: true, message: '当前显示本机缓存；后台刷新失败。' };
      if (recapState.noteLoad.status === 'loading') updateProviderNoteState(recapState, error);
      refreshRecapOverviewBlocks(bodyEl, ['#rc-transcript-block', '#rc-feishu-block']);
      if (recapState.view === 'transcript' || recapState.view === 'feishu') renderRecap(bodyEl);
    }
  })().finally(() => {
    if (recapTranscriptRefreshInFlight.get(meetingId)?.task === task) recapTranscriptRefreshInFlight.delete(meetingId);
  });
  recapTranscriptRefreshInFlight.set(meetingId, { seq, task });
  return task;
}

async function loadRecapMarksAfterInitialRender(seq: number, bodyEl: HTMLElement, meeting: PersistedMeeting): Promise<void> {
  try {
    const loaded = await recapDeadline(loadMeetingRecapMarks(meeting), RECAP_LOCAL_TIMEOUT_MS, '读取手写档案');
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meeting.meeting_id) return;
    recapState.marksById = new Map(loaded.marks.map((mark) => [mark.mark_id, mark] as const));
    recapState.markSourceMeeting = loaded.sourceMeeting;
    recapState.marksLoad = loaded.marks.length
      ? { status: 'ready', message: `已读取 ${loaded.marks.length} 处手写记录。` }
      : { status: 'missing', message: '本场没有手写记录。' };
    rebuildRecapTimeline(recapState);
  } catch (error) {
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meeting.meeting_id) return;
    recapState.marksLoad = recapBlockFailure(error, false);
  }
  refreshRecapOverviewBlocks(bodyEl, ['#rc-over-hero', '#rc-over-focus', '#rc-handwriting-block']);
}

// 负 ms＝会前（M6·segment.ts 不再 clamp≥0）：保留负号，如 -9:52。⚠️s 四舍五入到 0 时别显 "-0:00"（codex 抓）。
const clk = (ms: number): string => { const s = Math.round(Math.abs(ms) / 1000); const neg = ms < 0 && s > 0; return `${neg ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// t0/offset 防 NaN（started_at 可能解析失败·codex A#1）：取第一个有限值，否则 0。
const finiteMs = (...xs: Array<number | null | undefined>): number => { for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) return x; return 0; };
// t0 优先级：真录音事件 t0 > vc 会议开始 t0 > legacy feishu_recording_t0（旧数据装的 panel 近似）> panel_start > started_at。
// 会后对轴优先「录音 t0」；拿不到才退「会议事件 t0」，并由 UI 明示录音残差未消除。
const meetingT0 = (m: PersistedMeeting): number =>
  m.t0_source === 'recording_event' && Number.isFinite(m.feishu_recording_t0)
    ? (m.feishu_recording_t0 as number)
    : finiteMs(m.vc_meeting_start_t0, m.feishu_recording_t0, m.panel_meeting_start, m.started_at ? Date.parse(m.started_at) : NaN);

function activeInkMarks(marks: PersistedMark[]): PersistedMark[] {
  return marks
    .filter((mark) => !mark.is_tombstone && hasMeetingInk(mark))
    .sort((a, b) => (markTime(a) - markTime(b)) || (a.seq - b.seq));
}

async function directMeetingMarks(meetingId: string): Promise<PersistedMark[]> {
  const byContext = activeInkMarks(await getFoldedMarksByContext('mtg_' + meetingId));
  const byBoard = activeInkMarks(await getFoldedMarks('mtgboard_' + meetingId));
  const deduped = new Map<string, PersistedMark>();
  for (const mark of [...byContext, ...byBoard]) deduped.set(mark.mark_id, mark);
  return [...deduped.values()].sort((a, b) => (markTime(a) - markTime(b)) || (a.seq - b.seq));
}

// 手记严格只属于本地单场 meeting_id（写入端 context_id='mtg_'+id / 'mtgboard_'+id）。
// 绝不跨会议实例借手记——旧的按 feishu_meeting_id/系列标题/时间窗回退会把预写/兄弟实例的手记
// 泄漏到所有周期会实例（尤其短号冒充 meeting_id 时 sameFeishu 恒真）。录音落在兄弟实例的场景应由
// 显式 occurrence 合并解决，不在 recap 层猜。
async function loadMeetingRecapMarks(meeting: PersistedMeeting): Promise<{ marks: PersistedMark[]; sourceMeeting: PersistedMeeting | null }> {
  const marks = await directMeetingMarks(meeting.meeting_id);
  return { marks, sourceMeeting: marks.length ? meeting : null };
}

// 打开会后记录时按需解析真 VC meeting_id：日历/周期会来源只有入会短号（meeting_no），
// 用该场 scheduled_at 的 ±6h 窗单次 list_by_no 换真 id 并持久化。一次一场、不触发批量限流。
// 失败(限流/网络)不阻断——退回既有值（无真 id 则 recap 显示未关联，不伪造）。
async function resolveRealMeetingId(m: PersistedMeeting): Promise<PersistedMeeting> {
  const no = m.feishu_meeting_no || m.calendar_meeting_no;
  if (!no || !m.scheduled_at) return m;
  if (m.feishu_meeting_id && m.feishu_meeting_id !== no) return m; // 已有真 id
  try {
    const inst = await resolveMeetingInstance(no, m.scheduled_at);
    if (!inst) return m;
    // 只落 meeting_id 关联——不从解析结果写 started_at/t0：list_by_no brief 没有自己的真实开始时间，
    // 那个 started_at 是用 scheduled_at 回填的伪造值，写成 vc_event t0 会污染时间轴对齐（真 t0 由 panel VC 事件给）。
    const patch: Partial<PersistedMeeting> = {
      feishu_meeting_id: inst.meeting_id,
      feishu_meeting_no: inst.meeting_no || no,
      ...(inst.topic ? { feishu_topic: inst.topic } : {}),
    };
    const updated = await updateMeeting(m.meeting_id, patch);
    return updated ?? { ...m, ...patch };
  } catch {
    return m;
  }
}

/** 进 recap 视图：拉转写 + 手写档案 → 分段 → 渲染概览（段级时间线为主体·左侧 #recap-nav 切到飞书纪要/思路总结/InkLoop总结整页）；
 *  并异步补 active 段 AI 摘要。 */
export async function loadRecapView(meetingId: string, bodyEl: HTMLElement, titleEl: HTMLElement): Promise<void> {
  const seq = ++recapLoadSeq;
  recapState = null;
  updateExportButton(); // 加载中先隐藏导出按钮/nav（还没有有效 recapState）
  updateRecapNav();
  bodyEl.innerHTML = '<p class="rc-note">正在打开会后概览…</p>';
  let m: PersistedMeeting | null;
  try {
    m = await recapDeadline(getMeeting(meetingId), RECAP_LOCAL_TIMEOUT_MS, '读取本地会议');
  } catch (error) {
    if (recapAlive(seq, bodyEl)) renderTranscriptLoadError(seq, meetingId, bodyEl, titleEl, error);
    return;
  }
  if (!recapAlive(seq, bodyEl)) return;
  if (!m) { bodyEl.innerHTML = '<p class="rc-note">会议不存在。</p>'; return; }
  titleEl.textContent = `${m.title || '会议'} · 会后记录`;
  if (m.panel_summary_unread) void updateMeeting(m.meeting_id, { panel_summary_unread: false }); // 进 recap 即「已读」·清 home/detail 提醒
  const timeline = buildEpaperMeetingTimeline({
    meeting: m,
    cues: [],
    marks: [],
    t0AbsMs: meetingT0(m),
    offsetMs: finiteMs(m.align_offset_ms),
  });
  const sourceExpected = hasRemoteTranscriptSource(m) || canResolvePanelMeeting(m);
  const platform = meetingPlatformOf(m);
  const providerNoteReady = (platform === 'google_meet' || platform === 'lark')
    && !!(m.feishu_note_summary?.content || m.google_smart_note?.text);
  const missingTranscriptMessage = platform === 'lark'
    ? '尚未关联飞书会议。关联后可读取会后记录。'
    : recapTranscriptMissingMessage(m);
  const missingNoteMessage = platform === 'lark'
    ? '尚未关联飞书会议。'
    : platform === 'google_meet'
      ? 'Google 未生成智能纪要。'
      : '该来源暂不支持官方纪要拉取。';
  recapState = { meeting: m, segments: timeline.segments, cues: [], view: 'overview', detailIdx: 0, ovPage: 0, dtPage: 0, txPage: 0, bodyEl, transcriptMissing: true,
    feishuSummary: m.feishu_note_summary ?? null,
    panelSummary: m.panel_summary ?? null,
    panelSummaryStatus: m.panel_summary ? 'ready' : (m.panel_summary_status === 'missing_minute'
      ? 'not_generated'
      : m.panel_summary_status ?? ((platform === 'lark' || platform === 'google_meet') && m.feishu_meeting_id ? 'loading' : 'not_generated')),
    timeline,
    marksById: new Map(),
    markSourceMeeting: null,
    transcriptLoad: sourceExpected
      ? { status: 'loading', message: '正在拉取转写…' }
      : { status: 'missing', message: missingTranscriptMessage },
    noteLoad: providerNoteReady
      ? { status: 'ready', message: '官方纪要已同步。' }
      : sourceExpected
        ? { status: 'loading', message: '正在拉取官方纪要…' }
        : { status: 'missing', message: missingNoteMessage },
    marksLoad: { status: 'loading', message: '正在读取本机手写档案…' } };
  renderRecap(bodyEl);
  updateExportButton();
  wireRecapExportButton();
  updateRecapNav();
  wireRecapNav();
  void loadRecapMarksAfterInitialRender(seq, bodyEl, m);
  void (async () => {
    let resolved = m;
    const applyCached = (cached: LoadedTranscript | null): void => {
      if (!cached || !recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
      recapState.cues = cached.cues;
      recapState.transcriptLoad = { status: 'ready', cached: true, message: '当前显示本机缓存，正在后台刷新。' };
      rebuildRecapTimeline(recapState);
      refreshRecapOverviewBlocks(bodyEl, ['#rc-over-hero', '#rc-over-focus', '#rc-transcript-block']);
    };
    // 本地缓存先行：缓存 key（minute_token/meeting_id）就在本地会议记录上，不该排在网络 resolve 之后——
    // 慢网时那一等就是「原始发言卡按不动」的等待窗口。
    applyCached(await recapDeadline(loadCachedTranscript(m), RECAP_LOCAL_TIMEOUT_MS, '读取转写缓存').catch(() => null));
    if (meetingPlatformOf(resolved) === 'lark') {
      resolved = await recapDeadline(resolveRealMeetingId(resolved), RECAP_REMOTE_BLOCK_TIMEOUT_MS, '解析飞书场次').catch(() => resolved);
    }
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
    recapState.meeting = resolved;
    if (!hasRemoteTranscriptSource(resolved)) {
      recapState.transcriptLoad = { status: 'missing', message: recapTranscriptMissingMessage(resolved) };
      updateProviderNoteState(recapState);
      refreshRecapOverviewBlocks(bodyEl, ['#rc-transcript-block', '#rc-feishu-block']);
      return;
    }
    // resolve 补出新 id 才可能命中的缓存：早读没中时再试一次
    if (!recapState.cues.length) {
      applyCached(await recapDeadline(loadCachedTranscript(resolved), RECAP_LOCAL_TIMEOUT_MS, '读取转写缓存').catch(() => null));
    }
    if (meetingPlatformOf(resolved) === 'lark' && resolved.feishu_meeting_id) void loadPanelSummary(seq, bodyEl, resolved);
    void refreshTranscriptAfterInitialRender(seq, bodyEl, meetingId);
  })();
}

function renderRecap(bodyEl: HTMLElement): void {
  if (!recapState) return;
  document.body.dataset.recapView = recapState.view;
  bodyEl.dataset.rcView = recapState.view;
  if (recapState.view === 'detail') renderRecapDetail(bodyEl);
  else if (recapState.view === 'transcript') renderRecapTranscriptPage(bodyEl);
  else if (recapState.view === 'feishu') renderRecapFeishuPage(bodyEl);
  else if (recapState.view === 'summary') renderRecapSummaryPage(bodyEl);
  else if (recapState.view === 'panel') renderRecapPanelPage(bodyEl);
  else renderRecapOverview(bodyEl);
}

/** 导航脊 #recap-sub：概览/原始发言/飞书纪要/思路总结/InkLoop 总结互为平级页（点即切·非抽屉）。 */
function updateRecapNav(): void {
  if (!recapState) return; // 显隐交给 CSS(body[data-mtg="recap"])；无有效 recapState 时不瞎改高亮
  const view = recapState.view;
  // 纪要入口标签随 provider：Google 会议别写「飞书纪要」（纪要=将来的 Gemini 智能纪要）。
  const feishuNav = document.querySelector<HTMLElement>('#recap-sub [data-rc="feishu"]');
  if (feishuNav) {
    const platform = meetingPlatformOf(recapState.meeting);
    const label = platform === 'google_meet' ? '智能纪要' : platform === 'lark' ? '飞书纪要' : '官方纪要';
    feishuNav.setAttribute('aria-label', label);
    const lab = feishuNav.closest('.rl-item')?.querySelector<HTMLElement>('.rl-lab');
    if (lab && lab.textContent !== label) lab.textContent = label;
  }
  document.querySelectorAll<HTMLElement>('#recap-sub [data-rc]').forEach((b) => {
    // detail 是概览里「手写记录」的下钻，没有独立入口——停在 detail 时"概览"仍高亮。
    const on = b.dataset.rc === view || (b.dataset.rc === 'overview' && view === 'detail');
    b.classList.toggle('on', on); b.classList.toggle('dim', !on);
    b.closest('.rl-item')?.classList.toggle('cur', on);
  });
}
function wireRecapNav(): void {
  document.querySelectorAll<HTMLElement>('#recap-sub [data-rc]').forEach((b) => {
    b.onclick = () => {
      if (!recapState) return;
      const rc = b.dataset.rc as RecapV2['view'] | undefined;
      if (rc !== 'overview' && rc !== 'transcript' && rc !== 'feishu' && rc !== 'summary' && rc !== 'panel') return;
      recapState.view = rc;
      renderRecap(recapState.bodyEl);
      updateRecapNav();
    };
  });
}

/** 翻页条（id 前缀区分概览/详情）。 */
function pagerHtml(id: string, page: number, total: number): string {
  if (total <= 1) return '';
  return `<div class="tl-pager"><button class="hbtn" id="${id}-prev"${page === 0 ? ' disabled style="opacity:.4"' : ''}>‹ 上一页</button>`
    + `<span class="tl-pn">${page + 1} / ${total}</span>`
    + `<button class="hbtn" id="${id}-next"${page >= total - 1 ? ' disabled style="opacity:.4"' : ''}>下一页 ›</button></div>`;
}

/** 页码钳到 [0, total-1]（防负/越界渲染空页·codex A#6）。 */
const clampPage = (p: number, total: number): number => Math.max(0, Math.min(p, total - 1));

// M2b·思路总结：本地 m.summary（summarizeMeeting 生成·手写档案 AI 综合）——左侧 #recap-nav「思路总结」入口整页，
// 与 InkLoop 结构化总结（另一入口）分开（时间脊为主体这版布局：各入口互为平级页，时间脊只呈现"我何时写了什么"）。
function meetingSummaryHtml(): string {
  if (!recapState) return '';
  const m = recapState.meeting;
  const sourceKey = transcriptSourceKey(m);
  const summarySourceToken = meetingSummaryTranscriptCacheToken(m);
  const stale = !!(m.summary && summarySourceToken && sourceKey && summarySourceToken !== sourceKey);
  const body = m.summary
    ? `${stale ? '<div class="empty" style="margin:0 0 6px">⚠ 此总结基于旧转写来源生成，可能不对应当前转写，建议重新生成。</div>' : ''}<div class="summary" id="rs-body">${esc(m.summary)}</div>`
    : meetingPlatformOf(m) === 'zoom' || meetingPlatformOf(m) === 'microsoft_teams' || meetingPlatformOf(m) === 'manual'
      ? `<div class="empty" id="rs-body">${sourceKey ? '还没生成思路总结。可基于已缓存转写和本场手写生成。' : '该来源暂无可用于生成思路总结的转写。'}</div>`
      : `<div class="empty" id="rs-body">${recapState.panelSummary ? '还没生成设备端思路总结；InkLoop 总结已同步。可点生成，把飞书转写和本场手写合在一起。' : (sourceKey ? '还没生成思路总结。可基于飞书会后转写和本场手写生成。' : '还没生成思路总结。先关联飞书会议后再生成。')}</div>`;
  const label = m.summary ? '重新生成' : '生成思路总结';
  const disabled = sourceKey ? '' : ' disabled style="opacity:.45"';
  return `<div class="rc-msum">`
    + `<div class="rc-msum-h"><b>思路总结</b><button class="hbtn" id="rs-gen"${disabled}>${label}</button></div>`
    + body + `</div>`;
}
async function generateMeetingSummary(seq: number, bodyEl: HTMLElement, meetingId: string): Promise<void> {
  if (!recapState || !recapAlive(seq, bodyEl) || recapState.meeting.meeting_id !== meetingId) return;
  const btn = bodyEl.querySelector<HTMLButtonElement>('#rs-gen');
  if (btn?.dataset.busy) return;
  if (btn) { btn.dataset.busy = '1'; btn.textContent = '生成中…'; btn.disabled = true; }
  let lastPaint = 0;
  try {
    const out = await summarizeMeeting(meetingId, (full) => {
      const now = Date.now();
      if (now - lastPaint < 500) return; // 电纸屏 500ms 合并刷新·防残影
      lastPaint = now;
      if (!recapAlive(seq, bodyEl)) return;
      const sumEl = bodyEl.querySelector<HTMLElement>('#rs-body');
      if (sumEl) { sumEl.className = 'summary'; sumEl.textContent = full; }
    });
    if (!out || !recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
    const fresh = await getMeeting(meetingId); // 刷新 recapState.meeting → renderRecap 重渲（不重 loadRecapView·免重拉转写/重算分段）
    if (fresh && recapAlive(seq, bodyEl) && recapState && recapState.meeting.meeting_id === meetingId) recapState.meeting = fresh;
  } finally {
    if (recapAlive(seq, bodyEl)) renderRecap(bodyEl);
  }
}
function wireMeetingSummaryButton(bodyEl: HTMLElement): void {
  bodyEl.querySelector('#rs-gen')?.addEventListener('click', () => {
    if (!recapState) return;
    void generateMeetingSummary(recapLoadSeq, bodyEl, recapState.meeting.meeting_id);
  });
}
/** 左侧 nav「思路总结」入口整页。 */
function renderRecapSummaryPage(bodyEl: HTMLElement): void {
  if (!recapState) return;
  bodyEl.innerHTML = meetingSummaryHtml();
  wireMeetingSummaryButton(bodyEl);
}

const FEISHU_IMAGE_REF = /^(?:meetgraph|images\/online)\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp)$/i;
const FEISHU_META_RE = /^(会议主题|会议时间|参会人)：/;
const FEISHU_IMAGE_CAPTION_MAX = 42;

const FEISHU_SECTION_HINTS = new Set([
  '总结', '白板笔调研结果', '问卷情况', '存在问题', '产品概念反馈', '笔内采集算法可行性调研',
  '算法方案', '绝对定位与重定位技术评估', '恢复方案', '电子纸方案', '笔的方案', '产品设计',
  'Nodesk.ai 账号定位、对标&触达故事', '营销方案', '账号运营', '产品推进计划', '白板笔推进',
  '后续工作计划', '待办', '会议最佳表现成员', '相关链接', '相关会议纪要',
]);

function feishuLines(content: string): string[] {
  return String(content || '').split(/\r?\n/).map((line) => line.trim());
}

function isFeishuImageRef(line: string): boolean {
  return FEISHU_IMAGE_REF.test(line.trim());
}

function isLikelyImageCaption(line: string): boolean {
  const s = line.trim();
  return !!s && s.length <= FEISHU_IMAGE_CAPTION_MAX && !FEISHU_META_RE.test(s) && !/[。；？！：]$/.test(s);
}

function isFeishuHeading(line: string, next?: string): boolean {
  const s = line.trim();
  if (!s || isFeishuImageRef(s) || FEISHU_META_RE.test(s)) return false;
  if (FEISHU_SECTION_HINTS.has(s)) return true;
  if (s.startsWith('智能纪要：')) return true;
  if (s.startsWith('智能会议纪要由 AI')) return false;
  if (s.length > 34 || /[。；？！]$/.test(s)) return false;
  return !!next && /：/.test(next) && !/：/.test(s);
}

function splitKvLine(line: string): { k: string; v: string } | null {
  const i = line.indexOf('：');
  if (i <= 0 || i > 18) return null;
  const k = line.slice(0, i).trim();
  const v = line.slice(i + 1).trim();
  if (!k || !v) return null;
  return { k, v };
}

function normalizeBulletLine(line: string): string | null {
  const s = line.trim();
  const bullet = s.match(/^(?:[-*•]\s+|[0-9一二三四五六七八九十]+[.)、]\s+)(.+)$/);
  return bullet?.[1]?.trim() || null;
}

function normalizeMarkdownHeading(line: string): string {
  return line.replace(/^#{1,4}\s+/, '').trim();
}

function fileNameOfRef(ref: string): string {
  return ref.split('/').pop() || ref;
}

function docxMediaUrl(documentId: string, fileToken: string): string {
  return apiUrl(`/api/feishu-svc/api/feishu/docx/${encodeURIComponent(documentId)}/media/${encodeURIComponent(fileToken)}`);
}

/** 飞书 raw_content 只保留纯文本；这里按它的稳定行形态恢复标题、键值段、待办和图片资源位。 */
function renderFeishuSummaryRich(rec: FeishuNoteSummaryRecord): string {
  const lines = feishuLines(rec.content);
  const imageResources = [...(rec.images || [])].sort((a, b) => a.index - b.index);
  let imageCursor = 0;
  let html = '<div class="rc-rich">';
  let inTasks = false;
  for (let i = 0; i < lines.length; i++) {
    const line = normalizeMarkdownHeading(lines[i]);
    if (!line) continue;
    const next = normalizeMarkdownHeading(lines.slice(i + 1).find(Boolean) || '');
    if (isFeishuImageRef(line)) {
      const caption = next && isLikelyImageCaption(next) ? next : '';
      const image = imageResources[imageCursor++];
      const src = image?.file_token ? docxMediaUrl(rec.document_id, image.file_token) : '';
      if (caption) {
        const captionIndex = lines.indexOf(caption, i + 1);
        if (captionIndex > i) i = captionIndex;
      }
      html += `<figure class="rc-figure${src ? ' rc-figure-media is-loading' : ''}">`
        + `<div class="rc-figure-ph"><span>${src ? '图片加载中' : '图片资源'}</span><code>${esc(fileNameOfRef(line))}</code></div>`
        + (src ? `<img class="rc-figure-img" data-src="${esc(src)}" alt="${esc(caption || fileNameOfRef(line))}" loading="eager" decoding="async">` : '')
        + `${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}<small>${esc(line)}</small></figure>`;
      continue;
    }
    if (line.startsWith('智能会议纪要由 AI')) {
      html += `<div class="rc-rich-alert">${esc(line)}</div>`;
      continue;
    }
    const bullet = normalizeBulletLine(line);
    if (bullet) {
      html += `<div class="rc-rich-bullet"><span></span><p>${esc(bullet)}</p></div>`;
      continue;
    }
    if (FEISHU_META_RE.test(line)) {
      const kv = splitKvLine(line);
      html += kv ? `<div class="rc-rich-meta"><b>${esc(kv.k)}</b><span>${esc(kv.v)}</span></div>` : `<p class="rc-rich-p">${esc(line)}</p>`;
      continue;
    }
    if (isFeishuHeading(line, next)) {
      inTasks = line === '待办';
      const level = line.startsWith('智能纪要：') ? 'title' : line.length <= 6 || line === '总结' || line === '待办' ? 'h2' : 'h3';
      html += `<div class="rc-rich-${level}">${esc(line)}</div>`;
      continue;
    }
    const kv = splitKvLine(line);
    if (inTasks && kv) {
      html += `<div class="rc-task"><b>${esc(kv.k)}</b><span>${esc(kv.v)}</span></div>`;
      continue;
    }
    if (kv) {
      html += `<div class="rc-rich-kv"><b>${esc(kv.k)}</b><span>${esc(kv.v)}</span></div>`;
      continue;
    }
    html += `<p class="rc-rich-p">${esc(line)}</p>`;
  }
  html += '</div>';
  return html;
}

function wireFeishuSummaryImages(bodyEl: HTMLElement): void {
  bodyEl.querySelectorAll<HTMLImageElement>('.rc-figure-img').forEach((img) => {
    const fig = img.closest<HTMLElement>('.rc-figure-media');
    const done = (ok: boolean): void => {
      if (!fig) return;
      fig.classList.toggle('is-loaded', ok);
      fig.classList.toggle('is-failed', !ok);
      const label = fig.querySelector<HTMLElement>('.rc-figure-ph span');
      if (label && !ok) label.textContent = '图片加载失败';
    };
    img.addEventListener('load', () => done(true), { once: true });
    img.addEventListener('error', () => done(false), { once: true });
    const source = img.dataset.src;
    if (source && !img.src && !img.dataset.loading) {
      img.dataset.loading = '1';
      void authFetch(source)
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        })
        .then((blob) => {
          img.src = URL.createObjectURL(blob);
        })
        .catch(() => done(false));
      return;
    }
    if (img.complete) done(img.naturalWidth > 0);
  });
}

/** 左侧 nav「飞书纪要」入口整页：飞书官方智能纪要原文，和文字记录/InkLoop 总结分开。 */
function renderRecapFeishuPage(bodyEl: HTMLElement): void {
  if (!recapState) return;
  const platform = meetingPlatformOf(recapState.meeting);
  if (platform === 'google_meet') {
    const smartNote = recapState.meeting.google_smart_note;
    if (smartNote?.text.trim()) {
      const paragraphs = smartNote.text.trim().split(/\n\s*\n+/).filter(Boolean)
        .map((paragraph) => `<p class="rc-rich-p">${esc(paragraph).replaceAll('\n', '<br>')}</p>`).join('');
      bodyEl.innerHTML = `<div class="rc-msum"><div class="rc-msum-h"><b>Gemini 智能纪要</b><span class="mdl">Google Meet 原文</span></div>`
        + `<div class="rc-rich">${paragraphs}</div>`
        + (smartNote.export_uri ? `<a class="rc-smart-note-link" href="${esc(smartNote.export_uri)}" target="_blank" rel="noopener">在 Google Docs 查看</a>` : '')
        + `</div>`;
      return;
    }
    const message = recapState.meeting.google_smart_note_scope_missing
      ? '需要重新授权 Google（新增 Drive 读取权限），授权后重新进入本页即可同步 Gemini 智能纪要。'
      : recapState.noteLoad.status === 'loading'
        ? (recapState.noteLoad.message || '正在拉取 Gemini 智能纪要…')
        : 'Google 智能纪要（Gemini）尚未生成或未同步；生成后这里会显示官方纪要原文。原始发言和 InkLoop 后处理不受影响。';
    bodyEl.innerHTML = `<div class="rc-msum"><div class="rc-msum-h"><b>智能纪要</b><span class="mdl">Google Meet</span></div>`
      + `<div class="empty">${esc(message)}</div></div>`;
    return;
  }
  if (platform !== 'lark') {
    bodyEl.innerHTML = `<div class="rc-msum"><div class="rc-msum-h"><b>官方纪要</b><span class="mdl">当前来源</span></div>`
      + `<div class="empty">该来源暂不支持官方纪要拉取。</div></div>`;
    return;
  }
  const rec = recapState.feishuSummary ?? recapState.meeting.feishu_note_summary ?? null;
  if (rec?.content.trim()) {
    const title = rec.title || '飞书智能纪要';
    bodyEl.innerHTML = `<div class="rc-msum">`
      + `<div class="rc-msum-h"><b>${esc(title)}</b><span class="mdl">飞书原文</span></div>`
      + renderFeishuSummaryRich(rec)
      + `</div>`;
    wireFeishuSummaryImages(bodyEl);
    return;
  }
  const status = recapState.meeting.feishu_note_summary_status;
  const msg = status === 'missing'
    ? '飞书会后记录里暂时没有可读取的官方智能纪要；如果飞书稍后生成，重新进入本页会自动补上。'
    : status === 'failed'
      ? '飞书智能纪要拉取失败。返回会议列表再进入本页会重试。'
      : '正在等待飞书官方智能纪要；这不影响时间脊里的文字记录和手写记录。';
  bodyEl.innerHTML = `<div class="rc-msum"><div class="rc-msum-h"><b>飞书智能纪要</b><span class="mdl">飞书原文</span></div><div class="empty">${esc(msg)}</div></div>`;
}

/** 左侧 nav「原始发言」入口：逐句展示飞书原始发言，和智能纪要/InkLoop 后处理分开。 */
function renderRecapTranscriptPage(bodyEl: HTMLElement): void {
  if (!recapState) return;
  const cues = recapState.cues;
  const platform = meetingPlatformOf(recapState.meeting);
  const sourceLabel = platform === 'google_meet'
    ? 'Google Meet 逐句转写'
    : platform === 'lark'
      ? '飞书逐句转写'
      : platform === 'zoom'
        ? 'Zoom 会后逐句转写'
        : '来源逐句转写';
  if (!cues.length) {
    // 加载中允许进入（卡片不再封死）：这里给拉取中提示，拉完 refreshTranscriptAfterInitialRender 会重渲本页
    const load = recapState.transcriptLoad;
    const hint = platform === 'lark' || platform === 'google_meet'
      ? load.status === 'loading'
        ? (load.message || '正在拉取原始发言…')
        : '原始发言还没有同步到本机；稍后重新进入本页会自动重试。'
      : platform === 'zoom'
        ? (load.message || '正在等待 Zoom 会后转写生成。')
        : '该来源暂不支持转写拉取。';
    bodyEl.innerHTML = `<div class="rc-msum"><div class="rc-msum-h"><b>原始发言</b><span class="mdl">${sourceLabel}</span></div><div class="empty">${esc(hint)}</div></div>`;
    return;
  }
  const total = Math.max(1, Math.ceil(cues.length / TX_PAGE));
  const p = clampPage(recapState.txPage, total);
  recapState.txPage = p;
  const slice = cues.slice(p * TX_PAGE, (p + 1) * TX_PAGE);
  const speakerCount = new Set(cues.map((cue) => cue.speaker || '').filter(Boolean)).size;
  const rows = slice.map((cue) => {
    const speakerLabel = recapTranscriptSpeakerLabel({ platform }, cue.speaker);
    const speaker = speakerLabel ? `<span class="rc-tr-speaker">${esc(speakerLabel)}</span>` : '';
    return `<div class="rc-tr-row"><span class="rc-tr-time">${clk(cue.startMs)}</span><span class="rc-tr-text">${speaker}${esc(cue.text)}</span></div>`;
  }).join('');
  bodyEl.innerHTML = `<div class="rc-transcript">`
    + `<div class="rc-msum-h"><b>原始发言</b><span class="mdl">${cues.length} 句 · ${speakerCount || '未知'} 人</span></div>`
    + `<div class="rc-note">${recapTranscriptPageDescription(recapState.meeting)}</div>`
    + `<div class="rc-tr-list">${rows}</div>`
    + pagerHtml('tx', p, total)
    + `</div>`;
  bodyEl.querySelector('#tx-prev')?.addEventListener('click', () => { if (recapState) { recapState.txPage = p - 1; renderRecap(bodyEl); bodyEl.scrollTop = 0; } });
  bodyEl.querySelector('#tx-next')?.addEventListener('click', () => { if (recapState) { recapState.txPage = p + 1; renderRecap(bodyEl); bodyEl.scrollTop = 0; } });
}

// ── 阶段⑤·按需导出：顶栏「导出知识库快照」按钮（单会议触发·见 vault-publish-device.ts publishEntityToVault 头注） ──
const fmtExportedAt = (iso: string): string => {
  try { return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return iso; }
};
/** 按当前 recapState 刷新顶栏导出按钮的文案/可见性（不动忙态——忙态由 runVaultExport 自己管）。 */
function updateExportButton(): void {
  const btn = document.getElementById('recap-export-btn') as HTMLButtonElement | null;
  if (!btn) return;
  if (!recapState) { btn.hidden = true; return; }
  btn.hidden = false;
  if (btn.dataset.busy) return;
  const m = recapState.meeting;
  btn.textContent = m.exported_at ? '重新导出' : '导出知识库';
  btn.title = m.exported_at ? `上次导出 · ${fmtExportedAt(m.exported_at)}` : '';
  btn.disabled = false;
}
async function runVaultExport(seq: number, bodyEl: HTMLElement, meetingId: string): Promise<void> {
  if (!recapState || !recapAlive(seq, bodyEl) || recapState.meeting.meeting_id !== meetingId) return;
  const btn = document.getElementById('recap-export-btn') as HTMLButtonElement | null;
  if (btn?.dataset.busy) return;
  if (btn) { btn.dataset.busy = '1'; btn.disabled = true; btn.textContent = '收集中…'; }
  try {
    const r = await publishEntityToVault({ mode: 'meeting', meetingId }, {
      concepts: false, // 单会议按需导出：跳过概念层 LLM 抽取（慢·且概念是跨文档的，单次触发意义不大）
    });
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
    if (!r.ok) {
      await infoSheet({ title: r.entityEmpty ? '没有可导出内容' : '导出知识库失败', message: r.error || '未知错误' });
      return;
    }
    const fresh = await getMeeting(meetingId); // 刷新 exported_at（同思路总结的刷新模式·不重 loadRecapView）
    if (fresh && recapAlive(seq, bodyEl) && recapState && recapState.meeting.meeting_id === meetingId) {
      recapState.meeting = fresh;
      renderRecap(bodyEl);
    }
  } finally {
    if (btn) { delete btn.dataset.busy; btn.disabled = false; }
    if (recapAlive(seq, bodyEl)) updateExportButton();
  }
}
/** 顶栏导出按钮是静态 DOM（不随 renderRecap 重建），每次 loadRecapView 用 onclick 幂等重绑一次即可。 */
function wireRecapExportButton(): void {
  const btn = document.getElementById('recap-export-btn');
  if (!btn) return;
  btn.onclick = () => {
    if (!recapState) return;
    void runVaultExport(recapLoadSeq, recapState.bodyEl, recapState.meeting.meeting_id);
  };
}

type StoredPanelSummaryStatus = NonNullable<PersistedMeeting['panel_summary_status']>;
function normalizePanelSummaryStatus(status: PanelMeetingSummaryStatus): PanelMeetingSummaryStatus {
  return status === 'missing_minute' ? 'not_generated' : status;
}

function toStoredPanelSummaryStatus(status: PanelMeetingSummaryStatus): StoredPanelSummaryStatus {
  const normalized = normalizePanelSummaryStatus(status);
  if (normalized === 'ready' || normalized === 'not_generated' || normalized === 'transcript_not_ready' || normalized === 'not_found') return normalized;
  return 'failed'; // 'failed' 外的取数态都落库，下次进 recap 直接显示而非永远 loading。
}

/**
 * 按 feishu_meeting_id 拉 panel 五要素总结、写入本地缓存。事件消费(summary_ready)与 recap 内共用。
 * 远端拉取失败 / 本地写失败都会抛 —— 由调用方决定 best-effort（吞掉下次再拉）还是中断（不推 cursor）。
 */
export async function refreshPanelSummaryCache(m: PersistedMeeting): Promise<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }> {
  if (!m.feishu_meeting_id) {
    await updateMeeting(m.meeting_id, { panel_summary_status: 'not_generated' });
    return { status: 'not_generated', summary: null };
  }
  const r = await getPanelMeetingSummary(m.feishu_meeting_id);
  const normalized = { ...r, status: normalizePanelSummaryStatus(r.status) };
  const fetchedAt = new Date().toISOString();
  if (normalized.summary) await updateMeeting(m.meeting_id, { panel_summary: normalized.summary, panel_summary_fetched_at: fetchedAt, panel_summary_status: 'ready' });
  else await updateMeeting(m.meeting_id, { panel_summary_fetched_at: fetchedAt, panel_summary_status: toStoredPanelSummaryStatus(normalized.status) });
  return normalized;
}

/** L5：recap 内异步拉 panel 总结、拉到后按当前 view 重渲。失败标 failed（best-effort·不影响时间线）。 */
async function loadPanelSummary(seq: number, bodyEl: HTMLElement, m: PersistedMeeting): Promise<void> {
  try {
    const r = await refreshPanelSummaryCache(m);
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== m.meeting_id) return;
    recapState.panelSummary = r.summary ?? recapState.panelSummary;
    recapState.panelSummaryStatus = r.summary ? 'ready' : r.status;
  } catch (error) {
    // codex 扫描出的真 bug：漏了这条守卫时，A 会议请求晚到失败会污染此刻正在看的 B 会议的状态。
    if (recapAlive(seq, bodyEl) && recapState && recapState.meeting.meeting_id === m.meeting_id) {
      recapState.panelSummaryStatus = isFeishuReloginError(error)
        ? 'auth_required'
        : recapState.panelSummary || buildLocalPanelSummaryPreview() ? 'local_preview' : 'failed';
      recapState.panelSummaryError = String((error as Error)?.message || error);
    }
  }
  if (!recapAlive(seq, bodyEl)) return;
  if (recapState?.view === 'panel') renderRecap(bodyEl);
  else refreshRecapOverviewBlocks(bodyEl, ['#rc-over-focus', '#rc-panel-block']);
}

/** L5：用户点「生成总结」→ POST 触发 panel 现总结（M3·几秒~十几秒·panel 侧 in-flight 去重）。 */
async function generatePanelSummary(seq: number, bodyEl: HTMLElement, localMeetingId: string): Promise<void> {
  const m = recapState?.meeting;
  if (!m?.feishu_meeting_id || !recapAlive(seq, bodyEl) || m.meeting_id !== localMeetingId || !recapState) return;
  const panelMeetingId = m.feishu_meeting_id;
  recapState.panelSummaryStatus = 'generating';
  renderRecap(bodyEl);
  try {
    const r = await generatePanelMeetingSummary(panelMeetingId);
    // 串会守卫：生成期间快速切到别的会议 recap，晚到结果不能覆盖当前 state。
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== localMeetingId) return;
    recapState.panelSummary = r.summary ?? null;
    recapState.panelSummaryStatus = r.summary ? 'ready' : r.status;
    if (r.summary) await updateMeeting(localMeetingId, { panel_summary: r.summary, panel_summary_fetched_at: new Date().toISOString(), panel_summary_status: 'ready' });
  } catch (e) {
    if (recapAlive(seq, bodyEl) && recapState) recapState.panelSummaryStatus = 'failed';
    await infoSheet({ title: '生成 InkLoop 总结失败', message: String((e as Error)?.message || e) });
  }
  if (recapAlive(seq, bodyEl)) renderRecap(bodyEl);
}

type CappedTranscript = { lines: string[]; truncated: boolean; usedCueCount: number };
function cappedTranscriptLines(cues: TranscriptCue[]): CappedTranscript {
  const lines: string[] = [];
  let used = 0; let usedCueCount = 0; let truncated = false;
  for (const cue of cues) {
    const row = `[${clk(cue.startMs)}]${cue.speaker ? cue.speaker + '：' : ''}${cue.text}`;
    if (used + row.length > SUMMARY_TRANSCRIPT_CAP) {
      lines.push(`…（转写在此截断·后 ${cues.length - usedCueCount} 句未提供·别对未提供部分下结论）`);
      truncated = true;
      break;
    }
    lines.push(row);
    used += row.length;
    usedCueCount++;
  }
  return { lines, truncated, usedCueCount };
}

const PROVIDER_SUMMARY_OCR_TIMEOUT_MS = 10_000;

async function awaitProviderSummaryBoardOcr(meetingId: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      triggerBoardOcr(`mtgboard_${meetingId}`).then(() => 'finished' as const, () => 'finished' as const),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), PROVIDER_SUMMARY_OCR_TIMEOUT_MS); }),
    ]);
    return outcome === 'timeout';
  } catch {
    return false; // OCR 已经失败且不再 in-flight，不阻断总结。
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function hasPendingProviderSummaryBoardOcr(marks: PersistedMark[]): boolean {
  return marks.some((mark) => !mark.is_tombstone
    && (mark.feature_type === 'handwriting' || mark.feature_type === 'drawing')
    && !mark.ocr_fingerprint
    && (mark.strokes ?? []).some((stroke) => stroke.points.length > 0));
}

type ProviderSummaryPlatform = 'google_meet' | 'zoom';

function sameGoogleOccurrence(left: Pick<PersistedMeeting, 'scheduled_at'>, rightToken: string): boolean {
  return providerOccurrenceToken(left.scheduled_at) === rightToken;
}

function sameProviderSummaryOccurrence(
  current: PersistedMeeting,
  platform: ProviderSummaryPlatform,
  occurrenceToken: string,
): boolean {
  if (meetingPlatformOf(current) !== platform) return false;
  return platform === 'zoom'
    ? sameZoomOccurrence(current, occurrenceToken)
    : sameGoogleOccurrence(current, occurrenceToken);
}

async function persistProviderPanelSummaryFailure(
  meetingId: string,
  platform: ProviderSummaryPlatform,
  occurrenceToken: string,
): Promise<boolean> {
  let occurrenceCurrent = false;
  await mutateMeeting(meetingId, (current) => {
    if (!sameProviderSummaryOccurrence(current, platform, occurrenceToken)) return null;
    occurrenceCurrent = true;
    return { panel_summary_status: 'failed' };
  });
  return occurrenceCurrent;
}

interface ProviderPanelSummaryRequestResult {
  summary: PanelMeetingSummaryRecord | null;
  failurePersisted: boolean;
  platform: ProviderSummaryPlatform;
  occurrenceToken: string;
}

/** Provider 路线的纯数据生成入口：已有结果直接复用，同一会议并发请求共享一个 in-flight Promise。 */
export async function ensureProviderPanelSummary(m: PersistedMeeting, cues: TranscriptCue[]): Promise<PanelMeetingSummaryRecord | null> {
  if (m.panel_summary) return m.panel_summary;
  if (!cues.length) return null;
  const platform = meetingPlatformOf(m);
  if (platform !== 'google_meet' && platform !== 'zoom') return null;
  const occurrenceToken = providerOccurrenceToken(m.scheduled_at);
  const transcriptToken = providerTranscriptCacheToken(platform, m.meeting_id, occurrenceToken);
  const inFlightKey = `${transcriptToken}:${occurrenceToken}`;
  const running = providerPanelSummaryInFlight.get(inFlightKey);
  if (running) return running;
  const task = (async (): Promise<PanelMeetingSummaryRecord | null> => {
    const boardDocumentId = `mtgboard_${m.meeting_id}`;
    const ocrTimedOut = await awaitProviderSummaryBoardOcr(m.meeting_id);
    const marks = await getFoldedMarksByContext(`mtg_${m.meeting_id}`)
      .then((items) => items.filter((mark) => !mark.is_tombstone));
    if (ocrTimedOut && isBoardOcrInFlight(boardDocumentId) && hasPendingProviderSummaryBoardOcr(marks)) return null;
    const handwritingSections = buildMeetingHandwritingSections(m, marks, meetingT0(m), finiteMs(m.align_offset_ms));
    const capped = cappedTranscriptLines(cues);
    const response = await postJson<ProviderMeetingSummaryResponse>('/api/meetings/summary', {
      platform,
      title: m.title || '(未命名会议)',
      transcript: capped.lines.join('\n'),
      ...(platform === 'google_meet' && m.google_smart_note?.text ? { smart_note: m.google_smart_note.text } : {}),
      ...(hasMeetingHandwritingSections(handwritingSections) ? { handwriting_sections: handwritingSections } : {}),
      model: settings.inferModel,
    }, { auth: true });
    const summary: PanelMeetingSummaryRecord = {
      minute_token: transcriptToken,
      meeting_id: m.provider_meeting_id || m.calendar_meeting_no || m.provider_space_name || m.meeting_id,
      topic: m.title,
      generated_at: Date.now(),
      model: response.model,
      summary: response.summary,
    };
    const patch: Partial<PersistedMeeting> = {
      panel_summary: summary,
      panel_summary_fetched_at: new Date().toISOString(),
      panel_summary_status: 'ready',
    };
    if (platform === 'zoom') {
      let occurrenceCurrent = false;
      await mutateMeeting(m.meeting_id, (current) => {
        if (!sameZoomOccurrence(current, occurrenceToken)) return null;
        occurrenceCurrent = true;
        return patch;
      });
      if (!occurrenceCurrent) return null;
    } else {
      await updateMeeting(m.meeting_id, patch);
    }
    return summary;
  })();
  providerPanelSummaryInFlight.set(inFlightKey, task);
  try {
    return await task;
  } finally {
    if (providerPanelSummaryInFlight.get(inFlightKey) === task) providerPanelSummaryInFlight.delete(inFlightKey);
  }
}

/** 兼容现有 Google 调用与外部测试；实现统一走 provider-neutral 端点。 */
export function ensureGooglePanelSummary(m: PersistedMeeting, cues: TranscriptCue[]): Promise<PanelMeetingSummaryRecord | null> {
  return ensureProviderPanelSummary(m, cues);
}

export async function requestProviderPanelSummary(
  m: PersistedMeeting,
  cues: TranscriptCue[],
): Promise<ProviderPanelSummaryRequestResult | null> {
  const platform = meetingPlatformOf(m);
  if (platform !== 'google_meet' && platform !== 'zoom') return null;
  const occurrenceToken = providerOccurrenceToken(m.scheduled_at);
  try {
    return {
      summary: await ensureProviderPanelSummary(m, cues),
      failurePersisted: false,
      platform,
      occurrenceToken,
    };
  } catch {
    return {
      summary: null,
      failurePersisted: await persistProviderPanelSummaryFailure(m.meeting_id, platform, occurrenceToken).catch(() => false),
      platform,
      occurrenceToken,
    };
  }
}

async function loadProviderPanelSummary(seq: number, bodyEl: HTMLElement, m: PersistedMeeting, cues: TranscriptCue[]): Promise<void> {
  if (m.panel_summary || !cues.length) return;
  if (recapAlive(seq, bodyEl) && recapState?.meeting.meeting_id === m.meeting_id) {
    recapState.panelSummaryStatus = 'generating';
    renderRecap(bodyEl);
  }
  const result = await requestProviderPanelSummary(m, cues);
  if (!result) return;
  if (result.summary) {
    if (!recapAlive(seq, bodyEl) || recapState?.meeting.meeting_id !== m.meeting_id) return;
    recapState.panelSummary = result.summary;
    recapState.meeting = { ...recapState.meeting, panel_summary: result.summary, panel_summary_status: 'ready' };
    recapState.panelSummaryStatus = 'ready';
  } else if (result.failurePersisted) {
    if (recapAlive(seq, bodyEl)
      && recapState?.meeting.meeting_id === m.meeting_id
      && sameProviderSummaryOccurrence(recapState.meeting, result.platform, result.occurrenceToken)) {
      recapState.panelSummaryStatus = 'failed';
    }
  } else {
    return;
  }
  if (recapAlive(seq, bodyEl)) renderRecap(bodyEl);
}

function uniqText(items: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const textValue = raw.trim();
    if (!textValue || seen.has(textValue)) continue;
    seen.add(textValue);
    out.push(textValue);
    if (out.length >= limit) break;
  }
  return out;
}

function linesBetween(lines: string[], start: string, stops: string[]): string[] {
  const i = lines.findIndex((line) => line === start);
  if (i < 0) return [];
  const end = lines.findIndex((line, idx) => idx > i && stops.includes(line));
  return lines.slice(i + 1, end > i ? end : lines.length).filter(Boolean);
}

function stripOwners(textValue: string): { text: string; owner: string } {
  const owners = [...textValue.matchAll(/@([^\s@]+)/g)].map((m) => m[1]).filter(Boolean);
  return {
    text: textValue.replace(/\s*@([^\s@]+)/g, '').trim(),
    owner: owners.length ? owners.join('、') : '未指定',
  };
}

function buildLocalPanelSummaryPreview(): PanelMeetingSummaryRecord | null {
  if (!recapState) return null;
  const m = recapState.meeting;
  const platform = meetingPlatformOf(m);
  if (platform !== 'lark' && platform !== 'google_meet') return null;
  const rec = recapState.feishuSummary ?? m.feishu_note_summary ?? null;
  const lines = rec?.content ? feishuLines(rec.content).filter(Boolean) : [];
  if (!lines.length && !recapState.cues.length) return null;

  const todoLines = linesBetween(lines, '待办', ['会议最佳表现成员', '相关链接', '相关会议纪要']);
  const actionItems = todoLines
    .map((line) => splitKvLine(line))
    .filter((kv): kv is { k: string; v: string } => !!kv)
    .slice(0, 6)
    .map((kv) => {
      const parsed = stripOwners(kv.v);
      return { task: `${kv.k}：${parsed.text}`, owner: parsed.owner };
    });

  const conclusionPrefixes = ['主要问题', '方案选择', '开发板选择', '组件选择', '方案优势', '产品推广', '阶段安排', '软件需求'];
  const conclusions = uniqText(lines
    .filter((line) => conclusionPrefixes.some((prefix) => line.startsWith(prefix + '：')))
    .map((line) => line.replace(/^[^：]{2,18}：/, '').trim()), 5);
  if (!conclusions.length) {
    const firstSummary = lines.find((line) => line.length > 28 && !line.startsWith('智能会议纪要由 AI') && !FEISHU_META_RE.test(line) && !isFeishuImageRef(line));
    if (firstSummary) conclusions.push(firstSummary);
  }
  if (!conclusions.length && recapState.cues.length) {
    const text = recapState.cues.slice(0, 4).map((cue) => cue.text).filter(Boolean).join(' ');
    if (text) conclusions.push(text.length > 140 ? text.slice(0, 140) + '…' : text);
  }

  const risks = uniqText(lines
    .filter((line) => /(问题|风险|不确定|难度|不可靠|不能|不适合|麻烦|保密|未给出|需要验证)/.test(line))
    .filter((line) => !isFeishuImageRef(line))
    .map((line) => line.replace(/^[^：]{2,18}：/, '').trim()), 4);

  const openQuestions = uniqText(lines
    .filter((line) => /(能否|是否|待确认|需验证|考虑|未给出)/.test(line))
    .map((line) => line.replace(/^[^：]{2,18}：/, '').trim()), 3);

  const nextSteps = uniqText([
    ...actionItems.map((item) => item.task),
    ...linesBetween(lines, '后续工作计划', ['待办', '会议最佳表现成员', '相关链接']).map((line) => line.replace(/^[^：]{2,18}：/, '').trim()),
  ], 5);

  return {
    minute_token: `local_feishu_note:${m.feishu_meeting_id || m.meeting_id}`,
    meeting_id: m.feishu_meeting_id || m.meeting_id,
    topic: m.feishu_topic || m.title,
    generated_at: Date.now(),
    model: 'local-feishu-note',
    summary: {
      conclusions: conclusions.length
        ? conclusions
        : [lines.length ? '已同步飞书智能纪要；Panel 后处理服务未连接时，先提供本地结构化预览。' : '已同步飞书原始文字记录；Panel 后处理服务未连接时，先提供本地结构化预览。'],
      action_items: actionItems,
      risks,
      open_questions: openQuestions,
      next_steps: nextSteps,
    },
  };
}

/** L5：InkLoop 五要素总结块（左侧 nav「InkLoop」入口整页「会议讲了什么」·和时间脊「我何时写了什么」互补）。 */
function panelSummaryHtml(): string {
  if (!recapState) return '';
  const fallback = buildLocalPanelSummaryPreview();
  const rec = recapState.panelSummary ?? fallback;
  const status = recapState.panelSummaryStatus === 'missing_minute' ? 'not_generated' : recapState.panelSummaryStatus;
  const box = (inner: string): string => `<div class="rc-psum">${inner}</div>`;
  if (rec?.summary) {
    const local = rec === fallback && !recapState.panelSummary;
    const s = rec.summary;
    const blk = (label: string, items: string[]): string => items.length
      ? `<div class="rc-blk"><span class="rc-blk-h">${label}</span>${items.map((x) => `<span class="rc-blk-li">${esc(x)}</span>`).join('')}</div>` : '';
    const ai = s.action_items.length
      ? `<div class="rc-blk"><span class="rc-blk-h">行动项</span>${s.action_items.map((a) => `<span class="rc-blk-li">${esc(a.task)}${a.owner && a.owner !== '未指定' ? `<span class="who">${esc(a.owner)}</span>` : ''}${a.due ? `<span class="who">${esc(a.due)}</span>` : ''}</span>`).join('')}</div>`
      : '';
    return box(`<div class="rc-psum-h"><b>${local ? 'InkLoop 后处理预览' : 'InkLoop AI 总结'} · 会议讲了什么</b>${rec.model ? `<span class="mdl">${esc(rec.model)}</span>` : ''}</div>`
      + (local ? '<div class="rc-local-note">Panel 后处理服务当前不可用，先基于飞书智能纪要与原始文字记录生成本地结构化预览；服务恢复后会替换为正式结果。</div>' : '')
      + blk('结论', s.conclusions) + ai + blk('风险', s.risks) + blk('待决', s.open_questions) + blk('后续', s.next_steps));
  }
  const platform = meetingPlatformOf(recapState.meeting);
  if (platform === 'microsoft_teams' || platform === 'manual') {
    return box('该来源暂不支持远端总结生成。');
  }
  if (status === 'transcript_not_ready') return box('用于生成总结的转写还在生成中（飞书会后文字记录或妙记还在生成）。就绪后会自动生成 InkLoop 总结，也可以稍后手动重试。<button class="hbtn rc-psum-retry" id="ps-gen">重试</button>');
  if (status === 'loading' || status === 'generating') return box(status === 'generating' ? '正在生成 InkLoop 总结…（读取完整转写，稍候）' : '正在拉取 InkLoop 总结…');
  if (status === 'failed') return box('拉取 InkLoop 总结失败（网络/服务波动）。<button class="hbtn rc-psum-retry" id="ps-refresh">刷新重试</button>');
  if (status === 'auth_required') return box('需要重新登录飞书后才能读取 InkLoop 总结。<button class="hbtn rc-psum-retry" id="ps-login">重新登录飞书</button><button class="hbtn rc-psum-retry" id="ps-refresh">重试</button>');
  if (status === 'not_found') return box('InkLoop 没找到这场会议（可能关联错了，可回上一页改关联）。<button class="hbtn rc-psum-retry" id="ps-refresh">刷新</button>');
  // not_generated → 可主动触发生成
  return box('InkLoop 还没生成这场会议的结构化总结。<button class="hbtn rc-psum-retry" id="ps-gen">生成总结</button>');
}

/** 绑定 panel 总结块的按钮（生成 / 刷新重试）——正常态与空态共用。 */
function wirePanelSummaryButtons(bodyEl: HTMLElement): void {
  bodyEl.querySelector('#ps-login')?.addEventListener('click', () => {
    void promptFeishuRelogin(recapState?.panelSummaryError || '当前飞书身份不可用。');
  });
  bodyEl.querySelector('#ps-gen')?.addEventListener('click', () => { // 生成总结（Google/Zoom 走 hub；飞书走 panel）
    if (!recapState) return;
    switch (meetingPlatformOf(recapState.meeting)) {
      case 'google_meet':
      case 'zoom':
        void loadProviderPanelSummary(recapLoadSeq, bodyEl, recapState.meeting, recapState.cues);
        break;
      case 'lark':
        void generatePanelSummary(recapLoadSeq, bodyEl, recapState.meeting.meeting_id);
        break;
      case 'microsoft_teams':
      case 'manual':
        break;
    }
  });
  bodyEl.querySelector('#ps-refresh')?.addEventListener('click', () => { // 失败/未找到时重拉
    if (!recapState) return;
    switch (meetingPlatformOf(recapState.meeting)) {
      case 'google_meet':
      case 'zoom':
        void loadProviderPanelSummary(recapLoadSeq, bodyEl, recapState.meeting, recapState.cues);
        break;
      case 'lark':
        recapState.panelSummaryStatus = 'loading';
        renderRecap(bodyEl);
        void loadPanelSummary(recapLoadSeq, bodyEl, recapState.meeting);
        break;
      case 'microsoft_teams':
      case 'manual':
        break;
    }
  });
}

/** 左侧 nav「InkLoop」入口整页。 */
function renderRecapPanelPage(bodyEl: HTMLElement): void {
  if (!recapState) return;
  bodyEl.innerHTML = panelSummaryHtml();
  wirePanelSummaryButtons(bodyEl);
}

function cueExcerpt(cues: TranscriptCue[]): string {
  let best = cues[0];
  for (const cue of cues) if ((cue.text || '').length > (best?.text || '').length) best = cue;
  const chars = [...(best?.text || '').trim()];
  if (!chars.length) return '（这一段暂无可展示文字）';
  return chars.length > 72 ? chars.slice(0, 72).join('') + '…' : chars.join('');
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function meetingDurationLabel(m: PersistedMeeting, cues: TranscriptCue[]): string {
  if (cues.length) {
    const first = cues[0];
    const last = cues[cues.length - 1] || first;
    return fmtDuration(Math.max(0, (last?.endMs ?? 0) - (first?.startMs ?? 0)));
  }
  const start = meetingT0(m) || Date.parse(m.started_at || m.scheduled_at || '');
  const end = m.ended_at ? Date.parse(m.ended_at) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? fmtDuration(end - start) : '-';
}

function panelSummaryLabel(): string {
  if (!recapState) return '待同步';
  if (recapState.panelSummary) return '已生成';
  if (buildLocalPanelSummaryPreview()) return '本地预览';
  const platform = meetingPlatformOf(recapState.meeting);
  if (platform === 'microsoft_teams' || platform === 'manual') return '暂不支持';
  if (recapState.panelSummaryStatus === 'generating') return '生成中';
  if (recapState.panelSummaryStatus === 'auth_required') return '需重新登录';
  if (recapState.panelSummaryStatus === 'failed') return '待重试';
  if (recapState.panelSummaryStatus === 'not_generated' || recapState.panelSummaryStatus === 'missing_minute') return '待生成';
  if (recapState.panelSummaryStatus === 'transcript_not_ready') return '转写生成中';
  return '同步中';
}

function overviewConclusionItems(): string[] {
  if (!recapState) return [];
  const panel = recapState.panelSummary ?? buildLocalPanelSummaryPreview();
  const fromPanel = panel?.summary.conclusions?.filter(Boolean).slice(0, 3) ?? [];
  if (fromPanel.length) return fromPanel;
  if (recapState.meeting.summary?.trim()) {
    return recapState.meeting.summary
      .split(/\n+/)
      .map((line) => line.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 3);
  }
  const platform = meetingPlatformOf(recapState.meeting);
  const rec = platform === 'lark' || platform === 'google_meet'
    ? recapState.feishuSummary ?? recapState.meeting.feishu_note_summary ?? null
    : null;
  if (rec?.content) {
    return feishuLines(rec.content)
      .filter((line) => line.length > 20 && !FEISHU_META_RE.test(line) && !isFeishuImageRef(line))
      .slice(0, 2);
  }
  if (recapState.cues.length) return [cueExcerpt(recapState.cues.slice(0, Math.min(6, recapState.cues.length)))];
  return [];
}

interface OverviewCardAction { command: string; label: string; primary?: boolean }
function overviewCardHtml(opts: { action: string; title: string; meta: string; body: string; disabled?: boolean; actions?: OverviewCardAction[] }): string {
  const id = `rc-${opts.action}-block`;
  if (opts.actions?.length) {
    return `<section class="rc-entry" id="${id}">`
      + `<span class="rc-entry-top"><b>${esc(opts.title)}</b><span>${esc(opts.meta)}</span></span>`
      + `<span class="rc-entry-body">${esc(opts.body)}</span>`
      + `<span class="rc-entry-actions">${opts.actions.map((action) => `<button class="hbtn${action.primary ? ' pri' : ''}" data-rc-command="${esc(action.command)}">${esc(action.label)}</button>`).join('')}</span>`
      + `</section>`;
  }
  const disabled = opts.disabled ? ' disabled aria-disabled="true"' : '';
  return `<button class="rc-entry${opts.disabled ? ' is-disabled' : ''}" id="${id}" type="button" data-rc-open="${esc(opts.action)}"${disabled}>`
    + `<span class="rc-entry-top"><b>${esc(opts.title)}</b><span>${esc(opts.meta)}</span></span>`
    + `<span class="rc-entry-body">${esc(opts.body)}</span>`
    + `<span class="rc-entry-go">${opts.disabled ? '暂无内容' : '进入 ›'}</span>`
    + `</button>`;
}

export function googleSmartNoteCardState(meeting: Pick<PersistedMeeting, 'google_smart_note' | 'google_smart_note_scope_missing'>): {
  meta: string; body: string; disabled: boolean;
} {
  if (meeting.google_smart_note?.text.trim()) {
    return { meta: '已同步', body: '查看 Gemini 官方智能纪要纯文本。', disabled: false };
  }
  if (meeting.google_smart_note_scope_missing) {
    return { meta: '需要授权', body: '需要重新授权 Google（新增 Drive 读取权限）', disabled: true };
  }
  return { meta: '未接入', body: 'Google 智能纪要（Gemini）接入后会显示在这里。', disabled: true };
}

export function googleRecordingLinks(meeting: Pick<PersistedMeeting, 'google_recordings'>): Array<{ export_uri: string; state: string }> {
  return (meeting.google_recordings || []).filter((recording) => !!recording.export_uri?.trim());
}

export function renderGoogleRecordingsHtml(meeting: Pick<PersistedMeeting, 'google_recordings'>): string {
  const recordings = googleRecordingLinks(meeting);
  if (!recordings.length) return '';
  return `<div class="rc-recordings"><span>会议录像</span>`
    + recordings.map((recording, index) => `<a href="${esc(recording.export_uri)}" target="_blank" rel="noopener">${recordings.length > 1 ? `录像 ${index + 1} · ` : ''}在 Google Drive 查看</a>`).join('')
    + `</div>`;
}

export function zoomTranscriptAlignmentLabel(timestampQuality?: ZoomTimestampQuality): string {
  return timestampQuality === 'approximate_pause_unknown'
    ? '时间为近似（录制中断未校准）'
    : 'Zoom 场次时间对齐';
}

export function renderProviderParticipantsOverview(
  meeting: Pick<PersistedMeeting, 'provider_participants'>,
): string {
  const participants = aggregateProviderParticipants(meeting.provider_participants);
  if (!participants.length) return '';
  const lines = providerParticipantLines(meeting.provider_participants)
    .map((line) => `<span class="rc-participant-li">${esc(line)}</span>`).join('');
  return `<section class="rc-over-participants" id="rc-participants"><div class="rc-sec-title"><b>参会（${participants.length} 人）</b></div><div class="rc-participant-list">${lines}</div></section>`;
}

/** 概览：会后第一屏。只放核心状态和入口；长转写进入「原始发言」详情页。 */
function renderRecapOverview(bodyEl: HTMLElement): void {
  if (!recapState) return;
  const { meeting, cues } = recapState;
  const platform = meetingPlatformOf(meeting);
  const google = platform === 'google_meet';
  const lark = platform === 'lark';
  const zoom = platform === 'zoom';
  const title = (lark || google ? meeting.feishu_topic : '') || meeting.title || '会议';
  const speakerCount = new Set(cues.map((cue) => cue.speaker || '').filter(Boolean)).size;
  const inkPages = meetingNotePages(recapState);
  const inkCount = inkPages.reduce((sum, page) => sum + page.marks.length, 0);
  const markSource = recapState.markSourceMeeting && recapState.markSourceMeeting.meeting_id !== meeting.meeting_id
    ? ` · 来自${recapState.markSourceMeeting.feishu_topic || recapState.markSourceMeeting.title || '相近会议'}`
    : '';
  const smartNoteCard = googleSmartNoteCardState(meeting);
  const feishuReady = !!(recapState.feishuSummary?.content || meeting.feishu_note_summary?.content);
  const conclusions = overviewConclusionItems();
  const conclusionHtml = conclusions.length
    ? conclusions.map((item) => `<span class="rc-over-li">${esc(item)}</span>`).join('')
    : `<span class="rc-over-empty">${google || zoom
      ? '原始发言同步后，这里会出现会议要点。'
      : lark
        ? '飞书原始发言或智能纪要同步后，这里会出现会议要点。'
        : '该来源的转写接入后，这里会出现会议要点。'}</span>`;
  const transcript = recapState.transcriptLoad;
  const rawMeta = cues.length ? `${cues.length} 句 · ${speakerCount || '未知'} 人` : transcript.status === 'loading' ? '拉取中' : transcript.status === 'auth_required' ? '需重新登录' : transcript.status === 'failed' ? '拉取失败' : '无转写';
  const rawBody = cues.length ? cueExcerpt(cues.slice(0, Math.min(cues.length, 8))) : transcript.message;
  const transcriptActions: OverviewCardAction[] | undefined = transcript.status === 'auth_required' && lark
    ? [{ command: 'feishu-login', label: '重新登录飞书', primary: true }, { command: 'retry-transcript', label: '重试' }]
    : transcript.status === 'failed'
      ? [{ command: 'retry-transcript', label: '重试', primary: true }]
      : !hasRemoteTranscriptSource(meeting) && lark
        ? [{ command: 'associate', label: '关联飞书会议', primary: true }]
        : recapTranscriptRetryLabel(meeting)
          ? [{ command: 'retry-transcript', label: recapTranscriptRetryLabel(meeting)! }]
          : undefined;
  const note = recapState.noteLoad;
  const noteActions: OverviewCardAction[] | undefined = note.status === 'auth_required' && lark
    ? [{ command: 'feishu-login', label: '重新登录飞书', primary: true }, { command: 'retry-transcript', label: '重试' }]
    : note.status === 'failed'
      ? [{ command: 'retry-transcript', label: '重试', primary: true }]
      : undefined;
  const marks = recapState.marksLoad;
  const marksActions: OverviewCardAction[] | undefined = marks.status === 'failed'
    ? [{ command: 'retry-marks', label: '重试', primary: true }]
    : undefined;
  const inkBody = inkCount
    ? `共 ${inkCount} 处手写/圈画${markSource}，点击按屏查看原始发言和整页手写。`
    : '本场没有手写记录；如果会后补写，会自动归到这里。';
  const exportState = meeting.exported_at ? `已导出 ${fmtExportedAt(meeting.exported_at)}` : '未导出';
  const alignmentLabel = zoom && meeting.provider_transcript_status !== 'ready'
    ? '转写未就绪'
    : zoom && meeting.align_state === 'event'
      ? zoomTranscriptAlignmentLabel(recapState.providerTimestampQuality)
    : google && meeting.align_state === 'event'
    ? '场次真实时间对齐'
    : !lark && meeting.align_state === 'event'
      ? '平台事件时间对齐'
      : meeting.align_state ? ALIGN_LABEL[meeting.align_state] : '约对齐';
  const panelBody = !lark && !google && !zoom
    ? '该来源暂不支持远端总结生成。'
    : recapState.panelSummary
      ? '查看结构化结论、行动项、风险和后续，也可以从顶栏导出知识库。'
      : recapState.panelSummaryStatus === 'auth_required'
        ? '需要重新登录飞书后才能读取 InkLoop 总结。'
        : recapState.panelSummaryStatus === 'failed'
          ? '拉取 InkLoop 总结失败；进入后可重试。'
          : recapState.panelSummaryStatus === 'transcript_not_ready'
            ? '用于生成总结的转写还在生成，就绪后会自动生成。'
            : recapState.panelSummaryStatus === 'loading'
              ? '正在拉取 InkLoop 总结。'
              : '暂无 InkLoop 总结。';
  bodyEl.innerHTML = `<div class="rc-overview">`
    + `<section class="rc-over-hero" id="rc-over-hero">`
    + `<div><span class="rc-kicker">会后概览</span><h2>${esc(title)}</h2><p>${esc(fmtClock(meetingT0(meeting)) || fmtClock(Date.parse(meeting.scheduled_at)) || '时间未知')} · ${esc(meetingDurationLabel(meeting, cues))} · ${esc(alignmentLabel)}</p></div>`
    + `<div class="rc-metrics"><span><b>${cues.length || '-'}</b>句</span><span><b>${speakerCount || '-'}</b>人</span><span><b>${inkCount}</b>手写</span></div>`
    + (google ? renderGoogleRecordingsHtml(meeting) : '')
    + `</section>`
    + renderProviderParticipantsOverview(meeting)
    + `<section class="rc-over-focus" id="rc-over-focus"><div class="rc-sec-title"><b>会议要点</b><span>${esc(panelSummaryLabel())}</span></div><div class="rc-over-list">${conclusionHtml}</div></section>`
    + `<section class="rc-entry-grid">`
    + overviewCardHtml({ action: 'transcript', title: '原始发言', meta: rawMeta, body: rawBody, disabled: !cues.length && !transcriptActions && transcript.status !== 'loading', actions: transcriptActions })
    + (google
      ? overviewCardHtml({ action: 'feishu', title: '智能纪要', meta: note.status === 'loading' ? '拉取中' : smartNoteCard.meta, body: note.message, disabled: note.status !== 'ready' && !noteActions && note.status !== 'loading' && !meeting.google_smart_note?.text, actions: noteActions })
      : lark
        ? overviewCardHtml({ action: 'feishu', title: '飞书智能纪要', meta: feishuReady ? '已同步' : note.status === 'loading' ? '拉取中' : '无纪要', body: feishuReady ? '查看飞书官方会后纪要原文、图片和待办。' : note.message, disabled: !feishuReady && !noteActions && note.status !== 'loading', actions: noteActions })
        : overviewCardHtml({ action: 'feishu', title: '官方纪要', meta: '暂不支持', body: note.message, disabled: true }))
    + overviewCardHtml({ action: 'handwriting', title: '手写记录', meta: marks.status === 'loading' ? '读取中' : inkCount ? `${inkCount} 处${markSource}` : '0 处', body: marks.status === 'ready' || marks.status === 'missing' ? inkBody : marks.message, disabled: inkPages.length === 0 && !marksActions, actions: marksActions })
    + overviewCardHtml({ action: 'panel', title: 'InkLoop 后处理', meta: `${panelSummaryLabel()} · ${exportState}`, body: panelBody })
    + `</section>`
    + `</div>`;
  // 事件委托：一个 listener 挂在 .rc-overview 根上（局部块替换只换子块、不换根）。
  // 原来 per-卡片接线，加载期各异步完成不断 replaceWith 卡片节点：电纸屏上按下慢、
  // 恰好按在被替换节点上的点按会整个丢失（down 在旧节点、up 在新节点，click 派发不到卡片）——
  // 这就是「点卡片没反应」的来源之一。委托到不被替换的根上后点按稳定命中。
  const root = bodyEl.querySelector<HTMLElement>('.rc-overview');
  root?.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const opener = target?.closest<HTMLElement>('[data-rc-open]');
    if (opener) { handleRecapCardOpen(opener, bodyEl); return; }
    const commandEl = target?.closest<HTMLElement>('[data-rc-command]');
    if (commandEl?.dataset.rcCommand) handleRecapBlockCommand(commandEl.dataset.rcCommand, bodyEl);
  });
}

function handleRecapCardOpen(el: HTMLElement, bodyEl: HTMLElement): void {
  if (!recapState || el.hasAttribute('disabled')) return;
  const action = el.dataset.rcOpen;
  if (action === 'handwriting') {
    if (!meetingNotePages(recapState).length) return;
    recapState.view = 'detail'; recapState.detailIdx = 0; recapState.dtPage = 0;
  } else if (action === 'transcript' || action === 'feishu' || action === 'panel' || action === 'summary') {
    recapState.view = action;
  } else return;
  renderRecap(bodyEl);
  bodyEl.scrollTop = 0;
  updateRecapNav();
}

function handleRecapBlockCommand(command: string, bodyEl: HTMLElement): void {
  if (!recapState) return;
  if (command === 'feishu-login') {
    void promptFeishuRelogin('当前飞书身份不可用。');
  } else if (command === 'retry-transcript') {
    recapState.transcriptLoad = { status: 'loading', message: '正在重新拉取转写…' };
    recapState.noteLoad = { status: 'loading', message: '正在重新拉取官方纪要…' };
    refreshRecapOverviewBlocks(bodyEl, ['#rc-transcript-block', '#rc-feishu-block']);
    void refreshTranscriptAfterInitialRender(recapLoadSeq, bodyEl, recapState.meeting.meeting_id);
  } else if (command === 'retry-marks') {
    recapState.marksLoad = { status: 'loading', message: '正在重新读取本机手写档案…' };
    refreshRecapOverviewBlocks(bodyEl, ['#rc-handwriting-block']);
    void loadRecapMarksAfterInitialRender(recapLoadSeq, bodyEl, recapState.meeting);
  } else if (command === 'associate') {
    const meeting = recapState.meeting;
    void (async () => {
      if (await associate(meeting) && recapAlive(recapLoadSeq, bodyEl)) {
        void loadRecapView(meeting.meeting_id, bodyEl, document.getElementById('recap-title') as HTMLElement);
      }
    })();
  }
}

function refreshRecapOverviewBlocks(bodyEl: HTMLElement, selectors: string[]): void {
  if (!recapState || recapState.view !== 'overview') return;
  const draft = document.createElement('div');
  renderRecapOverview(draft);
  for (const selector of selectors) {
    const current = bodyEl.querySelector(selector);
    const replacement = draft.querySelector(selector);
    // 内容没变就不动 DOM：少一次节点替换=少一次丢点按窗口+少一次电纸屏闪刷
    if (current && replacement && current.outerHTML !== replacement.outerHTML) current.replaceWith(replacement);
    else if (selector === '#rc-participants' && current && !replacement) current.remove();
    else if (selector === '#rc-participants' && !current && replacement) bodyEl.querySelector('#rc-over-focus')?.before(replacement);
  }
}

function meetingNotePages(state: RecapV2): MeetingInkPage[] {
  const marks = [...state.marksById.values()]
    .filter((mark) => !mark.is_tombstone && hasMeetingInk(mark))
    .sort((a, b) => (a.page_index - b.page_index) || (markTime(a) - markTime(b)) || (a.seq - b.seq));
  const boardId = `mtgboard_${state.markSourceMeeting?.meeting_id ?? state.meeting.meeting_id}`;
  const boardMarks = marks.filter((mark) => mark.document_id === boardId || mark.document_id.startsWith('mtgboard_'));
  const scopedMarks = boardMarks.length ? boardMarks : marks;
  const byPage = new Map<string, MeetingInkPage>();
  for (const mark of scopedMarks) {
    const pageIndex = mark.page_index ?? 0;
    const key = `${mark.document_id || 'meeting'}:${pageIndex}`;
    const page = byPage.get(key) ?? { documentId: mark.document_id || 'meeting', pageIndex, marks: [] };
    page.marks.push(mark);
    byPage.set(key, page);
  }
  return [...byPage.values()].sort((a, b) => {
    const aw = a.documentId === boardId ? 0 : a.documentId.startsWith('mtgboard_') ? 1 : 2;
    const bw = b.documentId === boardId ? 0 : b.documentId.startsWith('mtgboard_') ? 1 : 2;
    return (aw - bw) || (a.pageIndex - b.pageIndex) || b.marks.length - a.marks.length || a.documentId.localeCompare(b.documentId);
  });
}

const DETAIL_CUES_PER_SCREEN = 8;
const INK_CUE_PRE_MS = 30_000;
const INK_CUE_POST_MS = 45_000;
const INK_TIME_PLAUSIBLE_PRE_MS = 10 * 60_000;
const INK_TIME_PLAUSIBLE_POST_MS = 30 * 60_000;

interface InkPageTranscriptSelection {
  cues: TranscriptCue[];
  meta: string;
  source: 'time' | 'page_order' | 'empty' | 'pre_meeting' | 'post_meeting';
}

function cueDurationMs(cues: TranscriptCue[]): number {
  return cues.reduce((max, cue) => Math.max(max, cue.endMs), 0);
}

function nearestCues(cues: TranscriptCue[], centerMs: number, limit: number): TranscriptCue[] {
  return [...cues]
    .sort((a, b) => {
      const ac = (a.startMs + a.endMs) / 2;
      const bc = (b.startMs + b.endMs) / 2;
      return Math.abs(ac - centerMs) - Math.abs(bc - centerMs) || a.startMs - b.startMs;
    })
    .slice(0, limit)
    .sort((a, b) => a.startMs - b.startMs);
}

function pageOrderCues(cues: TranscriptCue[], pageIndex: number, totalPages: number, limit: number): TranscriptCue[] {
  if (!cues.length) return [];
  const safeTotal = Math.max(1, totalPages);
  const center = ((pageIndex + 0.5) / safeTotal) * cues.length;
  const start = Math.max(0, Math.min(cues.length - limit, Math.round(center - limit / 2)));
  return cues.slice(start, start + limit);
}

function cueIndexRange(cues: TranscriptCue[], selected: TranscriptCue[]): string {
  if (!selected.length) return '无匹配发言';
  const start = selected[0].index || cues.indexOf(selected[0]) + 1;
  const end = selected[selected.length - 1].index || cues.indexOf(selected[selected.length - 1]) + 1;
  return `${start}-${end} / ${cues.length}`;
}

export function selectInkPageTranscriptCues(input: {
  cues: TranscriptCue[];
  marks: Array<{ abs_timestamp: number; pen_down_at?: number }>;
  meeting: PersistedMeeting;
  pageIndex: number;
  totalPages: number;
  t0AbsMs: number;
  offsetMs: number;
  limit?: number;
}): InkPageTranscriptSelection {
  const limit = input.limit ?? DETAIL_CUES_PER_SCREEN;
  const cues = input.cues;
  const phasedMarks = input.marks.map((mark) => ({ mark, phase: meetingMarkPhase(mark, input.meeting) }));
  const inMeetingMarks = phasedMarks.filter((item) => item.phase === 'in').map((item) => item.mark);
  if (input.marks.length && !inMeetingMarks.length) {
    const post = phasedMarks.some((item) => item.phase === 'post');
    return post
      ? { cues: [], meta: '会后补充·不参与转写对齐', source: 'post_meeting' }
      : { cues: [], meta: '会前准备·不参与转写对齐', source: 'pre_meeting' };
  }
  if (!cues.length) return { cues: [], meta: '原始发言待同步', source: 'empty' };

  const duration = cueDurationMs(cues);
  const base = input.t0AbsMs + input.offsetMs;
  const rels = inMeetingMarks
    .map((mark) => markTime(mark) - base)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const minRel = rels[0];
  const maxRel = rels[rels.length - 1];
  const plausibleTime = rels.length > 0
    && minRel >= -INK_TIME_PLAUSIBLE_PRE_MS
    && minRel <= duration + INK_TIME_PLAUSIBLE_POST_MS
    && maxRel >= -INK_TIME_PLAUSIBLE_PRE_MS
    && maxRel <= duration + INK_TIME_PLAUSIBLE_POST_MS;

  if (plausibleTime) {
    const startMs = minRel - INK_CUE_PRE_MS;
    const endMs = maxRel + INK_CUE_POST_MS;
    const inWindow = cues.filter((cue) => cue.endMs >= startMs && cue.startMs <= endMs);
    const center = (minRel + maxRel) / 2;
    const selected = inWindow.length
      ? (inWindow.length > limit ? nearestCues(inWindow, center, limit) : inWindow.slice(0, limit))
      : nearestCues(cues, center, limit);
    return {
      cues: selected,
      meta: `附近发言 ${cueIndexRange(cues, selected)} · ${clk(Math.max(0, minRel))}-${clk(Math.max(0, maxRel))} · 约对齐`,
      source: 'time',
    };
  }

  const selected = pageOrderCues(cues, input.pageIndex, input.totalPages, limit);
  return {
    cues: selected,
    meta: `附近发言 ${cueIndexRange(cues, selected)} · 按手写页序近似`,
    source: 'page_order',
  };
}

function renderDetailTranscriptScreen(selection: InkPageTranscriptSelection): string {
  if (selection.source === 'pre_meeting' || selection.source === 'post_meeting') {
    return `<div class="tl-combo-empty">${esc(selection.meta)}</div>`;
  }
  if (!selection.cues.length) return '<div class="tl-combo-empty">这场会议还没有同步原始发言。</div>';
  return selection.cues.map((cue) => {
    const speaker = cue.speaker ? `<b>${esc(cue.speaker)}</b>` : '<b>未知说话人</b>';
    return `<div class="tl-combo-cue"><span>${clk(cue.startMs)}</span><p>${speaker}${esc(cue.text)}</p></div>`;
  }).join('');
}

/** 详情：原始发言 + 原始会议手记同屏复盘。手写不再按 mark 拆卡片，保留会中白板的空间关系。 */
function renderRecapDetail(bodyEl: HTMLElement): void {
  if (!recapState) return;
  const state = recapState;
  const pages = meetingNotePages(state);
  if (!pages.length) { state.view = 'overview'; renderRecapOverview(bodyEl); return; }
  const total = pages.length;
  const p = clampPage(state.dtPage, total);
  state.dtPage = p;
  const page = pages[p];
  const strokeCount = page.marks.reduce((sum, mark) => sum + (mark.strokes?.length ?? 0), 0);
  const pointCount = page.marks.reduce((sum, mark) => sum + (mark.strokes ?? []).reduce((n, stroke) => n + ((stroke.surface_points?.length || stroke.points?.length || 0)), 0), 0);
  const sourceTitle = state.markSourceMeeting && state.markSourceMeeting.meeting_id !== state.meeting.meeting_id
    ? ` · 手写来源：${state.markSourceMeeting.feishu_topic || state.markSourceMeeting.title || '相近会议'}`
    : '';
  const sourceLabel = page.documentId.startsWith('mtgboard_') ? '会议手记白板' : '会议手写档案';
  const transcript = selectInkPageTranscriptCues({
    cues: state.cues,
    marks: page.marks,
    meeting: state.meeting,
    pageIndex: p,
    totalPages: total,
    t0AbsMs: meetingT0(state.meeting),
    offsetMs: finiteMs(state.meeting.align_offset_ms),
  });

  const meta = `${sourceLabel}${sourceTitle} · 原始第 ${page.pageIndex + 1} 页 · ${page.marks.length} 处 · ${strokeCount} 笔 · ${pointCount} 点`;
  bodyEl.innerHTML = `<div class="tl-note-shell tl-combo-shell">`
    + `<div class="tl-note-topbar"><button class="hbtn tl-note-back" id="tl-back">‹ 概览</button><span>${p + 1} / ${total}</span></div>`
    + `<div class="tl-combo-screen">`
    + `<section class="tl-combo-transcript"><div class="tl-combo-h"><b>附近发言</b><span>${esc(transcript.meta)}</span></div><div class="tl-combo-cues">${renderDetailTranscriptScreen(transcript)}</div></section>`
    + `<section class="tl-combo-ink"><div class="tl-combo-h"><b>手写记录</b><span>${esc(meta)}</span></div><div class="tl-note-page" aria-label="${esc(meta)}">${renderMeetingInkPageSvg(page)}</div></section>`
    + `</div>`
    + (total > 1 ? `<button class="tl-page-nav tl-page-prev" id="dt-prev"${p === 0 ? ' disabled' : ''}>‹</button><button class="tl-page-nav tl-page-next" id="dt-next"${p >= total - 1 ? ' disabled' : ''}>›</button>` : '')
    + `</div>`;

  bodyEl.querySelector('#tl-back')?.addEventListener('click', () => { if (recapState) { recapState.view = 'overview'; renderRecap(bodyEl); bodyEl.scrollTop = 0; } });
  bodyEl.querySelector('#dt-prev')?.addEventListener('click', () => { if (recapState) { recapState.dtPage = p - 1; renderRecap(bodyEl); bodyEl.scrollTop = 0; } });
  bodyEl.querySelector('#dt-next')?.addEventListener('click', () => { if (recapState) { recapState.dtPage = p + 1; renderRecap(bodyEl); bodyEl.scrollTop = 0; } });
}

// ════ P3 AI 思路总结（接 md-sum·防污染输入·不喂易错精确关系）════

/** 组装喂 AI 的结构化文本：转写（可能截断）+ 手写文字列表（各带近似时间）；**不喂** linked_cue 精确关系。
 *  返回是否截断 + 实际喂了几句，供 summary_source 记录 + UI 透明告知（防"看起来是全文总结"误导）。 */
export function buildSummaryPrompt(m: PersistedMeeting, cues: TranscriptCue[], marks: PersistedMark[]): { prompt: string; truncated: boolean; usedCueCount: number } {
  const t0 = meetingT0(m);
  const off = finiteMs(m.align_offset_ms);
  const lines: string[] = [`会议标题：${m.title || '(未命名)'}`];
  if (m.started_at) lines.push(`开始时间：${m.started_at}`);
  lines.push('', '<转写 可能因过长被截断·见末尾标记>');
  const capped = cappedTranscriptLines(cues);
  lines.push(...capped.lines);
  lines.push('</转写>', '');
  lines.push('<手写标注 各为用户当时的强调·时间是近似会议相对时刻·非与某句转写的精确对应>');
  const handwritingSections = buildMeetingHandwritingSections(m, marks, t0, off);
  const handwritingLines = meetingHandwritingSectionLines(handwritingSections);
  lines.push(...(handwritingLines.length ? handwritingLines : ['（本场没有手写标注）']));
  lines.push('</手写标注>', '', '请按系统要求产出会后思路总结。');
  return { prompt: lines.join('\n'), truncated: capped.truncated, usedCueCount: capped.usedCueCount };
}

/** 会后思路总结：拉转写 + 手写档案 → 流式 /api/chat（meeting_summary role·不走 chatTurn 不污染书 buffer）→ 写 summary。 */
export async function summarizeMeeting(meetingId: string, onDelta: (full: string) => void): Promise<string | null> {
  const m = await getMeeting(meetingId);
  if (!m) return null;
  if (!transcriptSourceKey(m)) {
    const lark = meetingPlatformOf(m) === 'lark';
    await infoSheet({
      title: lark ? '先关联飞书会议' : '暂无可用转写',
      message: lark
        ? '生成思路总结需要先在「会后记录」里关联这场会议的飞书会后转写。'
        : '该来源暂无可用于生成思路总结的转写。',
    });
    return null;
  }
  let loaded: LoadedTranscript | null;
  try { loaded = await loadTranscript(m); } catch (e) { await infoSheet({ title: '拉取转写失败', message: String((e as Error)?.message || e) }); return null; }
  if (!loaded || !loaded.cues.length) { await infoSheet({ title: '转写为空', message: '没有可用于总结的转写内容。' }); return null; }
  const marks = (await getFoldedMarksByContext('mtg_' + m.meeting_id)).filter((mk) => !mk.is_tombstone).sort((a, b) => markTime(a) - markTime(b));

  const { prompt, truncated, usedCueCount } = buildSummaryPrompt(m, loaded.cues, marks);
  let full = '';
  let streamDone = false;
  let streamError = '';
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), SUMMARY_STREAM_TIMEOUT_MS);
    try {
      await postNdjson<{ k?: string; d?: string }>(
        '/api/chat',
        { messages: [{ role: 'user', content: prompt }], role: 'meeting_summary', model: settings.inferModel, maxTokens: 1600 },
        (frame) => {
          if (frame.k === 'e') { streamError = frame.d || '生成中断'; return; }
          if (frame.k === 'done') { streamDone = true; return; }
          if (frame.k === 't' && frame.d) { full += frame.d; onDelta(full); } // 只收正文帧·丢思考帧 r
        },
        { signal: controller.signal },
      );
    } finally {
      window.clearTimeout(timer);
    }
  } catch (e) { await infoSheet({ title: '生成失败', message: String((e as Error)?.message || e) }); return null; }
  // 流没真完成（中途断/出错）→ 丢弃半截·不写库
  if (streamError || !streamDone) { await infoSheet({ title: '生成失败', message: streamError || '连接中断，已丢弃未完成内容。' }); return null; }
  let summary = full.trim();
  if (!summary) return null;
  // 截断时给 summary 顶一行透明告知（防"看起来是全文总结"误导·UI 直接可见）
  if (truncated) summary = `〔注：本总结基于前 ${usedCueCount}/${loaded.cues.length} 句转写 + 全部手写生成，后半场转写过长未参与〕\n\n${summary}`;
  const patch: Partial<PersistedMeeting> = {
    summary,
    summary_generated_at: new Date().toISOString(),
    summary_source: { transcript_cache_token: loaded.sourceToken, align_offset_ms: m.align_offset_ms ?? 0, mark_count: marks.length, cue_count: loaded.cues.length, transcript_truncated: truncated, used_cue_count: usedCueCount },
  };
  if (meetingPlatformOf(m) === 'zoom') {
    const occurrenceToken = providerOccurrenceToken(m.scheduled_at);
    let occurrenceCurrent = false;
    await mutateMeeting(m.meeting_id, (current) => {
      if (!sameZoomOccurrence(current, occurrenceToken)) return null;
      occurrenceCurrent = true;
      return patch;
    });
    if (!occurrenceCurrent) return null;
  } else {
    await updateMeeting(m.meeting_id, patch);
  }
  return summary;
}
