/**
 * WS2-C「会后记录」—— 会议转写 + 手写档案 +（近似）时间对照。
 * 挂在会议详情(renderDetail)里：关联飞书妙记 → 读转写 + 手写档案 → AI 思路总结。
 *
 * ⚠️「近似对照」非「精确对齐」：t0 用 panel 会议 start_time 近似·mark 时间是落账时刻偏后·
 * 全程用「附近/同时段」语义 + 明示校准状态（未校准/约对齐/已人工校准），绝不当精确。
 */
import { esc } from '../core/escape';
import { confirmSheet, infoSheet, pickOneSheet } from './sheet';
import { getMeeting, updateMeeting, getFoldedMarks, getFoldedMarksByContext, getCachedMinute, putCachedMinute } from '../local/store';
import { apiUrl, authFetch, getJson, postNdjson } from '../core/api';
import { settings } from '../app/state';
import { listRecentPanelMeetings, getMinuteTranscript, getMeetingNoteTranscript, resolveMeetingInstance, bindPanelMinute, getPanelMeetingSummary, generatePanelMeetingSummary, type PanelFeishuMeeting, type PanelMeetingSummaryStatus } from '../integration/panel-feishu/client';
import { parseSrtTranscript, type TranscriptCue } from '../integration/panel-feishu/align';
import type { RecapSegment } from '../integration/panel-feishu/segment';
import { buildEpaperMeetingTimeline, type EpaperMeetingTimeline } from '../integration/lark-meeting-timeline/epaper-timeline';
import { publishEntityToVault } from '../integration/inksurface/vault-publish-device';
import type { PersistedMeeting, PersistedMark, PanelMeetingSummaryRecord, FeishuNoteSummaryRecord } from '../core/store-format';
import { hasMeetingInk, renderMeetingInkPageSvg, type MeetingInkPage } from './meeting-ink-preview';
import { generateGoogleMeetingSummary, getGoogleMeetingTranscript } from '../integration/google-meet/client';
import { meetingTranscriptSource } from './meeting-platform';

const SUMMARY_TRANSCRIPT_CAP = 16000; // 喂 AI 的转写字数软上限（长转写分块留 P5）

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
  if (meetingTranscriptSource(m) === 'google_meet_transcript') {
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
  panelSummaryStatus: string;   // loading / ready / not_generated / missing_minute / generating / failed
  timeline: EpaperMeetingTimeline;
  marksById: Map<string, PersistedMark>; // 详情页需要完整 strokes；时间线只保留轻量 SegmentMark。
  markSourceMeeting: PersistedMeeting | null; // 手写可能来自同系列会议的本地手记，用于恢复未重新关联的笔迹。
}
let recapState: RecapV2 | null = null;
const googlePanelSummaryInFlight = new Map<string, Promise<PanelMeetingSummaryRecord | null>>();
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

type LoadedTranscript = { srt: string; cues: TranscriptCue[]; sourceToken: string };

function noteTranscriptCacheToken(meetingId: string): string {
  return `feishu_note_docx:${meetingId}`;
}

function googleTranscriptCacheToken(meetingId: string): string {
  return `google_meet:${meetingId}`;
}

function transcriptSourceKey(m: PersistedMeeting): string {
  if (meetingTranscriptSource(m) === 'google_meet_transcript') return googleTranscriptCacheToken(m.meeting_id);
  return m.feishu_minute_token || (m.feishu_meeting_id ? noteTranscriptCacheToken(m.feishu_meeting_id) : '');
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
  const cacheToken = noteTranscriptCacheToken(meetingId);
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
    } else if (result.status === 'ready' || result.status === 'missing_transcript') {
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
    if (result.status === 'missing_note' || result.status === 'missing_transcript') return { srt: '', cues: [], sourceToken: cacheToken };
    const first = result.errors?.[0];
    throw new Error(first?.message || result.status);
  } catch (e) {
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: cacheToken };
    throw e;
  }
}

export async function loadGoogleTranscript(m: PersistedMeeting): Promise<LoadedTranscript | null> {
  if (meetingTranscriptSource(m) !== 'google_meet_transcript' || !m.calendar_meeting_no || !m.scheduled_at) return null;
  const cacheToken = googleTranscriptCacheToken(m.meeting_id);
  const cached = await getCachedMinute(cacheToken);
  try {
    const result = await getGoogleMeetingTranscript({ meetingCode: m.calendar_meeting_no, scheduledAt: m.scheduled_at });
    const patch: Partial<PersistedMeeting> = {};
    if (m.provider_transcript_status !== result.status) patch.provider_transcript_status = result.status;
    if (result.record?.name && result.record.name !== m.provider_meeting_id) patch.provider_meeting_id = result.record.name;
    if (result.transcript?.name && result.transcript.name !== m.provider_transcript_ref) patch.provider_transcript_ref = result.transcript.name;
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

async function loadCachedTranscript(m: PersistedMeeting): Promise<LoadedTranscript | null> {
  if (meetingTranscriptSource(m) === 'google_meet_transcript') {
    const token = googleTranscriptCacheToken(m.meeting_id);
    const cached = await getCachedMinute(token);
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: token };
  }
  if (m.feishu_minute_token) {
    const cached = await getCachedMinute(m.feishu_minute_token);
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: m.feishu_minute_token };
  }
  if (m.feishu_meeting_id) {
    const token = noteTranscriptCacheToken(m.feishu_meeting_id);
    const cached = await getCachedMinute(token);
    if (cached?.srt) return { srt: cached.srt, cues: parseSrtTranscript(cached.srt), sourceToken: token };
  }
  return null;
}

/** 拉转写：**在线先拉最新**（妙记/飞书 note 可能后续补全/修订）→ 写缓存；离线/失败回退缓存。 */
async function loadTranscript(m: PersistedMeeting): Promise<LoadedTranscript | null> {
  if (meetingTranscriptSource(m) === 'google_meet_transcript') return loadGoogleTranscript(m);
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

function isOAuthRecoveryError(message: string): boolean {
  return /OAuth token|oauth_token_expired|oauth_unavailable|refresh_token|重新登录|用户 OAuth/i.test(message);
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
    bodyEl.innerHTML = `<p class="rc-note">拉取转写失败：${esc(message)}（已关联的转写若曾缓存可离线读）。</p>`;
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

async function refreshTranscriptAfterInitialRender(seq: number, bodyEl: HTMLElement, meetingId: string): Promise<void> {
  if (!recapState || recapState.meeting.meeting_id !== meetingId) return;
  try {
    const freshMeeting = await getMeeting(meetingId);
    if (!freshMeeting || !recapAlive(seq, bodyEl)) return;
    const loaded = await loadTranscript(freshMeeting);
    if (!loaded || !recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
    const cues = loaded.cues;
    const loadedMarks = await loadMeetingRecapMarks(freshMeeting);
    const marks = loadedMarks.marks;
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== meetingId) return;
    const t0 = meetingT0(freshMeeting);
    const timeline = buildEpaperMeetingTimeline({
      meeting: freshMeeting,
      cues,
      marks: marks.map((mk) => ({ mark_id: mk.mark_id, abs_timestamp: mk.abs_timestamp, feature_type: mk.feature_type, marked_text: mk.marked_text, page_index: mk.page_index })),
      t0AbsMs: t0,
      offsetMs: finiteMs(freshMeeting.align_offset_ms),
    });
    recapState.meeting = freshMeeting;
    recapState.cues = cues;
    recapState.segments = timeline.segments;
    recapState.timeline = timeline;
    recapState.marksById = new Map(marks.map((mk) => [mk.mark_id, mk] as const));
    recapState.markSourceMeeting = loadedMarks.sourceMeeting;
    recapState.transcriptMissing = !cues.length;
    recapState.feishuSummary = freshMeeting.feishu_note_summary ?? recapState.feishuSummary;
    if (recapState.view === 'overview' || recapState.view === 'transcript') renderRecap(bodyEl);
    updateRecapNav();
  } catch {
    // Cached recap is already on screen; remote transcript refresh must not disturb the会后首页.
  }
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
    .sort((a, b) => (a.abs_timestamp - b.abs_timestamp) || (a.seq - b.seq));
}

async function directMeetingMarks(meetingId: string): Promise<PersistedMark[]> {
  const byContext = activeInkMarks(await getFoldedMarksByContext('mtg_' + meetingId));
  const byBoard = activeInkMarks(await getFoldedMarks('mtgboard_' + meetingId));
  const deduped = new Map<string, PersistedMark>();
  for (const mark of [...byContext, ...byBoard]) deduped.set(mark.mark_id, mark);
  return [...deduped.values()].sort((a, b) => (a.abs_timestamp - b.abs_timestamp) || (a.seq - b.seq));
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
  bodyEl.innerHTML = '<p class="rc-note">正在拉取转写…</p>';
  let m = await getMeeting(meetingId);
  if (!recapAlive(seq, bodyEl)) return;
  if (!m) { bodyEl.innerHTML = '<p class="rc-note">会议不存在。</p>'; return; }
  titleEl.textContent = `${m.title || '会议'} · 会后记录`;
  if (meetingTranscriptSource(m) !== 'google_meet_transcript') {
    m = await resolveRealMeetingId(m); // 飞书日历/周期会来源按需换真 VC meeting_id（会前预写/短号态）
  }
  if (!recapAlive(seq, bodyEl)) return;
  if (m.panel_summary_unread) void updateMeeting(m.meeting_id, { panel_summary_unread: false }); // 进 recap 即「已读」·清 home/detail 提醒
  const hasPanelMeeting = !!m.feishu_meeting_id;
  const hasMinute = !!m.feishu_minute_token;
  const hasGoogleTranscript = meetingTranscriptSource(m) === 'google_meet_transcript' && !!m.calendar_meeting_no;
  // codex 扫描出的真 bug：新版单页面 recap 没挂旧 detail 卡片的关联入口，日历来的会议一旦没关联上飞书会议就卡死在死文案、
  // 用户没有任何办法自救。这里直接把 recap 空态变成一个可操作的关联入口（复用 associate()，成功后原地重载 recap）。
  if (!hasPanelMeeting && !hasMinute && !hasGoogleTranscript) {
    bodyEl.innerHTML = '<p class="rc-note">尚未关联飞书会议——关联后才能读飞书纪要、文字记录和 InkLoop 总结。</p>'
      + '<button class="hbtn pri" id="recap-assoc-empty" style="margin-top:2px">关联飞书会议</button>';
    bodyEl.querySelector<HTMLButtonElement>('#recap-assoc-empty')?.addEventListener('click', (ev) => {
      void (async () => {
        if (!recapAlive(seq, bodyEl)) return;
        const btn = ev.currentTarget as HTMLButtonElement | null;
        if (btn?.dataset.busy) return;
        if (btn) {
          btn.dataset.busy = '1';
          btn.disabled = true;
          btn.textContent = '正在检查飞书登录…';
        }
        try {
          if (await associate(m)) { if (recapAlive(seq, bodyEl)) void loadRecapView(meetingId, bodyEl, titleEl); }
        } finally {
          if (btn && recapAlive(seq, bodyEl) && btn.isConnected) {
            delete btn.dataset.busy;
            btn.disabled = false;
            btn.textContent = '关联飞书会议';
          }
        }
      })();
    });
    return;
  }

  // Google meeting code、妙记 token 或飞书 meeting_id 都可拉转写。
  let loaded: { srt: string; cues: TranscriptCue[] } | null = null;
  let renderedFromCache = false;
  if (hasGoogleTranscript || hasMinute || hasPanelMeeting) {
    const cached = await loadCachedTranscript(m);
    if (!recapAlive(seq, bodyEl)) return;
    if (cached) {
      loaded = cached;
      renderedFromCache = true;
    } else {
      try { loaded = await loadTranscript(m); }
      catch (e) { if (!recapAlive(seq, bodyEl)) return; renderTranscriptLoadError(seq, meetingId, bodyEl, titleEl, e); return; }
      if (!recapAlive(seq, bodyEl)) return;
    }
  }
  const cues = loaded?.cues ?? [];

  const loadedMarks = await loadMeetingRecapMarks(m);
  const marks = loadedMarks.marks;
  if (!recapAlive(seq, bodyEl)) return;
  const t0 = meetingT0(m);
  const timeline = buildEpaperMeetingTimeline({
    meeting: m,
    cues,
    marks: marks.map((mk) => ({ mark_id: mk.mark_id, abs_timestamp: mk.abs_timestamp, feature_type: mk.feature_type, marked_text: mk.marked_text, page_index: mk.page_index })),
    t0AbsMs: t0,
    offsetMs: finiteMs(m.align_offset_ms),
  });
  // 转写与手写都空 → 无可展示；但**转写未就绪而有手写时仍要把手写档案露出来**（否则用户的手写被整页静默隐藏）。
  if (!cues.length && !timeline.segmentMarks.length && !hasPanelMeeting) {
    const status = m.provider_transcript_status;
    const message = status === 'not_generated'
      ? 'Google Meet 已结束，但未生成转写。本场也没有手写档案。'
      : status === 'no_record'
        ? 'Google Meet 尚未找到对应的实际场次。本场也没有手写档案。'
        : 'Google Meet 转写仍在生成，本场也没有手写档案。稍后重新进入会自动重试。';
    bodyEl.innerHTML = `<p class="rc-note">${message}</p>`;
    return;
  }

  const segments = timeline.segments;
  const shouldGenerateGooglePanelSummary = hasGoogleTranscript && cues.length > 0 && !m.panel_summary;
  recapState = { meeting: m, segments, cues, view: 'overview', detailIdx: 0, ovPage: 0, dtPage: 0, txPage: 0, bodyEl, transcriptMissing: !cues.length,
    feishuSummary: m.feishu_note_summary ?? null,
    panelSummary: m.panel_summary ?? null,
    panelSummaryStatus: m.panel_summary ? 'ready' : (hasGoogleTranscript ? (cues.length ? 'generating' : 'missing_minute') : (m.panel_summary_status ?? 'loading')),
    timeline,
    marksById: new Map(marks.map((mk) => [mk.mark_id, mk] as const)),
    markSourceMeeting: loadedMarks.sourceMeeting };
  renderRecap(bodyEl);
  updateExportButton();
  wireRecapExportButton();
  updateRecapNav();
  wireRecapNav();
  if (renderedFromCache) void refreshTranscriptAfterInitialRender(seq, bodyEl, m.meeting_id);
  if (shouldGenerateGooglePanelSummary) void loadGooglePanelSummary(seq, bodyEl, m, cues);
  else if (!hasGoogleTranscript) void loadPanelSummary(seq, bodyEl, m); // 飞书仍从 panel-workplace 拉已生成总结。
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
  const stale = !!(m.summary && m.summary_source?.feishu_minute_token && sourceKey && m.summary_source.feishu_minute_token !== sourceKey);
  const body = m.summary
    ? `${stale ? '<div class="empty" style="margin:0 0 6px">⚠ 此总结基于旧的飞书关联生成，可能不对应当前转写，建议重新生成。</div>' : ''}<div class="summary" id="rs-body">${esc(m.summary)}</div>`
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
  const google = meetingTranscriptSource(recapState.meeting) === 'google_meet_transcript';
  const sourceLabel = google ? 'Google Meet 逐句转写' : '飞书逐句转写';
  if (!cues.length) {
    bodyEl.innerHTML = `<div class="rc-msum"><div class="rc-msum-h"><b>原始发言</b><span class="mdl">${sourceLabel}</span></div><div class="empty">原始发言还没有同步到本机；稍后重新进入本页会自动重试。</div></div>`;
    return;
  }
  const total = Math.max(1, Math.ceil(cues.length / TX_PAGE));
  const p = clampPage(recapState.txPage, total);
  recapState.txPage = p;
  const slice = cues.slice(p * TX_PAGE, (p + 1) * TX_PAGE);
  const speakerCount = new Set(cues.map((cue) => cue.speaker || '').filter(Boolean)).size;
  const rows = slice.map((cue) => {
    const speaker = cue.speaker ? `<span class="rc-tr-speaker">${esc(cue.speaker)}</span>` : '';
    return `<div class="rc-tr-row"><span class="rc-tr-time">${clk(cue.startMs)}</span><span class="rc-tr-text">${speaker}${esc(cue.text)}</span></div>`;
  }).join('');
  bodyEl.innerHTML = `<div class="rc-transcript">`
    + `<div class="rc-msum-h"><b>原始发言</b><span class="mdl">${cues.length} 句 · ${speakerCount || '未知'} 人</span></div>`
    + `<div class="rc-note">这里展示${google ? ' Google Meet' : '飞书会后记录里的'}逐句原始发言；不混入智能纪要，也不混入 InkLoop 后处理。</div>`
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
function toStoredPanelSummaryStatus(status: PanelMeetingSummaryStatus): StoredPanelSummaryStatus {
  if (status === 'ready' || status === 'not_generated' || status === 'missing_minute' || status === 'not_found') return status;
  return 'failed'; // 'failed' 外的取数态都落库，下次进 recap 直接显示而非永远 loading。
}

/**
 * 按 feishu_meeting_id 拉 panel 五要素总结、写入本地缓存。事件消费(summary_ready)与 recap 内共用。
 * 远端拉取失败 / 本地写失败都会抛 —— 由调用方决定 best-effort（吞掉下次再拉）还是中断（不推 cursor）。
 */
export async function refreshPanelSummaryCache(m: PersistedMeeting): Promise<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }> {
  if (!m.feishu_meeting_id) {
    await updateMeeting(m.meeting_id, { panel_summary_status: 'missing_minute' });
    return { status: 'missing_minute', summary: null };
  }
  const r = await getPanelMeetingSummary(m.feishu_meeting_id);
  const fetchedAt = new Date().toISOString();
  if (r.summary) await updateMeeting(m.meeting_id, { panel_summary: r.summary, panel_summary_fetched_at: fetchedAt, panel_summary_status: 'ready' });
  else await updateMeeting(m.meeting_id, { panel_summary_fetched_at: fetchedAt, panel_summary_status: toStoredPanelSummaryStatus(r.status) });
  return r;
}

/** L5：recap 内异步拉 panel 总结、拉到后按当前 view 重渲。失败标 failed（best-effort·不影响时间线）。 */
async function loadPanelSummary(seq: number, bodyEl: HTMLElement, m: PersistedMeeting): Promise<void> {
  try {
    const r = await refreshPanelSummaryCache(m);
    if (!recapAlive(seq, bodyEl) || !recapState || recapState.meeting.meeting_id !== m.meeting_id) return;
    recapState.panelSummary = r.summary ?? recapState.panelSummary;
    recapState.panelSummaryStatus = r.summary ? 'ready' : r.status;
  } catch {
    // codex 扫描出的真 bug：漏了这条守卫时，A 会议请求晚到失败会污染此刻正在看的 B 会议的状态。
    if (recapAlive(seq, bodyEl) && recapState && recapState.meeting.meeting_id === m.meeting_id) {
      recapState.panelSummaryStatus = recapState.panelSummary || buildLocalPanelSummaryPreview() ? 'local_preview' : 'failed';
    }
  }
  if (recapAlive(seq, bodyEl)) renderRecap(bodyEl);
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

/** Google 路线的纯数据生成入口：已有结果直接复用，同一会议并发请求共享一个 in-flight Promise。 */
export async function ensureGooglePanelSummary(m: PersistedMeeting, cues: TranscriptCue[]): Promise<PanelMeetingSummaryRecord | null> {
  if (m.panel_summary) return m.panel_summary;
  if (!cues.length) return null;
  const running = googlePanelSummaryInFlight.get(m.meeting_id);
  if (running) return running;
  const task = (async (): Promise<PanelMeetingSummaryRecord> => {
    const capped = cappedTranscriptLines(cues);
    const response = await generateGoogleMeetingSummary({
      title: m.title || '(未命名会议)',
      transcript: capped.lines.join('\n'),
      model: settings.inferModel,
    });
    const summary: PanelMeetingSummaryRecord = {
      minute_token: googleTranscriptCacheToken(m.meeting_id),
      meeting_id: m.provider_meeting_id || m.calendar_meeting_no || m.meeting_id,
      topic: m.title,
      generated_at: Date.now(),
      model: response.model,
      summary: response.summary,
    };
    await updateMeeting(m.meeting_id, {
      panel_summary: summary,
      panel_summary_fetched_at: new Date().toISOString(),
      panel_summary_status: 'ready',
    });
    return summary;
  })();
  googlePanelSummaryInFlight.set(m.meeting_id, task);
  try {
    return await task;
  } finally {
    if (googlePanelSummaryInFlight.get(m.meeting_id) === task) googlePanelSummaryInFlight.delete(m.meeting_id);
  }
}

async function loadGooglePanelSummary(seq: number, bodyEl: HTMLElement, m: PersistedMeeting, cues: TranscriptCue[]): Promise<void> {
  if (m.panel_summary || !cues.length) return;
  if (recapAlive(seq, bodyEl) && recapState?.meeting.meeting_id === m.meeting_id) {
    recapState.panelSummaryStatus = 'generating';
    renderRecap(bodyEl);
  }
  try {
    const summary = await ensureGooglePanelSummary(m, cues);
    if (!summary || !recapAlive(seq, bodyEl) || recapState?.meeting.meeting_id !== m.meeting_id) return;
    recapState.panelSummary = summary;
    recapState.meeting = { ...recapState.meeting, panel_summary: summary, panel_summary_status: 'ready' };
    recapState.panelSummaryStatus = 'ready';
  } catch {
    await updateMeeting(m.meeting_id, { panel_summary_status: 'failed' }).catch(() => null);
    if (recapAlive(seq, bodyEl) && recapState?.meeting.meeting_id === m.meeting_id) recapState.panelSummaryStatus = 'failed';
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
  const status = recapState.panelSummaryStatus;
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
  if (status === 'missing_minute') return box('InkLoop 还没拿到这场会议的转写，暂时不能生成结构化总结；飞书转写绑定后会自动同步。');
  if (status === 'loading' || status === 'generating') return box(status === 'generating' ? '正在生成 InkLoop 总结…（读取完整转写，稍候）' : '正在拉取 InkLoop 总结…');
  if (status === 'failed') return box('拉取 InkLoop 总结失败（网络/服务波动）。<button class="hbtn rc-psum-retry" id="ps-refresh">刷新重试</button>');
  if (status === 'not_found') return box('InkLoop 没找到这场会议（可能关联错了，可回上一页改关联）。<button class="hbtn rc-psum-retry" id="ps-refresh">刷新</button>');
  // not_generated → 可主动触发生成
  return box('InkLoop 还没生成这场会议的结构化总结。<button class="hbtn rc-psum-retry" id="ps-gen">生成总结</button>');
}

/** 绑定 panel 总结块的按钮（生成 / 刷新重试）——正常态与空态共用。 */
function wirePanelSummaryButtons(bodyEl: HTMLElement): void {
  bodyEl.querySelector('#ps-gen')?.addEventListener('click', () => { // 生成总结（Google 走 hub；飞书走 panel）
    if (!recapState) return;
    if (meetingTranscriptSource(recapState.meeting) === 'google_meet_transcript') {
      void loadGooglePanelSummary(recapLoadSeq, bodyEl, recapState.meeting, recapState.cues);
    } else void generatePanelSummary(recapLoadSeq, bodyEl, recapState.meeting.meeting_id);
  });
  bodyEl.querySelector('#ps-refresh')?.addEventListener('click', () => { // 失败/未找到时重拉
    if (!recapState) return;
    if (meetingTranscriptSource(recapState.meeting) === 'google_meet_transcript') {
      void loadGooglePanelSummary(recapLoadSeq, bodyEl, recapState.meeting, recapState.cues);
    } else {
      recapState.panelSummaryStatus = 'loading';
      renderRecap(bodyEl);
      void loadPanelSummary(recapLoadSeq, bodyEl, recapState.meeting);
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
  if (recapState.panelSummaryStatus === 'generating') return '生成中';
  if (recapState.panelSummaryStatus === 'failed') return '待重试';
  if (recapState.panelSummaryStatus === 'not_generated') return '待生成';
  if (recapState.panelSummaryStatus === 'missing_minute') return '缺少转写';
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
  const rec = recapState.feishuSummary ?? recapState.meeting.feishu_note_summary ?? null;
  if (rec?.content) {
    return feishuLines(rec.content)
      .filter((line) => line.length > 20 && !FEISHU_META_RE.test(line) && !isFeishuImageRef(line))
      .slice(0, 2);
  }
  if (recapState.cues.length) return [cueExcerpt(recapState.cues.slice(0, Math.min(6, recapState.cues.length)))];
  return [];
}

function overviewCardHtml(opts: { action: string; title: string; meta: string; body: string; disabled?: boolean }): string {
  const disabled = opts.disabled ? ' disabled aria-disabled="true"' : '';
  return `<button class="rc-entry${opts.disabled ? ' is-disabled' : ''}" type="button" data-rc-open="${esc(opts.action)}"${disabled}>`
    + `<span class="rc-entry-top"><b>${esc(opts.title)}</b><span>${esc(opts.meta)}</span></span>`
    + `<span class="rc-entry-body">${esc(opts.body)}</span>`
    + `<span class="rc-entry-go">${opts.disabled ? '暂无内容' : '进入 ›'}</span>`
    + `</button>`;
}

/** 概览：会后第一屏。只放核心状态和入口；长转写进入「原始发言」详情页。 */
function renderRecapOverview(bodyEl: HTMLElement): void {
  if (!recapState) return;
  const { meeting, cues } = recapState;
  const title = meeting.feishu_topic || meeting.title || '会议';
  const speakerCount = new Set(cues.map((cue) => cue.speaker || '').filter(Boolean)).size;
  const inkPages = meetingNotePages(recapState);
  const inkCount = inkPages.reduce((sum, page) => sum + page.marks.length, 0);
  const markSource = recapState.markSourceMeeting && recapState.markSourceMeeting.meeting_id !== meeting.meeting_id
    ? ` · 来自${recapState.markSourceMeeting.feishu_topic || recapState.markSourceMeeting.title || '相近会议'}`
    : '';
  const feishuReady = !!(recapState.feishuSummary?.content || meeting.feishu_note_summary?.content);
  const conclusions = overviewConclusionItems();
  const conclusionHtml = conclusions.length
    ? conclusions.map((item) => `<span class="rc-over-li">${esc(item)}</span>`).join('')
    : `<span class="rc-over-empty">飞书原始发言或智能纪要同步后，这里会出现会议要点。</span>`;
  const rawMeta = cues.length ? `${cues.length} 句 · ${speakerCount || '未知'} 人` : '待同步';
  const rawBody = cues.length ? cueExcerpt(cues.slice(0, Math.min(cues.length, 8))) : '飞书原始发言还没有同步到本机。';
  const inkBody = inkCount
    ? `共 ${inkCount} 处手写/圈画${markSource}，点击按屏查看原始发言和整页手写。`
    : '本场没有手写记录；如果会后补写，会自动归到这里。';
  const exportState = meeting.exported_at ? `已导出 ${fmtExportedAt(meeting.exported_at)}` : '未导出';
  bodyEl.innerHTML = `<div class="rc-overview">`
    + `<section class="rc-over-hero">`
    + `<div><span class="rc-kicker">会后概览</span><h2>${esc(title)}</h2><p>${esc(fmtClock(meetingT0(meeting)) || fmtClock(Date.parse(meeting.scheduled_at)) || '时间未知')} · ${esc(meetingDurationLabel(meeting, cues))} · ${esc(meeting.align_state ? ALIGN_LABEL[meeting.align_state] : '约对齐')}</p></div>`
    + `<div class="rc-metrics"><span><b>${cues.length || '-'}</b>句</span><span><b>${speakerCount || '-'}</b>人</span><span><b>${inkCount}</b>手写</span></div>`
    + `</section>`
    + `<section class="rc-over-focus"><div class="rc-sec-title"><b>会议要点</b><span>${esc(panelSummaryLabel())}</span></div><div class="rc-over-list">${conclusionHtml}</div></section>`
    + `<section class="rc-entry-grid">`
    + overviewCardHtml({ action: 'transcript', title: '原始发言', meta: rawMeta, body: rawBody, disabled: !cues.length })
    + overviewCardHtml({ action: 'feishu', title: '飞书智能纪要', meta: feishuReady ? '已同步' : '等待生成', body: feishuReady ? '查看飞书官方会后纪要原文、图片和待办。' : '飞书官方智能纪要还没有同步。', disabled: !feishuReady })
    + overviewCardHtml({ action: 'handwriting', title: '手写记录', meta: inkCount ? `${inkCount} 处${markSource}` : '0 处', body: inkBody, disabled: inkPages.length === 0 })
    + overviewCardHtml({ action: 'panel', title: 'InkLoop 后处理', meta: `${panelSummaryLabel()} · ${exportState}`, body: '查看结构化结论、行动项、风险和后续，也可以从顶栏导出知识库。' })
    + `</section>`
    + `</div>`;
  bodyEl.querySelectorAll<HTMLElement>('[data-rc-open]').forEach((el) => el.addEventListener('click', () => {
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
  }));
}

function meetingNotePages(state: RecapV2): MeetingInkPage[] {
  const marks = [...state.marksById.values()]
    .filter((mark) => !mark.is_tombstone && hasMeetingInk(mark))
    .sort((a, b) => (a.page_index - b.page_index) || (a.seq - b.seq) || (a.abs_timestamp - b.abs_timestamp));
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
  source: 'time' | 'page_order' | 'empty';
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
  marks: Array<{ abs_timestamp: number }>;
  pageIndex: number;
  totalPages: number;
  t0AbsMs: number;
  offsetMs: number;
  limit?: number;
}): InkPageTranscriptSelection {
  const limit = input.limit ?? DETAIL_CUES_PER_SCREEN;
  const cues = input.cues;
  if (!cues.length) return { cues: [], meta: '原始发言待同步', source: 'empty' };

  const duration = cueDurationMs(cues);
  const base = input.t0AbsMs + input.offsetMs;
  const rels = input.marks
    .map((mark) => mark.abs_timestamp - base)
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
function buildSummaryPrompt(m: PersistedMeeting, cues: TranscriptCue[], marks: PersistedMark[]): { prompt: string; truncated: boolean; usedCueCount: number } {
  const t0 = meetingT0(m);
  const off = finiteMs(m.align_offset_ms);
  const lines: string[] = [`会议标题：${m.title || '(未命名)'}`];
  if (m.started_at) lines.push(`开始时间：${m.started_at}`);
  lines.push('', '<转写 可能因过长被截断·见末尾标记>');
  const capped = cappedTranscriptLines(cues);
  lines.push(...capped.lines);
  lines.push('</转写>', '');
  lines.push('<手写标注 各为用户当时的强调·时间是近似会议相对时刻·非与某句转写的精确对应>');
  if (marks.length) for (const mk of marks) {
    const txt = (mk.marked_text || '').trim();
    lines.push(txt ? `[${clk(mk.abs_timestamp - t0 - off)}] ${txt}` : `[${clk(mk.abs_timestamp - t0 - off)}] （一处${mk.feature_type === 'drawing' ? '图形/圈画' : '无法识别的手写'}·别推断其文字含义）`);
  }
  else lines.push('（本场没有手写标注）');
  lines.push('</手写标注>', '', '请按系统要求产出会后思路总结。');
  return { prompt: lines.join('\n'), truncated: capped.truncated, usedCueCount: capped.usedCueCount };
}

/** 会后思路总结：拉转写 + 手写档案 → 流式 /api/chat（meeting_summary role·不走 chatTurn 不污染书 buffer）→ 写 summary。 */
export async function summarizeMeeting(meetingId: string, onDelta: (full: string) => void): Promise<string | null> {
  const m = await getMeeting(meetingId);
  if (!m) return null;
  if (!transcriptSourceKey(m)) { await infoSheet({ title: '先关联飞书会议', message: '生成思路总结需要先在「会后记录」里关联这场会议的飞书会后转写。' }); return null; }
  let loaded: LoadedTranscript | null;
  try { loaded = await loadTranscript(m); } catch (e) { await infoSheet({ title: '拉取转写失败', message: String((e as Error)?.message || e) }); return null; }
  if (!loaded || !loaded.cues.length) { await infoSheet({ title: '转写为空', message: '没有可用于总结的转写内容。' }); return null; }
  const marks = (await getFoldedMarksByContext('mtg_' + m.meeting_id)).filter((mk) => !mk.is_tombstone).sort((a, b) => a.abs_timestamp - b.abs_timestamp);

  const { prompt, truncated, usedCueCount } = buildSummaryPrompt(m, loaded.cues, marks);
  let full = '';
  let streamDone = false;
  let streamError = '';
  try {
    await postNdjson<{ k?: string; d?: string }>(
      '/api/chat',
      { messages: [{ role: 'user', content: prompt }], role: 'meeting_summary', model: settings.inferModel, maxTokens: 1600 },
      (frame) => {
        if (frame.k === 'e') { streamError = frame.d || '生成中断'; return; }
        if (frame.k === 'done') { streamDone = true; return; }
        if (frame.k === 't' && frame.d) { full += frame.d; onDelta(full); } // 只收正文帧·丢思考帧 r
      },
    );
  } catch (e) { await infoSheet({ title: '生成失败', message: String((e as Error)?.message || e) }); return null; }
  // 流没真完成（中途断/出错）→ 丢弃半截·不写库
  if (streamError || !streamDone) { await infoSheet({ title: '生成失败', message: streamError || '连接中断，已丢弃未完成内容。' }); return null; }
  let summary = full.trim();
  if (!summary) return null;
  // 截断时给 summary 顶一行透明告知（防"看起来是全文总结"误导·UI 直接可见）
  if (truncated) summary = `〔注：本总结基于前 ${usedCueCount}/${loaded.cues.length} 句转写 + 全部手写生成，后半场转写过长未参与〕\n\n${summary}`;
  await updateMeeting(m.meeting_id, {
    summary,
    summary_generated_at: new Date().toISOString(),
    summary_source: { feishu_minute_token: loaded.sourceToken, align_offset_ms: m.align_offset_ms ?? 0, mark_count: marks.length, cue_count: loaded.cues.length, transcript_truncated: truncated, used_cue_count: usedCueCount },
  });
  return summary;
}
