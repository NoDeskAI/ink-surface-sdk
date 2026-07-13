/**
 * 移动版（电纸屏）会议 controller —— 复用 web 同一批 store/feishu/引擎数据，换 mobile.html 的黑白 markup。
 * 不 import 桌面 features/meeting/meeting.ts（那套绑 #app-pages / .mtg-* 桌面类 / host.go 导航壳，移动版用不上）。
 *
 * 四级视图（body[data-mtg]）：home 日程聚合 → ws 群会议三桶 → detail 四区块 → live 会中工作台。
 * 会中白板：渲染器是单画布深单例，故进会议时把 #stage-wrap 物理搬进 #mtg-stage-host（renderer 持元素引用、搬动后照常），
 * 退会议搬回 #rv-new；新建 meetingCtx + setActiveContext + renderBlankSurface('mtgboard_<id>')，标注落本会议白板账本。
 */
import { bus, state, settings, setActiveContext, getActiveContext, currentStrokes, strokeMarkIds, type Stroke } from '../app/state';
import { SurfaceContext } from '../app/surface-context';
import { renderBlankSurface, renderBlankPage, resizeBlankSurface, reopenBook, openPdfFromUrl, importPdfFromUrl, cancelActiveRender } from '../surface/renderer';
import { redrawInk } from '../capture/ink';
import { flushRegion } from '../app/annotation-loop';
import { flushBedrock } from '../local/bedrock-recorder';
import { createPager, mountPagerBar, type Pager, type PagerBar } from '../surface/virtual-pager';
import {
  listWorkspaces, listAllMeetings, getWorkspace,
  createMeeting, getMeeting, updateMeeting, addMeetingMaterialDocIds, addMeetingMaterialLinks, getFoldedMarks, getFoldedMarksByContext, listBooks, upsertFeishuWorkspace, startSimMeeting,
  createDiaryDoc, renameDiary, setActiveDoc, setLastReadPage, getDoc, upsertPanelWorkspace, upsertScheduleWorkspace,
  appendMarkEntry,
} from '../local/store';
import { esc } from '../core/escape';
import { confirmSheet, formSheet, infoSheet, pickSheet, pickOneSheet } from './sheet';
import { loadRecapView, resetRecapView, recapHandleBack, refreshPanelSummaryCache } from './meeting-recap'; // summarizeMeeting 迁 recap 内调用(M2b)
import type { MeetingStatus, PersistedMeeting, PersistedMeetingMaterialLink, PersistedWorkspace, PersistedDoc, PersistedMark } from '../core/store-format';
import { pollPanelMeetingEvents, listActivePanelMeetings, type PanelFeishuMeeting, type PanelMeetingEvent } from '../integration/panel-feishu/client';
import { listMeetingGroupMaterialFiles, listMeetingGroupDocxLinks, materialDocId, pdfSourceUrl, syncMeetingGroupMaterials, inCaptureWindow, type FeishuFileItem } from '../features/meeting/feishu-materials';
import { materialLinkId, materialDocxPdfDocId } from '../features/meeting/feishu-doc-links';
import { forgetClaim, meetingNoFromUrl, resolveClaim, rememberClaim } from '../features/meeting/group-claims';
import { apiUrl, getJson, postJson } from '../core/api';
import { getSession } from '../core/auth';
import { refreshCoreSessionFromAuthority } from '../core/session-reconcile';
import { showMobileToast, dismissMobileToast } from './toast';
import { devEmit } from '../core/dev-telemetry';
import { notePanelSyncOk, notePanelSyncError } from './meeting-sync-status';
import type { NormBBox, StrokePoint } from '../core/contracts';
import { DEVICE_ID, shortId } from '../core/ids';
import { signalInkArea } from '../surface/eink';
import { effectiveMeetingEndIso, effectiveMeetingStatus, meetingHomeBuckets, normalizeMeetingHomeFilter, type MeetingHomeFilter } from './meeting-home-model';
import { fitMeetingNotePage } from './meeting-note-layout';

// ── 飞书后端（feishu-service）+ 文档转换（convert-service）──
// P0 安全止血后不再前端直连裸端口（两条服务之前零鉴权，见项目记忆盲区扫描发现）。设备浏览器发的请求一律走同源代理
// （FEISHU_PROXY/CONVERT_PROXY，dev=vite plugin·生产=inkloop-proxy standalone，secret 留服务端注入不进前端 bundle）。
// FEISHU_ABSOLUTE 只用于拼「喂给 convert-service 当抓取源」的 URL——那段是 convert-service 自己服务端 fetch，
// 不是设备浏览器直连，convert-service 那边认得这个地址会自动代填 secret（见 convert-service/convert.js）。
const FEISHU_PROXY = '/api/feishu-svc';
const CONVERT_PROXY = '/api/convert';
const FEISHU_ABSOLUTE = ((import.meta.env.VITE_FEISHU_SERVICE_ABSOLUTE as string | undefined) ?? 'http://localhost:4321').replace(/\/+$/, '');
async function feishuGet<T>(path: string): Promise<T | null> {
  // codex 扫描出的真 bug：裸 fetch 在安卓静态包(WebView appassets 源)下不会走 VITE_API_BASE_URL，
  // 会直接打到 assets 域名 404——必须过 apiUrl() 才能在生产环境正确落到 inkloop-proxy standalone。
  try { return await getJson<T>(FEISHU_PROXY + path, { auth: true }); }
  catch { return null; }
}

interface FeishuMsg { message_id: string; msg_type: string; sender_id?: string; create_time?: string; text?: string; file_name?: string; file_key?: string; image_key?: string; }
interface FeishuEvent { event_id: string; summary?: string; start_time?: { timestamp?: string; date?: string }; end_time?: { timestamp?: string }; recurring?: boolean; has_meeting?: boolean; vchat?: { meeting_url?: string; vc_type?: string } | null; source?: 'bot_calendar' | string; calendar_id?: string; calendar_summary?: string }
interface FeishuCalendarEventsResponse {
  connected?: boolean;
  configured?: boolean;
  source?: string;
  events?: FeishuEvent[];
  error?: { code?: string; message?: string; permission_url?: string; required_scopes?: string[] };
}
interface FeishuBotConfigStatusResponse {
  configured?: boolean;
  source?: 'local_config' | 'env' | 'none';
  app_id?: string;
  app_secret_set?: boolean;
  base_url?: string;
  error?: string;
}
interface FeishuIdentityResponse {
  connected?: boolean;
  configured?: boolean;
  server_now_ms?: number;
  server_time?: string;
  session?: { tenant_id?: string; user_id?: string; device_id?: string; feishu_open_id?: string | null };
  oauth?: {
    authenticated?: boolean;
    connected?: boolean;
    missing_scopes?: string[];
    refresh_token_present?: boolean;
    reason?: string;
  };
  team_access?: {
    identity_connected?: boolean;
    groups?: Array<{ chat_id: string; name: string; member_name?: string }>;
    accessible_chat_ids?: string[];
    errors?: Array<{ code: string; message: string }>;
  };
  bot?: FeishuBotConfigStatusResponse;
}
interface FeishuTimeResponse {
  server_now_ms?: number;
  server_time?: string;
}
interface FeishuMeetingSource {
  source_id: string;
  source: 'bot_calendar' | 'user_calendar' | 'bot_chat_message' | 'lark_meeting_timeline';
  title: string;
  status: MeetingStatus;
  scheduled_at: string;
  started_at?: string;
  ended_at?: string;
  start_time_reliable?: boolean;
  meeting_url?: string;
  meeting_no?: string;
  feishu_meeting_id?: string;
  feishu_minute_token?: string;
  calendar_event_id?: string;
  calendar_id?: string;
  chat_id?: string;
  chat_name?: string;
  message_id?: string;
}
interface FeishuMeetingSourcesResponse {
  connected?: boolean;
  configured?: boolean;
  sources?: FeishuMeetingSource[];
  errors?: Array<{ source: string; code: string; message: string; required_scope?: string; permission_url?: string }>;
}
const isConvertible = (f: FeishuMsg): boolean => f.msg_type === 'file' && /\.html?$/i.test(f.file_name || '');
/** 文件本体标识（B7-bug6 一致性）：会中资料抽屉直开的 docId 要和 material_doc_ids 自动扫描用同一套身份
 *（resource_key 不随转发/重贴变化），否则同一文件在两条路径各生成一份 docId，产生重复转换/缓存。 */
const feishuMsgResourceKey = (f: FeishuMsg): string => (f.msg_type === 'image' ? f.image_key : f.file_key) || f.message_id;
/** 群文件下载路径的公共部分（不带 base）。 */
const feishuFilePath = (f: FeishuMsg): string => {
  const img = f.msg_type === 'image';
  const key = img ? f.image_key : f.file_key;
  const name = img ? '［图片］' : (f.file_name || '文件');
  return `/api/feishu/messages/${encodeURIComponent(f.message_id)}/file/${encodeURIComponent(key || '')}?type=${img ? 'image' : 'file'}&name=${encodeURIComponent(name)}`;
};
/** 设备浏览器直接点开/下载用——走同源代理，浏览器点击带不了自定义头。apiUrl() 包一层：安卓静态包下要落到 VITE_API_BASE_URL。 */
function feishuFileUrl(f: FeishuMsg): string { return apiUrl(`${FEISHU_PROXY}${feishuFilePath(f)}`); }
/** 喂给 convert-service 当抓取源用——必须是真绝对地址，convert-service 服务端 fetch 时自己代填 secret。 */
function feishuFileUrlAbsolute(f: FeishuMsg): string { return `${FEISHU_ABSOLUTE}${feishuFilePath(f)}`; }
const convertedPdfUrl = (f: FeishuMsg): string => apiUrl(`${CONVERT_PROXY}/to-pdf?url=${encodeURIComponent(feishuFileUrlAbsolute(f))}`);

// ── 时间/格式 ──
const fsEventWhen = (e: FeishuEvent): number => {
  const ts = e.start_time?.timestamp;
  if (ts) return Number(ts) * 1000;
  const d = e.start_time?.date;
  return d ? new Date(d.replace(/-/g, '/')).getTime() : 0;
};
const fsEventEnd = (e: FeishuEvent): number => {
  const ts = e.end_time?.timestamp;
  return ts ? Number(ts) * 1000 : 0;
};
let cloudNowOffsetMs = 0;
function updateCloudClock(serverNowMs: unknown): void {
  const ms = Number(serverNowMs);
  if (Number.isFinite(ms) && ms > 0) cloudNowOffsetMs = ms - Date.now();
}
async function refreshCloudClock(): Promise<void> {
  const time = await feishuGet<FeishuTimeResponse>('/api/feishu/time');
  updateCloudClock(time?.server_now_ms);
}
function meetingNowMs(): number {
  return Date.now() + cloudNowOffsetMs;
}
function scheduledMeetingStatus(startIso: string, endIso?: string): MeetingStatus {
  const now = meetingNowMs();
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : 0;
  if (end && end <= now) return 'ended';
  if (!end && Number.isFinite(start) && now - start > 6 * 60 * 60 * 1000) return 'ended';
  if (Number.isFinite(start) && start <= now) return 'live';
  return 'upcoming';
}
const fmtMs = (ms?: string): string => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? fmtDateTime(new Date(n).toISOString()) : ''; };
/** 链接型资料副文案：区分「纯链接」「已导出可批注 PDF」「无权限/失败」三态，别让用户对着一张卡不知道点了会发生什么。 */
function materialLinkStatusText(l: PersistedMeetingMaterialLink): string {
  if (l.pdf_doc_id) return '飞书文档 · 已导出 PDF · 可批注';
  if (l.status === 'permission_denied') return '飞书文档 · 无权限读取内容 · 可打开链接';
  if (l.status === 'failed') return `飞书文档 · 上次导出失败 · 可打开链接或重试（${l.error || ''}）`;
  return '飞书文档 · 链接';
}
const fmtDateTime = (iso: string): string => {
  try { return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return iso; }
};
const clk = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

// ── 内联 SVG（mobile 黑白线性）──
const SVG_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/></svg>';
const SVG_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 14l4-3 4 3 4-4 4 3"/></svg>';
const SVG_GO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const SVG_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>';
const SVG_PEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l.8-3.2L16.2 5.4a2 2 0 0 1 2.8 0l-.4-.4a2 2 0 0 1 0 2.8L7.2 19.2 4 20z"/></svg>';
const SVG_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.5-1.5"/></svg>';

const ST: Record<MeetingStatus, [string, string]> = { live: ['live', '进行中'], upcoming: ['up', '待开始'], ended: ['end', '已结束'] };
const stBadge = (s: MeetingStatus): string => `<span class="st ${ST[s][0]}"><span class="d"></span>${ST[s][1]}</span>`;
function meetingOwnershipHtml(m: PersistedMeeting, ws: PersistedWorkspace | null): { html: string; hasFeishuGroup: boolean } {
  if (ws?.source === 'feishu' && ws.feishu_chat_id) {
    const hint = m.group_claimed_at ? '已确认' : '自动归属';
    return {
      hasFeishuGroup: true,
      html: `<span>${esc(ws.name || '飞书群')}</span><span style="margin-left:8px;color:#777;font-size:12px">${hint}</span><button class="lk" id="md-unclaim" style="margin-left:8px">移除</button>`,
    };
  }
  return {
    hasFeishuGroup: false,
    html: '<span style="color:#777">未归属</span><button class="lk" id="md-claim" style="margin-left:8px">选择群</button>',
  };
}
function decodeMeetingTitle(value: string | undefined, fallback = '会议'): string {
  const raw = String(value || '').trim() || fallback;
  return raw.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (full, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : lower.startsWith('#') ? Number.parseInt(lower.slice(1), 10) : NaN;
    return Number.isFinite(code) ? String.fromCodePoint(code) : full;
  }).replace(/\u00a0/g, ' ');
}

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ── controller 内部状态 ──
let mv: { wsId?: string; mtgId?: string } = {};
let readerCtx: SurfaceContext;
// 会中
let meetingCtx: SurfaceContext | null = null;
let liveMtg: { id: string; title: string; chatId?: string; status: MeetingStatus; startedAt: number; frozenAt: number } | null = null;
let clockTimer = 0;
let prevGesture = true;
let liveMarkCount = 0;
let liveNoteDoc: PersistedDoc | null = null;            // 当前会议手记 doc（=会中白板物化成的 diary doc）
// 会中基岩 lease（三个模块级标志·能跨 visibility 抖动存活）：
let bedrockLeased = false;        // 当前持租约（防切后台再切回时重复 start）
let bedrockAutoEnabled = false;   // 本次租约是我们替它开的 → 退出/收租要还原成关
let bedrockUserOverride = false;  // 本场会议里用户手动设过 bedrock → 续租/退出都别动它（每场 enterMeeting 重置）
const RULED = { ruledLines: false } as const;            // 同日记：引擎不画线，稿纸线走 CSS 叠层 #diary-lines
const noteIdOf = (mtgId: string): string => 'mtgboard_' + mtgId; // 会议手记 doc id = 既有白板 marks 的 document_id（零迁移·createDiaryDoc 幂等）

function setMtg(view: 'home' | 'detail' | 'live' | 'recap'): void {
  document.body.dataset.mtg = view;
  document.body.classList.toggle('writable', view === 'live'); // 会中白板=可写（露工具格子）
}

// 会议各视图（mview）每次 render 重建 innerHTML（含 .mbody）→ scroll 容器被换掉，
// 故每次渲染末尾给新 .mbody 建一个新 pager（先销毁旧的断 observer）；bar 挂到 mview，下次 innerHTML 自然清掉旧 bar。
const mtgPagers = new Map<string, Pager>();
function pageMbody(viewEl: HTMLElement, key: string, land: 'first' | 'keep' = 'first'): void {
  mtgPagers.get(key)?.destroy();
  const sc = viewEl.querySelector<HTMLElement>('.mbody');
  if (!sc) { mtgPagers.delete(key); return; }
  let bar: PagerBar | undefined;
  const pager = createPager(sc, { onChange: (i) => bar?.update(i) });
  bar = mountPagerBar(pager, viewEl);
  pager.relayout(land);
  mtgPagers.set(key, pager);
}

let meetingHomePage = 0;
const MEETING_HOME_FILTER_KEY = 'inkloop.meeting.home.filter.v1';
let meetingHomeFilter: MeetingHomeFilter = (() => {
  try { return normalizeMeetingHomeFilter(localStorage.getItem(MEETING_HOME_FILTER_KEY)); }
  catch { return 'active'; }
})();

function rememberMeetingHomeFilter(filter: MeetingHomeFilter): void {
  meetingHomeFilter = filter;
  meetingHomePage = 0;
  try { localStorage.setItem(MEETING_HOME_FILTER_KEY, filter); } catch { /* filter persistence is optional */ }
}

// ════ L1：panel 飞书会议同步（VC all_meeting_started/ended → 本地会议·带真 t0）════
const PANEL_CURSOR_KEY = 'inkloop.panelMeeting.cursor.v1';
const panelUpserts = new Map<string, Promise<void>>(); // 按 meeting_id 串行·防 events+active 并发同一会议重复建
type PanelMeetingUpsertType = 'started' | 'ended' | 'metadata'; // metadata=minute_bound/summary_ready 带来的元数据更新·不改 status/时间

/** 事件内嵌会议上的当前妙记 token（顶层 minute_token 优先·回退 match.minute_token）。 */
function panelMinuteToken(mt: PanelFeishuMeeting): string | null {
  return mt.minute_token || mt.match?.minute_token || null;
}
async function findLocalPanelMeeting(panelMeetingId: string): Promise<PersistedMeeting | null> {
  return (await listAllMeetings()).find((x) => x.feishu_meeting_id === panelMeetingId) ?? null;
}

/** panel 会议 → 落成本地会议。靠 feishu_meeting_id 幂等去重·同一 meeting_id 串行（防并发重复建）。本地写失败会抛 → 上层不推 cursor。 */
async function upsertPanelMeeting(mt: PanelFeishuMeeting, type: PanelMeetingUpsertType, occurredAt = 0): Promise<void> {
  if (!mt.meeting_id) return;
  const key = mt.meeting_id;
  const prev = panelUpserts.get(key) ?? Promise.resolve();
  const job = prev.catch(() => {}).then(() => upsertPanelMeetingInner(mt, type, occurredAt)).finally(() => {
    if (panelUpserts.get(key) === job) panelUpserts.delete(key);
  });
  panelUpserts.set(key, job);
  await job;
}

/** 归群「两条腿」：① group_ids 自动归真群 → ② 认领映射 → ③ 已在真飞书群保持 → ④ 日历会议无群保持日程占位 → ⑤ 无群桶。 */
async function resolveMeetingWorkspace(mt: PanelFeishuMeeting, existing: PersistedMeeting | null, existingWs: PersistedWorkspace | null): Promise<PersistedWorkspace> {
  if (mt.group_ids?.[0]) return upsertFeishuWorkspace(mt.group_ids[0], mt.topic || existingWs?.name || '飞书会议'); // ① 自动归群
  const claimed = resolveClaim({ meetingNo: mt.meeting_no, topic: mt.topic });                                     // ② 认领映射（用户准备会议时认领过）
  if (claimed) { const w = await getWorkspace(claimed); if (w) return w; }
  if (existingWs && existingWs.source === 'feishu') return existingWs;                                              // ③ 已在真飞书群·保持
  if (existing?.source_kind === 'calendar' && existingWs) return existingWs;                                       // ④ 日历会议无群·保持日程占位群
  return upsertPanelWorkspace('飞书会议');                                                                          // ⑤ 无群桶
}

async function upsertPanelMeetingInner(mt: PanelFeishuMeeting, type: PanelMeetingUpsertType, occurredAt = 0): Promise<void> {
  let existing = await findLocalPanelMeeting(mt.meeting_id);
  // B 归群桥：feishu_meeting_id 未命中时，用会议号匹配已落库的日历日程会议 → 合并升级同一张卡（不新建第二张）。
  if (!existing && mt.meeting_no) {
    const no = String(mt.meeting_no);
    existing = (await listAllMeetings()).find((m) => !m.feishu_meeting_id && m.calendar_meeting_no === no) ?? null;
  }
  const existingWs = existing ? await getWorkspace(existing.workspace_id) : null;
  // M1·status 严格飞书驱动 + started_at(时间轴 t0)用飞书真实开始时间：
  //   t0 = start_time → started 事件 occurred_at → 已存真 t0；都没有则不写 started_at（不再用本机 now 伪造）。
  const eventMs = Number.isFinite(occurredAt) && occurredAt > 0 ? occurredAt : 0;
  const hasRealStart = typeof mt.start_time === 'number' && Number.isFinite(mt.start_time) && mt.start_time > 0;
  const existingT0 = typeof existing?.vc_meeting_start_t0 === 'number' && Number.isFinite(existing.vc_meeting_start_t0) ? existing.vc_meeting_start_t0 : 0;
  const realT0 = hasRealStart ? mt.start_time! : (type === 'started' && eventMs > 0 ? eventMs : existingT0);
  const endMs = typeof mt.end_time === 'number' && mt.end_time > 0 ? mt.end_time : (type === 'ended' ? eventMs : 0);
  const scheduledIso = realT0 ? new Date(realT0).toISOString() : (existing?.scheduled_at || existing?.started_at || new Date().toISOString());
  const ws = await resolveMeetingWorkspace(mt, existing, existingWs); // 归群「两条腿」（自动 group_ids / 认领映射 / 保持）
  const base = existing ?? await createMeeting(ws.workspace_id, { title: mt.topic || '飞书会议', scheduled_at: scheduledIso });
  // started/active 快照→live（除非本地已 ended·防 active 把已结束刷回 live）；ended→ended；metadata→保持既有 status。
  const nextStatus: MeetingStatus = type === 'ended'
    ? 'ended'
    : type === 'started'
      ? (existing?.status === 'ended' ? 'ended' : 'live')
      : (existing?.status ?? 'upcoming');
  // M7·前台提醒：刚从非 live 变 live → 标未读（nav 徽标 + home 顶部横幅），用户点开这场会（openMeeting）即清。
  // 已经在这场会议的画板里（会前进画板后事件才迟到）不用提醒自己——人本就在现场。
  const justWentLive = nextStatus === 'live' && existing?.status !== 'live' && !(liveMtg && liveMtg.id === base.meeting_id);
  const minuteToken = panelMinuteToken(mt);
  const saved = await updateMeeting(base.meeting_id, {
    workspace_id: ws.workspace_id,                 // 迁移到正确 workspace（无群→manual·后续拿到真群→迁真群）
    title: mt.topic || base.title,
    scheduled_at: scheduledIso,
    status: nextStatus,
    ...(realT0 ? { started_at: new Date(realT0).toISOString() } : {}),  // 只有飞书真实 t0 才落 started_at（M1·不伪造）
    ...(endMs ? { ended_at: new Date(endMs).toISOString() } : {}),
    ...(justWentLive ? { live_unread: true } : {}),
    ...(nextStatus === 'ended' ? { live_unread: false } : {}), // 会都结束了·「现在有会议开始了」的提醒不再有意义
    // 只有真 VC meeting_id 才落 feishu_meeting_id；短号(meeting_no)冒充时不写（避免周期会实例共享同一 id 导致错配）。
    ...(mt.meeting_id && mt.meeting_id !== mt.meeting_no ? { feishu_meeting_id: mt.meeting_id } : {}),
    feishu_meeting_no: mt.meeting_no,
    feishu_topic: mt.topic,
    source_kind: 'vc',                                                                  // panel VC 接管（syncCalendarMeetings 不再回刷此卡）
    ...(mt.meeting_no && !base.calendar_meeting_no ? { calendar_meeting_no: String(mt.meeting_no) } : {}),
    ...(realT0 ? { vc_meeting_start_t0: realT0, t0_source: 'vc_event', align_state: 'event', panel_meeting_start: realT0 } : {}),
    ...(minuteToken ? { feishu_minute_token: minuteToken } : {}),
    ...(mt.minute_url ? { feishu_minute_url: mt.minute_url } : {}),
  });
  if (!saved) throw new Error(`本地会议写入失败（同步 panel 会议 ${mt.meeting_id}）`); // 写失败 → 上层不推 cursor·下次重放
  // M7·跨屏幕提醒：rail 黑点/首页横幅只在会议首页看得到，用户在阅读页/dev页/会中都会错过——补一条全局 toast。
  if (justWentLive) {
    showMobileToast({
      id: `meeting-live:${saved.meeting_id}`,
      level: 'urgent',
      title: '会议开始了',
      message: saved.title || '飞书会议',
      action: { label: '进入', run: () => void openMeeting(saved.workspace_id, saved.meeting_id) },
      durationMs: 'sticky',
    });
    devEmit('meeting', () => ({ ev: 'live_toast_shown', meeting_id: saved.meeting_id, title: saved.title, source: type }));
  }
  if (nextStatus === 'ended') dismissMobileToast(`meeting-live:${base.meeting_id}`);
  // 正在这场记录工作台里 → 事件迟到时热更 status/t0/结束时长（不强制跳页·用户还在画板·只更状态条/脊）。
  if (liveMtg && liveMtg.id === base.meeting_id) {
    liveMtg.status = nextStatus;
    if (realT0) liveMtg.startedAt = realT0;
    if (nextStatus === 'ended') { liveMtg.frozenAt = (endMs || meetingNowMs()); stopMeetingBedrock(); }
    else if (nextStatus === 'live') { liveMtg.frozenAt = 0; startMeetingBedrock(); }
    startClock();
    void refreshSpine();
  }
}

/** minute_bound：把妙记 token 写回本地会议（解锁转写对轴）。缺 token=数据问题·跳过不堵流；本地写失败=抛·不推 cursor。 */
async function applyPanelMinuteBound(mt: PanelFeishuMeeting): Promise<void> {
  if (!mt.meeting_id) return;
  if (!panelMinuteToken(mt)) { console.warn('[panel] minute_bound 缺 token·跳过', mt.meeting_id); return; }
  await upsertPanelMeeting(mt, 'metadata');
}

/** summary_ready：写回元数据后按 meeting_id 拉 panel 总结缓存。拉总结失败=best-effort 吞掉（下次进 recap 再拉）；本地会议写失败=抛·不推 cursor。 */
async function applyPanelSummaryReady(mt: PanelFeishuMeeting): Promise<void> {
  if (!mt.meeting_id) return;
  await upsertPanelMeeting(mt, 'metadata'); // 写会议元数据·失败抛
  const local = await findLocalPanelMeeting(mt.meeting_id);
  if (!local) return;
  const prevAt = local.panel_summary?.generated_at ?? 0;
  try {
    const r = await refreshPanelSummaryCache(local);
    // 后台到达「更新的」总结 → 标未读（home/detail 提醒·进 recap 时清）。重放同一份 generated_at 不变 → 不重复标。
    if (r.summary && r.summary.generated_at > prevAt) await updateMeeting(local.meeting_id, { panel_summary_unread: true });
  } catch (e) { console.warn('[panel] summary_ready 拉总结失败（进 recap 时再拉）：', e); }
}

/** 分发一条 panel 事件。未知类型忽略（向前兼容）。本地写失败冒泡 → syncPanelMeetings 中断 → 不推 cursor → 下次重放。 */
async function consumePanelMeetingEvent(ev: PanelMeetingEvent): Promise<void> {
  switch (ev.type) {
    case 'started':
    case 'ended': await upsertPanelMeeting(ev.meeting, ev.type, ev.occurred_at); return; // occurred_at=飞书会议真实开始/结束时刻（M1·t0 基准）
    case 'minute_bound': await applyPanelMinuteBound(ev.meeting); return;
    case 'summary_ready': await applyPanelSummaryReady(ev.meeting); return;
    default: return;
  }
}

/** 拉 panel 增量会议事件 + 进行中快照，落成本地会议。失败静默（不阻断 home·退回纯本地）。 */
async function syncPanelMeetings(): Promise<void> {
  const since = Number(localStorage.getItem(PANEL_CURSOR_KEY) || 0) || 0;
  const feed = await pollPanelMeetingEvents(since);
  // 逐条消费·任一条本地写失败即抛 → 中断循环 → 不推 cursor → 下次重放（不静默丢同步）。
  for (const ev of feed.events) await consumePanelMeetingEvent(ev);
  if (feed.cursor && feed.cursor !== since) localStorage.setItem(PANEL_CURSOR_KEY, String(feed.cursor));
  // 无 cursor / 迟到打开：补进行中会议（active·12h 内未结束）
  for (const mt of await listActivePanelMeetings()) await upsertPanelMeeting(mt, 'started');
}

/** syncPanelMeetings 观测包装：记「上次同步成功/失败时间」(设置页诊断用) + devtel meeting 事件。
 *  不改变异常语义——调用方原有的 `.catch(() => {})` 照常生效，这里只是在中间插一道可观测性。 */
async function syncPanelMeetingsObserved(): Promise<void> {
  devEmit('meeting', () => ({ ev: 'panel_sync_start' }));
  try {
    await syncPanelMeetings();
    notePanelSyncOk();
    devEmit('meeting', () => ({ ev: 'panel_sync_ok' }));
  } catch (e) {
    notePanelSyncError(e);
    devEmit('meeting', () => ({ ev: 'panel_sync_fail', error: String((e as Error)?.message || e) }));
    throw e;
  }
}

// ════ A：飞书日历日程 → 落成 upcoming 会议对象（日程卡=会议卡统一·可准备/可被 started 归群合并）════
function calendarIssueText(res: FeishuCalendarEventsResponse | null): string {
  const code = res?.error?.code || '';
  if (code === 'missing_calendar_scope') return '机器人日历权限未开通。请在飞书开放平台开通 calendar:calendar:read / calendar:calendar.event:read 后刷新。';
  if (code === 'not_configured') return '机器人日历源未配置。请在 Cloud Hub 配置飞书机器人 App ID / Secret。';
  if (res?.error?.message) return `飞书日历同步失败：${res.error.message}`;
  return '';
}

function existingMeetingForSource(all: PersistedMeeting[], source: FeishuMeetingSource): PersistedMeeting | undefined {
  if (source.calendar_event_id) {
    const byCalendarEvent = all.find((m) => m.feishu_calendar_event_id === source.calendar_event_id);
    if (byCalendarEvent) return byCalendarEvent;
  }
  if (source.feishu_meeting_id) {
    const byMeetingId = all.find((m) => m.feishu_meeting_id === source.feishu_meeting_id);
    if (byMeetingId) return byMeetingId;
  }
  const no = source.meeting_no || meetingNoFromUrl(source.meeting_url);
  if (!no) return undefined;
  const scheduledDay = source.scheduled_at.slice(0, 10);
  return all.find((m) => {
    if (m.feishu_meeting_no !== no && m.calendar_meeting_no !== no) return false;
    return !m.scheduled_at || !scheduledDay || m.scheduled_at.slice(0, 10) === scheduledDay;
  });
}

async function sourceWorkspace(source: FeishuMeetingSource, existing?: PersistedMeeting): Promise<PersistedWorkspace> {
  if (source.chat_id) return upsertFeishuWorkspace(source.chat_id, source.chat_name || source.title || '飞书群');
  if (existing) {
    const ws = await getWorkspace(existing.workspace_id);
    if (ws) return ws;
  }
  const claimed = resolveClaim({ meetingNo: source.meeting_no || meetingNoFromUrl(source.meeting_url), topic: source.title });
  if (claimed) {
    const ws = await getWorkspace(claimed);
    if (ws) return ws;
  }
  return source.source === 'lark_meeting_timeline' ? upsertPanelWorkspace('飞书会议') : upsertScheduleWorkspace();
}

async function syncMeetingSources(): Promise<{ connected: boolean; imported: number; issue?: string }> {
  const res = await feishuGet<FeishuMeetingSourcesResponse>('/api/feishu/meeting-sources?lookback_days=30&lookahead_days=14&page_size=10');
  if (!res) return { connected: false, imported: 0 };
  const sources = (res.sources || []).filter((source) => source.scheduled_at && (source.feishu_meeting_id || source.meeting_no || source.calendar_event_id || source.meeting_url));
  let all = await listAllMeetings();
  let imported = 0;
  for (const source of sources) {
    const existing = existingMeetingForSource(all, source);
    const ws = await sourceWorkspace(source, existing);
    const meetingNo = source.meeting_no || meetingNoFromUrl(source.meeting_url);
    const patch: Partial<PersistedMeeting> = {
      workspace_id: ws.workspace_id,
      title: source.title || existing?.title || '飞书会议',
      scheduled_at: source.scheduled_at,
      status: source.status || existing?.status || 'upcoming',
      source_kind: source.source === 'lark_meeting_timeline' ? 'vc' : existing?.source_kind === 'vc' ? 'vc' : 'calendar',
      ...(source.started_at
        ? { started_at: source.started_at, vc_meeting_start_t0: new Date(source.started_at).getTime(), t0_source: 'vc_event', align_state: 'event' }
        : source.status === 'live'
          ? { started_at: source.scheduled_at, vc_meeting_start_t0: new Date(source.scheduled_at).getTime(), t0_source: 'calendar', align_state: 'estimated' }
          : {}),
      ...(source.ended_at ? { ended_at: source.ended_at } : {}),
      // 短号冒充 meeting_id 时不写 feishu_meeting_id（周期会所有实例共享同一短号会互相错配）。
      ...(source.feishu_meeting_id && source.feishu_meeting_id !== meetingNo ? { feishu_meeting_id: source.feishu_meeting_id } : {}),
      ...(meetingNo ? { feishu_meeting_no: meetingNo, calendar_meeting_no: meetingNo } : {}),
      ...(source.title ? { feishu_topic: source.title } : {}),
      ...(source.feishu_minute_token ? { feishu_minute_token: source.feishu_minute_token } : {}),
      ...(source.calendar_event_id ? { feishu_calendar_event_id: source.calendar_event_id } : {}),
      ...(ws.source === 'feishu' ? { group_claimed_at: new Date().toISOString() } : {}),
    };
    if (existing) {
      if (existing.source_kind === 'vc' && source.source !== 'lark_meeting_timeline' && source.status !== 'ended') continue;
      await updateMeeting(existing.meeting_id, patch);
    } else {
      const created = await createMeeting(ws.workspace_id, { title: patch.title || '飞书会议', scheduled_at: source.scheduled_at, status: patch.status || 'upcoming' });
      await updateMeeting(created.meeting_id, patch);
      imported += 1;
      all = [...all, { ...created, ...patch, updated_at: new Date().toISOString() } as PersistedMeeting];
    }
  }
  const issue = res.errors?.find((error) => error.source === 'lark_meeting_timeline_search' || error.source === 'lark_meeting_timeline_lookup')?.message;
  return { connected: !!res.connected, imported, issue };
}

function mergeFeishuEvents(groups: FeishuEvent[][]): FeishuEvent[] {
  const byId = new Map<string, FeishuEvent>();
  for (const event of groups.flat()) {
    if (!event.event_id) continue;
    const key = `${event.source || 'calendar'}:${event.calendar_id || ''}:${event.event_id}`;
    byId.set(key, event);
  }
  return [...byId.values()].sort((a, b) => fsEventWhen(a) - fsEventWhen(b));
}

/** 拉用户 OAuth 日历 + 机器人应用日历，把日程幂等落成本地 upcoming 会议（feishu_calendar_event_id 去重）。
 *  返回 {connected, events, issue} 供 renderHome 复用、避免重复请求。已被 panel started 升级成 vc 的不回刷。 */
async function syncCalendarMeetings(): Promise<{ connected: boolean; events: FeishuEvent[]; issue?: string }> {
  const eventGroups: FeishuEvent[][] = [];
  let connected = false;
  let issue = '';
  const oauth = await feishuGet<{ connected: boolean }>('/api/feishu/oauth/status');
  if (oauth?.connected) {
    const ev = await feishuGet<{ events: FeishuEvent[] }>('/api/feishu/my/events');
    if (ev?.events?.length) eventGroups.push(ev.events);
    connected = true;
  }
  const bot = await feishuGet<FeishuCalendarEventsResponse>('/api/feishu/bot/events?lookahead_days=14');
  if (bot?.connected) {
    if (bot.events?.length) eventGroups.push(bot.events);
    connected = true;
  } else if (!connected) {
    issue = calendarIssueText(bot);
  }
  const events = mergeFeishuEvents(eventGroups);
  const all = await listAllMeetings();
  const byCalId = new Map(all.filter((m) => m.feishu_calendar_event_id).map((m) => [m.feishu_calendar_event_id!, m] as const));
  let schedWsId = '';
  for (const e of events.filter((x) => x.has_meeting || x.source === 'bot_calendar')) { // bot 可访问的日历默认就是会议安排来源
    const startIso = new Date(fsEventWhen(e)).toISOString();
    const endMs = fsEventEnd(e);
    const endIso = endMs > 0 ? new Date(endMs).toISOString() : undefined;
    const status = scheduledMeetingStatus(startIso, endIso);
    const meetingNo = meetingNoFromUrl(e.vchat?.meeting_url);
    const existing = byCalId.get(e.event_id);
    if (existing) {
      if (existing.source_kind === 'vc') continue;             // 已被 panel started 接管，日历不插手
      await updateMeeting(existing.meeting_id, {
        title: e.summary || existing.title, scheduled_at: startIso,
        status,
        ...(status === 'live' && !existing.started_at ? { started_at: startIso, vc_meeting_start_t0: Date.parse(startIso), t0_source: 'calendar', align_state: 'estimated' } : {}),
        ...(status === 'ended' && endIso ? { ended_at: endIso } : {}),
        ...(meetingNo ? { calendar_meeting_no: meetingNo } : {}),
      });
      continue;
    }
    const claimedWs = resolveClaim({ meetingNo, topic: e.summary });   // 认领映射命中→直接归群；否则落日程占位群
    if (!claimedWs && !schedWsId) schedWsId = (await upsertScheduleWorkspace()).workspace_id;
    const m = await createMeeting(claimedWs || schedWsId, { title: e.summary || '会议日程', scheduled_at: startIso, status });
    await updateMeeting(m.meeting_id, {
      source_kind: 'calendar', feishu_calendar_event_id: e.event_id, feishu_topic: e.summary,
      ...(status === 'live' ? { started_at: startIso, vc_meeting_start_t0: Date.parse(startIso), t0_source: 'calendar', align_state: 'estimated' } : {}),
      ...(status === 'ended' && endIso ? { ended_at: endIso } : {}),
      ...(meetingNo ? { calendar_meeting_no: meetingNo } : {}),
      ...(claimedWs ? { group_claimed_at: new Date().toISOString() } : {}),
    });
  }
  return { connected, events, issue };
}

// ════ home：日程子页 / 群聊子页（data-meet 切换·仿阅读页二级导航）════
let fsConnectedCache = false; // 飞书日历连接态（syncHomeData 更新·日程子页 badge 用·切子页免重新请求）
let fsCalendarIssue = '';
let fsIdentityCache: FeishuIdentityResponse | null = null;

/** 同步会议数据：panel 事件 + 日历日程落库 + 飞书群→工作区。进入会议页 / 后台轮询时跑；切子页不跑。 */
async function syncHomeData(): Promise<void> {
  fsIdentityCache = await feishuGet<FeishuIdentityResponse>('/api/feishu/me').catch(() => null);
  await refreshCoreSessionFromAuthority().catch(() => false); // 校准前端 core session=后端飞书身份（fsIdentityCache 只给会议 UI，不改 core session）
  updateCloudClock(fsIdentityCache?.server_now_ms);
  await syncPanelMeetingsObserved().catch(() => {}); // L1：panel VC 会议 → 本地会议（真 t0 + 归群）
  const cal = await syncCalendarMeetings().catch((e) => ({ connected: false, events: [] as FeishuEvent[], issue: `飞书日历同步失败：${String((e as Error)?.message || e)}` })); // A：日历日程 → 本地 upcoming 会议
  fsConnectedCache = cal.connected;
  fsCalendarIssue = cal.issue || '';
  const wsRes = await feishuGet<{ workspaces: Array<{ chat_id: string; name: string; chat_status: string }> }>('/api/feishu/workspaces');
  if (wsRes) for (const w of wsRes.workspaces || []) if (w.chat_status === 'normal') await upsertFeishuWorkspace(w.chat_id, w.name);
  const meetingSources = await syncMeetingSources().catch((e) => ({ connected: false, imported: 0, issue: `飞书会议源同步失败：${String((e as Error)?.message || e)}` }));
  fsConnectedCache = fsConnectedCache || meetingSources.connected;
  if (!fsCalendarIssue && meetingSources.issue) fsCalendarIssue = meetingSources.issue;
}

/** home 数据签名：workspace 名称/来源 + 会议状态/标题/时间/未读标记，任一变化才值得重渲（电纸屏免无谓刷新）。
 *  meetingPollTick 的变化判断也复用同一份定义，别各写一套（否则两处对「什么算变化」不一致）。 */
function homeSig(workspaces: PersistedWorkspace[], meetings: PersistedMeeting[]): string {
  const ws = workspaces.map((w) => [w.workspace_id, w.name, w.source, w.feishu_chat_id || '', w.updated_at].join(':')).sort().join('|');
  const mtg = meetings.map((m) => [
    m.meeting_id, m.updated_at, m.workspace_id, m.status, m.title, m.scheduled_at,
    m.live_unread ? 'L' : '', m.panel_summary_unread ? 'S' : '', m.feishu_meeting_id || '', m.calendar_meeting_no || '',
  ].join(':')).sort().join('|');
  const clock = Math.floor(meetingNowMs() / 60_000);
  const identity = [
    fsIdentityCache?.oauth?.authenticated ? 'auth' : 'noauth',
    fsIdentityCache?.oauth?.connected ? 'connected' : 'disconnected',
    fsIdentityCache?.session?.feishu_open_id || '',
  ].join(':');
  return `${identity}@${clock}#${ws}#${mtg}`;
}

/** 纯本地读取（IndexedDB，无网络）+ 签名，local-first 渲染和轮询变化判断共用。 */
async function readHomeLocal(): Promise<{ workspaces: PersistedWorkspace[]; allMeetings: PersistedMeeting[]; sig: string }> {
  const [workspaces, allMeetings] = await Promise.all([listWorkspaces(), listAllMeetings()]);
  return { workspaces, allMeetings, sig: homeSig(workspaces, allMeetings) };
}

let homeSyncing = false; // 冷启动(本地无缓存)时 revalidateHome 在跑 → 空态文案区分「真没有」vs「正在拉」

/** 纯渲染：只读已经拿到的本地数据画 DOM，不做任何网络/IO。 */
function renderHomeFromData(workspaces: PersistedWorkspace[], allMeetings: PersistedMeeting[], opts?: { keepPage?: boolean }): void {
  const wsName = new Map(workspaces.map((w) => [w.workspace_id, w.name]));
  // M7·会议开始可感知：飞书 started 事件把某场会推成 live 且用户还没点开看过 → 顶部提醒（比总结更急，排最前）。
  const liveUnread = allMeetings.filter((m) => m.live_unread && effectiveMeetingStatus(m) === 'live');
  void refreshMeetNavBadge(); // 同一批数据顺手同步 nav 徽标，别等下一拍轮询（12s）才追上

  // #1 会后总结可感知：summary_ready 后台到达标了 panel_summary_unread → 顶部提醒（两子页都挂）。
  const unread = allMeetings.filter((m) => m.panel_summary_unread);

  {
    // 会议列表（meeting-flow 单状态机·点会议按 status 直达）：未结束（进行中+待开始·升序）+ 已结束历史（降序·最近 20）。
    const buckets = meetingHomeBuckets(allMeetings, { nowMs: meetingNowMs() });
    const sched = buckets.active;
    const ended = buckets.history;
    const historyTotal = buckets.historyTotal;
    const localSession = getSession();
    const fsIdentityOk = !!(
      fsIdentityCache?.oauth?.authenticated
      || fsIdentityCache?.session?.feishu_open_id
      || localSession?.userId?.startsWith('feishu_')
    );
    const fsOk = fsIdentityOk
      ? `<button class="fs-ok fs-ok-btn" id="mh-identity" type="button" title="飞书身份"><span class="d"></span>飞书身份</button>`
      : `<button class="hbtn" id="mh-identity" type="button">登录飞书</button>`;
    const items: string[] = [];
    if (meetingHomeFilter === 'active' && liveUnread.length) {
      items.push(`<button class="hbtn" id="mh-live" style="display:block;width:calc(100% - 36px);margin:10px 18px 0;text-align:left;font-weight:600">🔔 ${liveUnread.length === 1 ? `「${esc(liveUnread[0].title)}」现在开始了` : `${liveUnread.length} 场会议现在开始了`} · 点击参加 ›</button>`);
    }
    if (meetingHomeFilter === 'active' && unread.length) {
      items.push(`<button class="hbtn" id="mh-unread" style="display:block;width:calc(100% - 36px);margin:10px 18px 0;text-align:left;font-weight:600">📋 ${unread.length} 场会议输出已同步 · 点开看 ›</button>`);
    }
    // local-first 冷启动：本地真没缓存 + 后台正在拉 → 别让用户误以为「真的没有会议」，文案区分「正在同步」vs「确实没有」。
    if (meetingHomeFilter === 'active' && sched.length) items.push(...sched.map((m) => mrow(m, wsName.get(m.workspace_id))));
    else if (meetingHomeFilter === 'active') {
      items.push(homeSyncing
        ? `<p class="empty">正在同步日程…</p>`
        : `<p class="empty">${esc(fsCalendarIssue || '还没有待开始或进行中的会议。历史会议在右上方「历史」里查看。')}</p>`);
    }
    // 已结束=历史：点进直达「会后时间轴对齐」(openMeeting→openRecap)。段头用裸 div（不包 mrow·避免超高单块被 pager 推成空首页）。
    if (meetingHomeFilter === 'history' && ended.length) {
      items.push(...ended.map((m) => mrow(m, wsName.get(m.workspace_id))));
    } else if (meetingHomeFilter === 'history') {
      items.push(`<p class="empty">还没有已结束的会议。会议结束后，会后记录会自动出现在这里。</p>`);
    }
    const pageSize = window.innerWidth >= 1000 ? 12 : 8;
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    if (!opts?.keepPage) meetingHomePage = 0;
    meetingHomePage = Math.min(Math.max(0, meetingHomePage), pageCount - 1);
    const start = meetingHomePage * pageSize;
    const visibleRows = items.slice(start, start + pageSize).join('');
    const pagerHtml = pageCount > 1
      ? `<div class="vpager-bar" id="mh-pager"><button class="vpager-prev" type="button" aria-label="上一页"${meetingHomePage <= 0 ? ' disabled' : ''}>‹</button><span class="vpager-pn">${meetingHomePage + 1} / ${pageCount}</span><button class="vpager-next" type="button" aria-label="下一页"${meetingHomePage >= pageCount - 1 ? ' disabled' : ''}>›</button></div>`
      : '';
    // 模拟会议仅 DEV 联调用、且需先有真飞书群（startSimMeeting 依赖群）→ 生产/无群时隐藏，空态才自洽（#6）
    const hasFeishuGroup = workspaces.some((w) => w.workspace_id !== 'ws_schedule' && w.source === 'feishu');
    const simBtn = import.meta.env.DEV && hasFeishuGroup ? '<button class="hbtn" id="mh-sim">模拟会议</button>' : '';
    const bindBtn = meetingHomeFilter === 'active' ? '<button class="hbtn" id="mh-bind-current" type="button">绑定当前会议</button>' : '';
    const filterHtml =
      `<div class="mh-tabs" role="tablist" aria-label="会议筛选">`
      + `<button type="button" role="tab" data-mh-filter="active" aria-selected="${meetingHomeFilter === 'active'}" class="${meetingHomeFilter === 'active' ? 'on' : ''}"><span>进行中/待开始</span><b>${sched.length}</b></button>`
      + `<button type="button" role="tab" data-mh-filter="history" aria-selected="${meetingHomeFilter === 'history'}" class="${meetingHomeFilter === 'history' ? 'on' : ''}"><span>历史</span><b>${historyTotal}</b></button>`
      + `</div>`;
    mtgPagers.get('home')?.destroy();
    mtgPagers.delete('home');
    el('mv-home').classList.toggle('has-vpages', pageCount > 1);
    el('mv-home').innerHTML =
      `<div class="vhead meeting-home-head"><button class="book-back meeting-back" id="mh-books" type="button" aria-label="返回书架">${SVG_BACK}<span>书架</span></button><h1>会议</h1>${filterHtml}<span class="sp"></span>${bindBtn}${fsOk}${simBtn}</div>`
      + `<div class="mbody">${visibleRows}</div>${pagerHtml}`;
    el('mv-home').querySelector('#mh-books')?.addEventListener('click', () => exitToBookShelf());
    el('mv-home').querySelectorAll<HTMLElement>('[data-mh-filter]').forEach((button) => button.addEventListener('click', () => {
      const next = normalizeMeetingHomeFilter(button.dataset.mhFilter);
      if (next === meetingHomeFilter) return;
      rememberMeetingHomeFilter(next);
      renderHomeFromData(workspaces, allMeetings);
    }));
    wireRows(el('mv-home'));
    el('mv-home').querySelector('.vpager-prev')?.addEventListener('click', () => { meetingHomePage -= 1; renderHomeFromData(workspaces, allMeetings, { keepPage: true }); });
    el('mv-home').querySelector('.vpager-next')?.addEventListener('click', () => { meetingHomePage += 1; renderHomeFromData(workspaces, allMeetings, { keepPage: true }); });
    el('mv-home').querySelector('#mh-sim')?.addEventListener('click', async () => {
      const m = await startSimMeeting();
      if (!m) { await infoSheet({ title: '模拟会议', message: '先连一个飞书群（机器人所在群会自动同步成工作区）再开模拟会议。' }); return; }
      void openMeeting(m.workspace_id, m.meeting_id);
    });
    el('mv-home').querySelector('#mh-bind-current')?.addEventListener('click', () => { void bindCurrentFeishuMeeting(); });
    el('mv-home').querySelector('#mh-identity')?.addEventListener('click', () => { void openFeishuIdentitySheet(); });
  }
  el('mv-home').querySelector('#mh-live')?.addEventListener('click', () => { // 跳第一场刚开始的会议（openMeeting 会清 live_unread）
    const first = liveUnread[0];
    if (!first) return;
    void openMeeting(first.workspace_id, first.meeting_id);
  });
  el('mv-home').querySelector('#mh-unread')?.addEventListener('click', () => { // 跳第一场有新总结的会议详情
    const first = unread[0];
    if (!first) return;
    void openMeeting(first.workspace_id, first.meeting_id);
  });
}

async function bindCurrentFeishuMeeting(): Promise<void> {
  const values = await formSheet({
    title: '绑定当前飞书会议',
    fields: [
      { key: 'meeting_url', label: '会议链接或会议号', placeholder: 'https://vc.feishu.cn/j/...' },
      { key: 'title', label: '会议标题', value: '当前飞书会议' },
    ],
    confirm: '绑定',
  });
  if (!values) return;
  const raw = (values.meeting_url || '').trim();
  const title = (values.title || '').trim() || '当前飞书会议';
  if (!raw) {
    await infoSheet({ title: '绑定当前会议', message: '请输入飞书会议链接或会议号。' });
    return;
  }
  const meetingUrl = raw.startsWith('http') ? raw : '';
  const meetingNo = meetingUrl ? meetingNoFromUrl(meetingUrl) : raw.replace(/\D/g, '');
  try {
    await postJson('/api/feishu-svc/api/feishu/meeting-sources/manual', {
      title,
      status: 'live',
      scheduled_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ...(meetingUrl ? { meeting_url: meetingUrl } : {}),
      ...(meetingNo ? { meeting_no: meetingNo } : {}),
    }, { auth: true });
    await syncMeetingSources().catch(() => null);
    await renderHome({ sync: 'blocking', keepPage: true });
  } catch (e) {
    await infoSheet({ title: '绑定失败', message: String((e as Error)?.message || e) });
  }
}

function feishuOAuthRedirectMode(): 'web' {
  return 'web';
}

async function startDeviceFeishuLogin(): Promise<void> {
  const redirect = feishuOAuthRedirectMode();
  const payload = await getJson<{ auth_url: string; redirect_mode?: string }>(`/api/feishu-svc/api/feishu/oauth/device/start?redirect=${redirect}`, { auth: true });
  if (!payload.auth_url) throw new Error('missing_feishu_auth_url');
  window.location.href = payload.auth_url;
}

function identitySummary(me: FeishuIdentityResponse): string {
  const openId = me.session?.feishu_open_id || '未绑定';
  const userId = me.session?.user_id || '未知';
  const missing = me.oauth?.missing_scopes?.length ? `\n缺少权限：${me.oauth.missing_scopes.join(', ')}` : '';
  const groups = me.team_access?.groups || [];
  const groupText = groups.length
    ? groups.map((group) => `- ${group.name}${group.member_name ? `（${group.member_name}）` : ''}`).join('\n')
    : '暂无可访问群。请确认团队机器人已加入对应群，且你是该群成员。';
  return `当前用户：${userId}\n飞书身份：${openId}${missing}\n\n可访问团队群：\n${groupText}`;
}

async function openFeishuIdentitySheet(): Promise<void> {
  const me = await feishuGet<FeishuIdentityResponse>('/api/feishu/me');
  if (!me?.oauth?.authenticated && !me?.session?.feishu_open_id) {
    const ok = await confirmSheet({
      title: '登录飞书',
      message: '设备端只需要登录飞书身份。团队机器人由 Cloud Hub 管理员统一配置，登录后会按群成员关系自动分配会议访问权。',
      confirm: '去登录',
    });
    if (!ok) return;
    try { await startDeviceFeishuLogin(); }
    catch (e) { await infoSheet({ title: '飞书登录失败', message: String((e as Error)?.message || e) }); }
    return;
  }
  const missingScopes = me.oauth?.missing_scopes || [];
  const shouldRelogin = missingScopes.length || me.oauth?.reason;
  const ok = await confirmSheet({
    title: '飞书身份',
    message: identitySummary(me),
    confirm: shouldRelogin ? '重新授权' : '刷新',
  });
  if (!ok) return;
  if (shouldRelogin) {
    try { await startDeviceFeishuLogin(); }
    catch (e) { await infoSheet({ title: '飞书登录失败', message: String((e as Error)?.message || e) }); }
    return;
  }
  await renderHome({ sync: 'blocking', keepPage: true });
}

let homeRevalidateInFlight: Promise<void> | null = null;

/** 后台把本地数据和远端对齐；对齐完签名没变就什么都不做（电纸屏免无谓刷新），变了才在停留 home 时重渲。
 *  `wasEmpty`=发起时本地列表是空的（冷启动/真无会议两种可能都长这样）——这种情况即使 sig 没变（空→空）也要重渲一次，
 *  否则空态文案会永远卡在「正在同步日程…」（sig 比较只看会议数据本身，不知道「正在同步」这行字要不要摘掉）。
 *  并发调用共享同一个 in-flight（poll tick 和 renderHome 的 revalidate 可能前后脚触发，别重复打网络）。 */
function revalidateHome(beforeSig: string, wasEmpty: boolean): Promise<void> {
  if (homeRevalidateInFlight) return homeRevalidateInFlight;
  homeSyncing = true;
  homeRevalidateInFlight = (async () => {
    try { await syncHomeData(); } catch { /* 静默：本地数据仍在，下次轮询/进入再试 */ }
    homeSyncing = false;
    const after = await readHomeLocal();
    if (after.sig === beforeSig && !wasEmpty) return; // 没变化且当初不是空态：别打扰用户正在看的页面
    lastMeetingSig = after.sig;
    if (document.body.dataset.mode === 'meet' && document.body.dataset.mtg === 'home') {
      renderHomeFromData(after.workspaces, after.allMeetings, { keepPage: true });
    } else {
      void refreshMeetNavBadge(); // 用户已经离开 home（切了子页/进了详情）：只顺手同步一下 nav 徽标，别硬重渲当前页
    }
  })().finally(() => { homeRevalidateInFlight = null; });
  return homeRevalidateInFlight;
}

/** 会议首页：data-meet 决定渲染「日程」(待开始/进行中会议纵向列表) 或「群聊」(群聊书架)。
 *  local-first：先用本地已有数据立即渲染（不等网络），网络同步挪到后台，数据真变化了才重渲一次。
 *  opts.sync：false=纯本地重渲、不触发任何后台同步（调用方已经自己同步过）；'blocking'=旧行为、等同步完成再渲（目前没有调用点用，留给未来显式刷新入口）；
 *  默认(undefined/true)=local-first。 */
async function renderHome(opts?: { sync?: boolean | 'blocking'; keepPage?: boolean }): Promise<void> {
  if (opts?.sync !== false) await refreshCloudClock().catch(() => {});
  if (opts?.sync === 'blocking') await syncHomeData();
  const local = await readHomeLocal();
  lastMeetingSig = local.sig;
  const willRevalidate = opts?.sync !== false && opts?.sync !== 'blocking';
  const wasEmpty = local.allMeetings.length === 0;
  // 空态 + 即将后台同步：这次渲染就带上「正在同步」标记，否则用户会先看一眼「还没有会议」再跳成同步中，观感倒退。
  if (willRevalidate && wasEmpty) homeSyncing = true;
  renderHomeFromData(local.workspaces, local.allMeetings, opts);
  if (willRevalidate) void revalidateHome(local.sig, wasEmpty);
}

// ════ E：实时状态后台轮询（会议开始/结束秒级反映 + 文件窗口抓取·不打断当前活动）════
let meetingPollTimer = 0;
let lastMeetingSig = '';
const lastMaterialSync = new Map<string, number>(); // 每会议群文件抓取节流（≥5min/场）
// inCaptureWindow 用 feishu-materials.ts 的共享实现（B7-bug3）：未结束会议不再用 Date.now() 当窗口上界无限延长，
// 而是以 started_at/scheduled_at + 4h 硬上限兜底；poll 门槛和 detail 入口自动扫描必须用同一份判断，不能各写一套。
/** M7·nav 徽标：任意面都看得到——会议 rail 图标点个黑点 = 有场会议刚开始、你还没点开看过。
 *  rail 收起态时 #rl-meet-badge 随 #m-rail 一起被移出可视区，同步一份到 #m-tab 上的 #rl-meet-tab-badge。 */
async function refreshMeetNavBadge(): Promise<void> {
  const on = (await listAllMeetings()).some((m) => m.live_unread);
  const badge = document.getElementById('rl-meet-badge');
  if (badge) badge.hidden = !on;
  const tabBadge = document.getElementById('rl-meet-tab-badge');
  if (tabBadge) tabBadge.hidden = !on;
}

/** 一拍：同步 panel/日历（实时归类）→ 窗口内已归真群的会议抓群文件（节流）→ 数据变了才重渲首页（守翻页·不打断 ws/detail/live）。
 *  不在「会议」面时也要轻量收 panel started/ended 事件才能点亮 nav 徽标（M7·「第一时间通知」不能只在会议面里生效），
 *  但只做这一件事——不拉日历/不抓群文件/不重渲 home（不抢资源·不打断阅读/dev 当前活动）。 */
async function meetingPollTick(): Promise<void> {
  if (document.hidden) return;
  if (document.body.dataset.mode !== 'meet') { await syncPanelMeetingsObserved().catch(() => {}); void refreshMeetNavBadge(); return; }
  // 会中(记录工作台)也要消费 panel started/ended 事件(M1·status 飞书驱动)，但只轻量同步、不抓群文件/不重渲 home（保 P0 不抢资源/不打断画板）。
  if (document.body.dataset.mtg === 'live') { await syncPanelMeetingsObserved().catch(() => {}); void refreshMeetNavBadge(); return; }
  try { await syncHomeData(); } catch { return; }
  for (const m of await listAllMeetings()) { // 文件捕获窗口：窗口内 + 已归真飞书群（会前1h只对已知群生效）
    const ws = m.workspace_id ? await getWorkspace(m.workspace_id) : null;
    if (!(ws?.source === 'feishu' && ws.feishu_chat_id && inCaptureWindow(m))) continue;
    if (Date.now() - (lastMaterialSync.get(m.meeting_id) || 0) < 5 * 60_000) continue;
    lastMaterialSync.set(m.meeting_id, Date.now());
    void syncMeetingGroupMaterials({ meetingId: m.meeting_id, chatId: ws.feishu_chat_id, feishuBase: FEISHU_PROXY, feishuAbsoluteBase: FEISHU_ABSOLUTE, convertBase: CONVERT_PROXY });
  }
  void refreshMeetNavBadge();
  // 复用 renderHome 的 homeSig 定义（别各写一套「什么算变化」）：workspace 名称/来源 + 会议状态/标题/时间/未读全覆盖。
  const local = await readHomeLocal();
  if (local.sig === lastMeetingSig) return;    // 无变化不重渲（电纸屏免无谓刷新）
  lastMeetingSig = local.sig;
  if (document.body.dataset.mtg === 'home') renderHomeFromData(local.workspaces, local.allMeetings, { keepPage: true });
  else if (document.body.dataset.mtg === 'detail' && mv.mtgId) {
    const fresh = await getMeeting(mv.mtgId);
    if (fresh?.status === 'ended') void openRecap(fresh.meeting_id);
    else void renderDetail();
  }
}
function startMeetingPoll(): void {
  if (meetingPollTimer) return;
  void refreshMeetNavBadge(); // 冷启动先读一次本地状态（上次会话遗留的未读徽标别等 12s 才出现）
  meetingPollTimer = window.setInterval(() => void meetingPollTick(), 12000);            // 前台可见每 12s
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void meetingPollTick(); }); // 回前台立即追一拍
}

function mrow(m: PersistedMeeting, wsLabel?: string): string {
  return `<button class="mrow" data-mtgid="${esc(m.meeting_id)}" data-wsid="${esc(m.workspace_id)}">${stBadge(m.status)}`
    + `<span class="mc"><span class="mt">${esc(decodeMeetingTitle(m.title))}</span><span class="mm">${esc(fmtDateTime(m.scheduled_at))}${wsLabel ? ` · ${esc(wsLabel)}` : ''}</span></span>`
    + `<span class="go">${SVG_GO}</span></button>`;
}
/** 会议行点击 → 按会议状态直达对应态（meeting-flow 单状态机·会后整合）。 */
function wireRows(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.mrow[data-mtgid]').forEach((b) => b.addEventListener('click', () => {
    void openMeeting(b.dataset.wsid, b.dataset.mtgid!);
  }));
}
/** meeting-flow 路由：点会议按 status 直达——会前/会中=资料+进入 detail / 会后=时间轴对齐 recap。
 *  会中不再直接进白板：无资料/无笔迹时白板本身是空白画布，会被误认为白屏。 */
async function openMeeting(wsId: string | undefined, mtgId: string): Promise<void> {
  let m = await getMeeting(mtgId);
  if (!m) { setMtg('home'); void renderHome(); return; }
  if (m.live_unread) { await updateMeeting(mtgId, { live_unread: false }).catch(() => {}); void refreshMeetNavBadge(); } // 点开＝已看到「开始了」提醒（M7）
  const nowMs = meetingNowMs();
  const effectiveStatus = effectiveMeetingStatus(m, nowMs);
  if (effectiveStatus === 'ended' && m.status !== 'ended') {
    const endedAt = effectiveMeetingEndIso(m, nowMs) || new Date(nowMs).toISOString();
    await updateMeeting(mtgId, { status: 'ended', ended_at: endedAt }).catch(() => {});
    m = { ...m, status: 'ended', ended_at: endedAt };
    void refreshMeetNavBadge();
  } else if (effectiveStatus === 'live' && m.status !== 'live') {
    const startedAt = m.started_at || m.scheduled_at || new Date(nowMs).toISOString();
    await updateMeeting(mtgId, { status: 'live', started_at: startedAt, vc_meeting_start_t0: Date.parse(startedAt), t0_source: m.t0_source || 'calendar', align_state: m.align_state || 'estimated' }).catch(() => {});
    m = { ...m, status: 'live', started_at: startedAt, vc_meeting_start_t0: Date.parse(startedAt), t0_source: m.t0_source || 'calendar', align_state: m.align_state || 'estimated' };
    void refreshMeetNavBadge();
  }
  mv = { wsId: wsId ?? m.workspace_id, mtgId };
  if (effectiveStatus === 'ended') void openRecap(mtgId);       // 会后：直进时间轴对齐
  else { setMtg('detail'); void renderDetail(); }        // 会前/会中：资料 + 进入会议
}

// ════ detail：四区块 + 动作 ════
async function renderDetail(): Promise<void> {
  const m = mv.mtgId ? await getMeeting(mv.mtgId) : null;
  if (!m) { setMtg('home'); void renderHome(); return; }
  const books = await listBooks();
  const bookMap = new Map(books.map((b) => [b.document_id, b]));
  const mats = m.material_doc_ids.map((id) => bookMap.get(id)).filter((b): b is PersistedDoc => !!b);
  // 资料上的「本场会议手写档案」按 context_id 过滤（与 recap/AI 一致·别混入同一资料在别场会议/阅读态的笔）
  const mtgCtx = 'mtg_' + m.meeting_id;
  const markLists = await Promise.all(mats.map((b) => getFoldedMarks(b.document_id).then((ms) => ms.filter((mk) => mk.context_id === mtgCtx))));
  const ws = await getWorkspace(m.workspace_id);
  // 进会议详情自动抓群文件 → 转 PDF → 入资料书架（幂等去重·后台不阻塞渲染·有新增则重渲）。
  // B7-bug4：detail 入口之前没按捕获窗口 gate（poll 路径有），窗口外进详情也会扫——和「会前1h~会后1h」规则不一致，统一用同一份 inCaptureWindow。
  if (ws?.source === 'feishu' && ws.feishu_chat_id && inCaptureWindow(m)) {
    void syncMeetingGroupMaterials({ meetingId: m.meeting_id, chatId: ws.feishu_chat_id, feishuBase: FEISHU_PROXY, feishuAbsoluteBase: FEISHU_ABSOLUTE, convertBase: CONVERT_PROXY })
      .then((r) => { if (r.changed && mv.mtgId === m.meeting_id) void renderDetail(); });
  }
  // 会议手记（白板物化的 diary doc）：列进手写档案区·点击=进会议回到手记
  const noteId = noteIdOf(m.meeting_id);
  const [noteDoc, noteMarks] = await Promise.all([getDoc(noteId), getFoldedMarks(noteId)]);
  const noteArchiveHtml = (noteDoc || noteMarks.length)
    ? `<div class="matcard" data-note="1"><span class="ic">${SVG_PEN}</span><div><div class="nm">${esc(noteDoc?.filename || decodeMeetingTitle(m.title) + ' 手记')}</div><div class="mt">${noteDoc?.page_count || 1} 页 · ${noteMarks.length} 笔 · 会议手记</div></div></div>`
    : '';

  // 「群里收集到的资料」区块已下沉到会中资料抽屉（mountSide·B 方案 detail 瘦身·阶段②）：
  // detail 不再重复浏览群文件，只显示已入库的会议资料（mats·含上面 408 后台抓取转 PDF 的群文件）。
  const links = m.material_links || [];
  const linksHtml = links.map((l) => `<div class="matcard" data-linkid="${esc(l.link_id)}"><span class="ic">${SVG_LINK}</span><div><div class="nm">${esc(l.title || l.url)}</div><div class="mt">${esc(materialLinkStatusText(l))}</div></div></div>`).join('');
  const filesHtml = (mats.length || links.length)
    ? mats.map((b) => `<div class="matcard" data-docid="${esc(b.document_id)}" data-name="${esc(b.filename)}"><span class="ic">${SVG_FILE}</span><div><div class="nm">${esc(b.filename || '(未命名)')}</div><div class="mt">${b.page_count} 页 · 借阅读器打开</div></div></div>`).join('') + linksHtml
    : `<p class="empty">还没有资料。点右上「+ 添加资料」从已导入的 PDF 里挑。</p>`;
  const matsArchiveHtml = mats.length
    ? mats.map((b, i) => {
        const hand = markLists[i].filter((mk) => mk.feature_type === 'handwriting').length;
        return `<div class="matcard" data-docid="${esc(b.document_id)}" data-name="${esc(b.filename)}"><span class="ic">${SVG_PEN}</span><div><div class="nm">${esc(b.filename || '(未命名)')}</div><div class="mt">${markLists[i].length} 处标注 · 手写 ${hand}</div></div></div>`;
      }).join('')
    : '';
  const archiveHtml = (noteArchiveHtml + matsArchiveHtml)
    || `<div class="empty">${m.status === 'ended' ? '本场会议没有留下手写档案。' : '会议进行 / 结束后，你在手记与资料上的手写会汇总在这里。'}</div>`;
  // 思路总结已迁 recap（M2b·会后态显示+生成）。detail 准备区不再有思路总结块。
  // 「进入会议」即开始（enterMeeting 内置置 live + 落 started_at），故不再单列「开始会议」按钮，去职责重叠。
  const enterLabel = m.status === 'live' ? '✏ 进入会议（继续）' : '✏ 进入画板 · 开始记录'; // 会前可进画板写(M1·进画板≠开始)·ended 不进 detail(走 recap)
  // C11：撤掉「结束会议」手动入口——正常流程下"结束"只该由云端/panel 真实事件驱动，设备不该有本地强制结束的能力。
  // 用户在会中只能"退出"（exitToDetail，纯离开画板不碰 status）；测试用的手动结束挪进 dev 设置页（见 dev.ts #dv-force-end）。
  const ownership = meetingOwnershipHtml(m, ws);
  // 准备区会议信息卡（M2·对齐后）：时间 + 会议号 + 状态 + 归属群（选择/移除·M4 可逆）。不显会议链接(电纸屏非开会终端·会议号够标识)。
  const whenStr = fmtDateTime(m.scheduled_at);
  const noStr = m.feishu_meeting_no || m.calendar_meeting_no || '';
  const stText = m.status === 'live' ? '进行中' : m.status === 'ended' ? '已结束' : '待开始';
  const infoCard =
    `<section class="msec"><div class="mcard">`
    + `<div class="ir"><span class="il">时间</span><span class="iv">${esc(whenStr)}</span></div>`
    + (noStr ? `<div class="ir"><span class="il">会议号</span><span class="iv">${esc(noStr)}</span></div>` : '')
    + `<div class="ir"><span class="il">状态</span><span class="iv">${stText}</span></div>`
    + `<div class="ir"><span class="il">归属群</span><span class="iv">${ownership.html}</span></div>`
    + `</div></section>`;

  el('mv-detail').innerHTML =
    `<div class="mtop"><button class="book-back meeting-back" type="button" data-back="home" aria-label="返回会议列表">${SVG_BACK}<span>会议</span></button><span class="ti">${esc(decodeMeetingTitle(m.title))}</span>${stBadge(m.status).replace('class="st', 'style="margin-left:8px" class="st')}</div>` // ws 页已删→detail 恒回 home（阶段②）
    + `<div class="mbody">`
    + `<div class="dact"><button class="hbtn pri" id="md-enter">${enterLabel}</button></div>` // 主动作=进画板(会前可写)；结束不再有手动入口(C11)
    + infoCard
    + `<section class="msec"><div class="msec-h"><span class="mt">会议资料</span><span class="mb">${mats.length + links.length} 份</span><span class="sp" style="flex:1"></span><button class="hbtn sm" id="md-add">+ 添加资料</button></div>${filesHtml}</section>`
    + `<section class="msec"><div class="msec-h"><span class="mt">你的手写档案</span></div>${archiveHtml}</section>`
    + `</div>`;

  // ended 不再进 detail(走 recap)→ recap card 死分支已删(清死分支·M2)。
  el('mv-detail').querySelector('#md-enter')?.addEventListener('click', () => { void enterMeeting(m.meeting_id); });
  // 思路总结生成已迁 recap（M2b·detail 不再有 md-sum）。
  el('mv-detail').querySelector('#md-add')?.addEventListener('click', async () => {
    // M3 资料双来源：先选来源（飞书群文件 / 本地文档·让用户知道两个来源都能拉）。
    const hasFeishuSource = ownership.hasFeishuGroup;
    const source = await pickOneSheet({
      title: '添加资料',
      items: [
        { id: 'feishu', label: hasFeishuSource ? `群资料 · ${ws?.name || '飞书群'}` : '群资料（先选择归属群）', sub: hasFeishuSource ? '从当前归属群选择文件' : '先在会议信息卡选择归属群' },
        { id: 'local', label: '本地文档', sub: '从已导入 PDF 选择' },
      ],
      defaultId: hasFeishuSource ? 'feishu' : 'local',
      confirm: '下一步',
    });
    if (!source) return;
    if (source === 'feishu') {
      if (!ws?.feishu_chat_id) { await infoSheet({ title: '先选择归属群', message: '群资料来自会议归属群。请先在会议信息卡选择具体群，再从群文件添加资料。' }); return; }
      let files: FeishuFileItem[] = [];
      try { files = (await listMeetingGroupMaterialFiles({ chatId: ws.feishu_chat_id, feishuBase: FEISHU_PROXY, limit: 50 })).files; }
      catch (e) { await infoSheet({ title: '拉取群文件失败', message: String((e as Error)?.message || e) }); return; }
      // 妙记 docx 链接候选（群文本消息里分享的文档链接，非 /minutes/<token> 卡片）——best-effort，这一路失败不挡文件候选。
      let docxLinks: Awaited<ReturnType<typeof listMeetingGroupDocxLinks>> = [];
      try { docxLinks = await listMeetingGroupDocxLinks({ chatId: ws.feishu_chat_id, feishuBase: FEISHU_PROXY, limit: 50 }); } catch { /* 静默：不影响文件候选 */ }
      // B7-bug6：docId 按 resource_key（文件本体标识）去重，不再用 message_id——避免同一文件转发/机器人重贴一次被判成新文件。
      const fileCands = files
        .map((f) => ({ f, docId: materialDocId(m.meeting_id, f.resource_key), src: pdfSourceUrl(f, FEISHU_PROXY, FEISHU_ABSOLUTE, CONVERT_PROXY) }))
        .filter((x) => !!x.src && !m.material_doc_ids.includes(x.docId));
      const existingLinkTokens = new Set((m.material_links || []).map((l) => l.token));
      const linkCands = docxLinks
        .map((d) => ({ d, linkId: materialLinkId(m.meeting_id, d.token) }))
        .filter((x) => !existingLinkTokens.has(x.d.token));
      const add = await pickSheet({
        title: '添加飞书群文件',
        items: [
          ...fileCands.map((c) => ({ id: c.docId, label: c.f.file_name || '群文件', sub: [/\.pdf$/i.test(c.f.file_name || '') ? 'PDF' : '将转成 PDF', fmtMs(c.f.create_time)].filter(Boolean).join(' · ') })),
          ...linkCands.map((c) => ({ id: c.linkId, label: '飞书文档链接', sub: [fmtMs(c.d.create_time), c.d.url].filter(Boolean).join(' · ') })),
        ],
        empty: '这个群最近没有可添加的 PDF / HTML / 图片文件或妙记文档链接，或都已在本场资料里。',
        confirm: '添加',
      });
      if (!add?.length) return;
      const byDocId = new Map(fileCands.map((c) => [c.docId, c] as const));
      const byLinkId = new Map(linkCands.map((c) => [c.linkId, c] as const));
      const newIds: string[] = [];
      const newLinks: PersistedMeetingMaterialLink[] = [];
      let failed = 0;
      const now = new Date().toISOString();
      for (const id of add) {
        const fc = byDocId.get(id);
        if (fc?.src) {
          // B7-bug2 联动：storePdfBlob 落库失败会上抛，这里接住计入 failed，不把半成品 docId 并入资料列表。
          try { await importPdfFromUrl(fc.docId, fc.f.file_name || '群文件', fc.src); newIds.push(fc.docId); }
          catch { failed++; } // 单文件转换/下载失败不阻断其它
          continue;
        }
        const lc = byLinkId.get(id);
        if (lc) {
          newLinks.push({
            link_id: lc.linkId, kind: 'feishu_docx', url: lc.d.url, token: lc.d.token,
            source_chat_id: ws.feishu_chat_id, source_message_id: lc.d.message_id, source_create_time: lc.d.create_time,
            attached_at: now, status: 'link_only',
          });
        }
      }
      // B7-bug1：原子并入而非用本次渲染时的旧快照整体覆盖 material_doc_ids（防撞上后台自动扫描并发丢更新）。
      if (newIds.length) await addMeetingMaterialDocIds(m.meeting_id, newIds);
      if (newLinks.length) await addMeetingMaterialLinks(m.meeting_id, newLinks);
      if (failed) await infoSheet({ title: '部分资料导入失败', message: `${failed} 个群文件转换或下载失败，其他已添加。` });
      void renderDetail();
      return;
    }
    const avail = books.filter((b) => !m.material_doc_ids.includes(b.document_id));
    const add = await pickSheet({
      title: '添加本地文档',
      items: avail.map((b) => ({ id: b.document_id, label: b.filename || '(未命名)', sub: `${b.page_count} 页` })),
      empty: '没有可添加的资料。先到「阅读 · 书籍」导入 PDF。',
      confirm: '添加',
    });
    if (add && add.length) { await addMeetingMaterialDocIds(m.meeting_id, add); void renderDetail(); }
  });
  el('mv-detail').querySelector('#md-claim')?.addEventListener('click', async () => {
    const realWs = (await listWorkspaces()).filter((w) => w.source === 'feishu');
    const pick = await pickOneSheet({
      title: '选择归属群',
      items: realWs.map((w) => ({ id: w.workspace_id, label: w.name, sub: w.workspace_id === m.workspace_id ? '当前' : '' })),
      empty: '还没有飞书群。机器人所在的群会自动同步进来。',
      confirm: '确认归属',
    });
    if (!pick) return;
    // 记住认领（会议号 + 标题）→ 之后同号/同名周期会自动归；并把这场迁过去。
    rememberClaim({ meetingNo: m.calendar_meeting_no || m.feishu_meeting_no, topic: m.feishu_topic || m.title }, pick);
    await updateMeeting(m.meeting_id, { workspace_id: pick, group_claimed_at: new Date().toISOString() });
    void renderDetail();
  });
  el('mv-detail').querySelector('#md-unclaim')?.addEventListener('click', async () => {
    // M4 归群可逆：撤销认领 + 会议移回占位群（日历来源→日程占位 ws_schedule·否则无群桶）。只迁 workspace_id/group_claimed_at·不碰 material_doc_ids/marks/context_id（笔和资料不丢）。
    forgetClaim({ meetingNo: m.calendar_meeting_no || m.feishu_meeting_no, topic: m.feishu_topic || m.title });
    const fallback = (m.source_kind === 'calendar' || m.feishu_calendar_event_id) ? await upsertScheduleWorkspace() : await upsertPanelWorkspace('飞书会议');
    await updateMeeting(m.meeting_id, { workspace_id: fallback.workspace_id, group_claimed_at: undefined });
    void renderDetail();
  });
  // 资料卡 → 进这场会议的工作台并开进该资料（不跳全局阅读·批注归本会议时间脊）。本地 PDF / 群 HTML 转 PDF 都由 enterMeeting→openMaterialInMeeting 处理。
  el('mv-detail').querySelectorAll<HTMLElement>('.matcard[data-docid]').forEach((card) => card.addEventListener('click', () => {
    void enterMeeting(m.meeting_id, { docId: card.dataset.docid!, name: card.dataset.name || '资料', conv: card.dataset.conv });
  }));
  el('mv-detail').querySelector<HTMLElement>('.matcard[data-note]')?.addEventListener('click', () => { void enterMeeting(m.meeting_id); }); // 会议手记卡 → 进会议回到手记白板
  // 链接型资料卡（妙记 docx）→ 已导出直接打开；否则弹「打开链接/导出PDF」。
  el('mv-detail').querySelectorAll<HTMLElement>('.matcard[data-linkid]').forEach((card) => card.addEventListener('click', () => {
    const link = (m.material_links || []).find((l) => l.link_id === card.dataset.linkid);
    if (link) void handleMaterialLinkClick(m.meeting_id, link, () => void renderDetail(), (docId, name) => void enterMeeting(m.meeting_id, { docId, name }));
  }));
  wireBack(el('mv-detail'));
  pageMbody(el('mv-detail'), 'detail');
}

/** WS2-C：进「会后记录」阅读视图（时间脊为主体·左侧 #recap-nav 切到思路总结/panel总结整页）。返回=回 detail。 */
async function openRecap(mtgId: string): Promise<void> {
  setMtg('recap');
  // 顶栏返回：详情段视图先退回概览（recapHandleBack 处理）；已在概览/思路总结/panel总结才退出 recap 回 home。
  el('recap-back').onclick = () => { if (recapHandleBack()) return; resetRecapView(); setMtg('home'); void renderHome(); }; // 会后整合：recap 是 ended 主体·返回回 home 列表（不再回 detail）
  await loadRecapView(mtgId, el('recap-body'), el('recap-title'));
}

const MATERIAL_OPEN_TIMEOUT_MS = 60_000; // 会中打开资料总超时：转换服务/下载/pdfjs 解码任一 hang 都不让 UI 永久卡死（P0）
/** 给任意 promise 加超时：到点 reject，不真正中断底层（底层各自有 AbortController/cancel/loadGeneration 守卫兜底）。 */
function timeoutAfter<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = window.setTimeout(() => { if (!done) { done = true; reject(new Error(`${label}超时`)); } }, ms);
    p.then(
      (v) => { if (!done) { done = true; window.clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; window.clearTimeout(timer); reject(e); } },
    );
  });
}
function materialOpenError(e: unknown): string {
  const msg = String((e as Error)?.message || e || '未知错误');
  return /超时|timeout|AbortError/i.test(msg)
    ? '资料打开超时：可能是文件下载、转换服务或 PDF 解码没有响应。已回到会议手记，请稍后重试。'
    : msg;
}

/**
 * 链接型资料（妙记 docx）点击行为：已导出过 PDF → 直接当普通资料打开；否则弹「打开链接 / 导出 PDF」二选一。
 * 导出走用户手动触发（不自动），失败归类 permission_denied（用户没权限读这篇文档，常态）vs 其它失败，
 * 都落回 material_links 供下次渲染显示正确状态，不吞掉失败原因。
 * `openDoc`：调用方决定"打开一份资料"具体怎么做——detail 页(未进会议)用 enterMeeting 带 material 参数首次进场；
 * mountSide(已在会中)用 openMaterialInMeeting 原地切资料，别再走 enterMeeting 的整套重新初始化。
 */
async function handleMaterialLinkClick(meetingId: string, link: PersistedMeetingMaterialLink, rerender: () => void, openDoc: (docId: string, name: string) => void): Promise<void> {
  if (link.pdf_doc_id) { openDoc(link.pdf_doc_id, link.title || '飞书文档'); return; }
  const action = await pickOneSheet({
    title: link.title || '飞书文档',
    items: [
      { id: 'open', label: '打开链接', sub: '在浏览器里查看原文档' },
      { id: 'export', label: '导出 PDF 可批注', sub: link.status === 'permission_denied' ? '之前无权限读取，可再试一次' : '拉取内容转成可标注 PDF（可能要几秒到几十秒）' },
    ],
    confirm: '好',
  });
  if (action === 'open') { window.open(link.url, '_blank', 'noopener'); return; }
  if (action !== 'export') return;
  const pdfDocId = materialDocxPdfDocId(meetingId, link.token);
  try {
    const src = apiUrl(`${FEISHU_PROXY}/api/feishu/docx/${encodeURIComponent(link.token)}/pdf`);
    await importPdfFromUrl(pdfDocId, link.title || '飞书文档', src);
    await addMeetingMaterialDocIds(meetingId, [pdfDocId]);
    await addMeetingMaterialLinks(meetingId, [{ ...link, status: 'pdf_ready', pdf_doc_id: pdfDocId, error: undefined }]);
    openDoc(pdfDocId, link.title || '飞书文档');
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    const isPerm = /403|permission|forbidden|权限/i.test(msg);
    await addMeetingMaterialLinks(meetingId, [{ ...link, status: isPerm ? 'permission_denied' : 'failed', error: msg.slice(0, 200) }]);
    await infoSheet({ title: '导出失败', message: isPerm ? '没有权限读取这篇文档内容，可以打开原链接查看。' : `导出 PDF 失败：${msg}` });
    rerender();
  }
}

/** 会中打开资料：**不退出会议**。把 PDF 载进会中共享画布（loadIntoState 载入当前活跃 meetingCtx），
 *  时钟/时间脊照常，资料上的笔带同一 context_id='mtg_<id>' → 汇入时间脊。返回白板=点抽屉「空白笔记页」。
 *  P0：加总超时 + 失败/超时自动回退到会议手记（取消在途渲染、收资料态、弹提示），任何资料都不会让会中永久卡死。 */
async function openMaterialInMeeting(docId: string, name: string, convUrl?: string): Promise<void> {
  const mtg = liveMtg, ctx = meetingCtx; // capture：转 PDF/解码慢时用户退会再进别场，迟到结果不能写当前 live UI
  if (!mtg || !ctx) return;
  flushRegion('manual'); // 切资料前收口手记/上一面在途区域（否则刚写的笔在 6s 收口前被切走丢账）
  document.body.classList.remove('side-open'); // 收起资料抽屉
  document.body.classList.remove('mtg-note-open'); // 资料态隐手记 bar（翻页/标题是手记的，不是资料的）
  document.body.classList.remove('mtg-note-empty');
  el('mlive-title').textContent = `正在打开：${name}`; // 即时反馈：电纸屏无 loading 动画，先让用户知道在加载
  try {
    if (convUrl) {
      await timeoutAfter(openPdfFromUrl(docId, name, convUrl), MATERIAL_OPEN_TIMEOUT_MS, '打开会议资料');
    } else {
      const ok = await timeoutAfter(reopenBook(docId, name), MATERIAL_OPEN_TIMEOUT_MS, '打开本地资料');
      if (!ok) throw new Error('本地资料缓存不存在，请回详情重新添加或重新导入。'); // reopenBook 返回 false=没字节，原来会静默假成功（停在空白资料态）
    }
  } catch (e) {
    if (liveMtg === mtg && getActiveContext() === ctx) { // 仍在本场会议才动 UI（迟到失败不打扰已切走的用户）
      ctx.loadGeneration++; ctx.renderGeneration++; cancelActiveRender(); // 抢占/取消在途资料载入与渲染，防慢资料迟到覆盖恢复后的手记
      document.body.classList.remove('side-open');
      document.body.classList.remove('mtg-note-open');
      el('mlive-title').textContent = mtg.title;
      void infoSheet({ title: '打开失败', message: materialOpenError(e) });
      void openMeetingNote(mtg.id); // 回退到会议手记，保证会议仍可用（不是卡在半坏的资料态）
    }
    return;
  }
  if (liveMtg !== mtg || getActiveContext() !== ctx) return; // 已退会/切会：不改标题、不刷脊
  el('mlive-title').textContent = name; // 顶栏显当前资料名
  void refreshSpine();
}

// ════ 会中基岩录制 lease：进 live 自动开、退出还原；只改内存不落盘（不污染日常）；尊重用户手动设定 ════
function startMeetingBedrock(): void {
  if (bedrockLeased) return;                                          // 已持租约（如从后台切回）→ 不重复
  bedrockLeased = true;
  bedrockAutoEnabled = !settings.bedrock && !bedrockUserOverride;     // 用户已手动接管则不替它开
  if (bedrockAutoEnabled) settings.bedrock = true;                    // bedrockTap 实时读此值，无需 emit/init；不 saveSettings 故重启即复默认关
}
function stopMeetingBedrock(): void {
  if (bedrockLeased && bedrockAutoEnabled && !bedrockUserOverride && settings.bedrock) settings.bedrock = false; // 只关「我们替它开的、且用户没手动接管的」；override 用模块级标志（跨 visibility 收租仍记得）
  bedrockLeased = false;
  bedrockAutoEnabled = false;
  void flushBedrock();                                               // 落库 500ms 定时缓冲（raw_ref 已写进 mark，chunk 别迟到）
}

// ════ 会议手记：把会中白板物化成一个 diary 式文档（命名/多页/重开），仍归属本会议（context 不变·零迁移）════
async function ensureMeetingNoteDoc(m: PersistedMeeting): Promise<PersistedDoc> {
  return createDiaryDoc(noteIdOf(m.meeting_id), `${decodeMeetingTitle(m.title)} 手记`, 1); // 幂等：首次建、之后取既有
}
function updateNotePageInd(): void {
  const total = Math.max(liveNoteDoc?.page_count || 1, state.pageCount || 1, state.pageIndex + 1); // 空白新页显 N/N（未写不缩），同日记
  el('mtg-note-ind').textContent = `${state.pageIndex + 1}/${total}`;
  const next = el<HTMLButtonElement>('mtg-note-next');
  const addPage = state.pageIndex >= total - 1;
  next.classList.toggle('add-page', addPage);
  next.setAttribute('aria-label', addPage ? '新增一页' : '下一页');
}

function setLiveMarkCount(count: number): void {
  liveMarkCount = count;
  el('mtg-chip-n').textContent = `${count} 笔`;
}

async function refreshMeetingNoteEmptyState(): Promise<void> {
  const doc = liveNoteDoc;
  if (!liveMtg || !doc || state.surfaceType !== 'whiteboard' || state.documentId !== doc.document_id) {
    document.body.classList.remove('mtg-note-empty');
    return;
  }
  const marks = await getFoldedMarks(doc.document_id);
  if (!liveMtg || liveNoteDoc !== doc || state.surfaceType !== 'whiteboard' || state.documentId !== doc.document_id) return;
  document.body.classList.toggle('mtg-note-empty', marks.length === 0);
}

async function refreshLiveMarkCounters(): Promise<void> {
  const mtg = liveMtg;
  if (!mtg) return;
  const marks = await getFoldedMarksByContext('mtg_' + mtg.id);
  if (liveMtg !== mtg) return;
  setLiveMarkCount(marks.length);
  void refreshMeetingNoteEmptyState();
}

/** 打开/回到本会议手记白板：物化 doc → 挂 active doc(令 mark:resolved 的 materialize 生效) → 还原页数/末读页/笔迹。 */
async function openMeetingNote(mtgId: string): Promise<void> {
  const m = await getMeeting(mtgId);
  if (!m || !meetingCtx || !liveMtg || liveMtg.id !== mtgId) return; // await 期间退会/切会 → 丢弃
  const doc = await ensureMeetingNoteDoc(m);
  if (!meetingCtx || !liveMtg || liveMtg.id !== mtgId) return;
  flushRegion('manual');                            // 收口上一面在途区域（quiet-6s 前切走否则该笔丢账）
  meetingCtx.loadGeneration++;                      // latest-wins：抢占在途资料载入（renderer fresh() 判此值），慢资料迟到不再覆盖手记
  liveNoteDoc = doc;
  document.body.classList.add('mtg-note-open');     // 露手记标题/翻页 bar
  document.body.classList.remove('side-open');
  el('mtg-note-title').textContent = doc.filename || `${decodeMeetingTitle(m.title)} 手记`;
  el('mlive-title').textContent = decodeMeetingTitle(m.title);          // 顶栏回会议名（资料态被覆成资料名，回手记复位）
  const host = el('mtg-stage-host');
  const noteSize = fitMeetingNotePage(host.clientWidth, host.clientHeight);
  renderBlankSurface(doc.document_id, doc.filename || decodeMeetingTitle(m.title), { ...RULED, width: noteSize.width, height: noteSize.height });
  state.pageCount = doc.page_count || 1;            // renderBlankSurface 写死 1 → 复原真页数
  meetingCtx.storeDoc = doc; setActiveDoc(doc);     // current=手记 doc：materialize/末读页/改名都落到它
  const page = Math.min(doc.last_read_page ?? 0, Math.max(0, state.pageCount - 1));
  if (page > 0) renderBlankPage(page, RULED);
  redrawInk();
  updateNotePageInd();
  void refreshMeetingNoteEmptyState();
  void refreshSpine();
}
function gotoMeetingNotePage(delta: number): void {
  if (!liveNoteDoc || state.surfaceType !== 'whiteboard') return;
  const idx = state.pageIndex + delta;
  if (idx < 0) return;                              // 同日记：可无限向前翻空白新页，写了才落盘
  flushRegion('manual');                            // 翻页前收口本页在途区域（page:rendered 会 resetAssembly，否则未落账的笔丢）
  state.pageCount = Math.max(state.pageCount || 1, idx + 1);
  renderBlankPage(idx, RULED);
  redrawInk();
  setLastReadPage(idx);
  updateNotePageInd();
}

function resizeMeetingNoteSurface(): void {
  if (!liveMtg || !liveNoteDoc || state.surfaceType !== 'whiteboard' || state.documentId !== liveNoteDoc.document_id) return;
  const host = el('mtg-stage-host');
  const { width, height } = fitMeetingNotePage(host.clientWidth, host.clientHeight);
  if (width <= 0 || height <= 0) return;
  if (resizeBlankSurface(width, height, RULED)) {
    redrawInk();
    updateNotePageInd();
    signalInkArea([0, 0, 1, 1]);
  }
}

// ════ live：会中工作台（白板搬进 #mtg-stage-host + 时间脊 + 资料栏 + 计时）════
async function enterMeeting(mtgId: string, material?: { docId: string; name: string; conv?: string }): Promise<void> {
  const m = await getMeeting(mtgId);
  if (!m) return;
  const ws = await getWorkspace(m.workspace_id);
  const nowMs = meetingNowMs();
  const status = effectiveMeetingStatus(m, nowMs);
  // M1·进画板 ≠ 开始：enterMeeting 只进记录工作台，**不改 status、不落 started_at**（status/t0 严格由飞书事件驱动）。
  // t0 取已有飞书真实开始时间（vc_meeting_start_t0 / started_at）；会前（无 t0）时 startedMs=0 → startClock 显「会前记录」、时间脊显「会前」。
  const vcT0 = typeof m.vc_meeting_start_t0 === 'number' && Number.isFinite(m.vc_meeting_start_t0) ? m.vc_meeting_start_t0 : 0;
  const startedAtMs = m.started_at ? Date.parse(m.started_at) : NaN;
  const scheduledAtMs = m.scheduled_at ? Date.parse(m.scheduled_at) : NaN;
  const startedMs = vcT0 || (Number.isFinite(startedAtMs) ? startedAtMs : 0) || (status === 'live' && Number.isFinite(scheduledAtMs) ? scheduledAtMs : 0);
  const reviewing = status === 'ended';
  const endedAtMs = reviewing && m.ended_at ? Date.parse(m.ended_at) : NaN;
  const endedMs = Number.isFinite(endedAtMs) ? endedAtMs : 0;
  liveMtg = { id: mtgId, title: decodeMeetingTitle(m.title), chatId: ws?.feishu_chat_id, status, startedAt: startedMs, frozenAt: startedMs > 0 ? (endedMs || (reviewing ? startedMs : 0)) : 0 };
  liveMarkCount = 0;
  bedrockUserOverride = false; // 新会议：清上一场的手动接管标记
  if (status === 'live') startMeetingBedrock(); // 只有飞书已判 live 才录基岩；会前工作台 / 已结束回看不录。
  document.body.dataset.mode = 'meet'; // API/脚本直进会议时也必须切到会议壳，避免读书顶栏混入会议白板。
  document.body.classList.remove('rail-off');
  setMtg('live');
  el('mlive-title').textContent = decodeMeetingTitle(m.title); // 默认会议标题；直接开资料时 openMaterialInMeeting 覆成资料名
  // 白板搬进 live 视图（renderer 持元素引用，搬动后照常工作）
  el('mtg-stage-host').appendChild(el('stage-wrap'));
  // 会中关实时 AI：暂停手势综合（marks 仍捕获、落本会议白板账本）
  prevGesture = settings.gesture.enabled; settings.gesture.enabled = false; bus.emit('settings:changed');
  meetingCtx = new SurfaceContext('mtg_' + mtgId, 'meeting');
  setActiveContext(meetingCtx);
  startClock(); // 立即起表（不等资料解码）
  if (material) {
    // 从详情页直接点资料进会议：开进该资料（免先闪一下白板）。资料载进 meetingCtx → 批注汇本会议时间脊。
    await openMaterialInMeeting(material.docId, material.name, material.conv);
  } else {
    await openMeetingNote(mtgId); // 会议手记（白板物化成 diary doc）→ document:loaded 还原墨迹 + 刷脊
  }
  // renderer/document:loaded 会按阅读页口径重置 writable；会议 live 完成挂载后必须重新点亮，
  // 否则工具格子和 M103/T10 物理笔输入区域都会被误判为不可写。
  setMtg('live');
  resizeMeetingNoteSurface();
  void mountSide();
}

function teardownLive(): void {
  if (!liveMtg) return;
  liveMtg = null;
  liveNoteDoc = null;
  stopClock();
  stopMeetingBedrock(); // 关基岩（若是我们替它开的）+ flush
  settings.gesture.enabled = prevGesture; bus.emit('settings:changed'); // 恢复手势综合
  // 白板搬回 #rv-new（diary-bar 之后、whisper-layer 之前）
  el('rv-new').insertBefore(el('stage-wrap'), el('whisper-layer'));
  meetingCtx = null;
  if (readerCtx) setActiveContext(readerCtx); // 切回主阅读实例
  document.body.classList.remove('side-open');
  document.body.classList.remove('mtg-note-open');
  document.body.classList.remove('mtg-note-empty');
  el('mtg-spine').hidden = true;
}
function exitToDetail(): void { teardownLive(); setMtg('detail'); void renderDetail(); }

function exitToBookShelf(): void {
  teardownLive();
  document.querySelector<HTMLElement>('.nav [data-mode="read"]')?.click();
}

export function leaveActiveMeetingForReading(): void {
  teardownLive();
  setMtg('home');
}

function startClock(): void {
  stopClock();
  if (!liveMtg) return;
  // M1·状态条按飞书口径：会前（飞书还没 started·无 t0）不跑表，显「会前记录」；已结束显「已结束」。
  // M5 画板状态条：三态明示飞书口径到哪——会前记录中 / 进行中·时长 / 已结束·时长。
  if (liveMtg.status === 'ended') {
    const dur = liveMtg.startedAt > 0 && liveMtg.frozenAt ? ` · ${clk(Math.max(0, liveMtg.frozenAt - liveMtg.startedAt))}` : '';
    el('mtg-clk').innerHTML = `<span class="dot off"></span>已结束${dur}`;
    return;
  }
  if (liveMtg.status === 'upcoming' || liveMtg.startedAt <= 0) {
    el('mtg-clk').innerHTML = '<span class="dot off"></span>会前记录中'; // 飞书还没 started·会前可写
    return;
  }
  // 进行中（飞书 started·有真 t0）：跑表 + 「进行中」明示
  const tick = (): void => { if (liveMtg) el('mtg-clk').innerHTML = `<span class="dot"></span>进行中 · ${clk(meetingNowMs() - liveMtg.startedAt)}`; };
  tick();
  clockTimer = window.setInterval(tick, 1000);
}
function stopClock(): void { if (clockTimer) { window.clearInterval(clockTimer); clockTimer = 0; } }

let sidePager: Pager | null = null;
let sideBar: PagerBar | null = null;
async function mountSide(): Promise<void> {
  const mtg = liveMtg; // capture：await 期间退会/切会则丢弃，不写错会议侧栏
  if (!mtg) return;
  const list = el('mtg-side-list');
  const pager = sidePager ?? (sidePager = createPager(list, { onChange: (i) => sideBar?.update(i) }));
  if (!sideBar) sideBar = mountPagerBar(pager, el('mtg-side'));
  // ① 会议本地资料（material_doc_ids，添加资料挑的本地 PDF）——之前抽屉漏列，这里补上
  const [m, books] = await Promise.all([getMeeting(mtg.id), listBooks()]);
  if (liveMtg !== mtg) return;
  const bookMap = new Map(books.map((b) => [b.document_id, b]));
  const locals = (m?.material_doc_ids || []).map((id) => bookMap.get(id)).filter((b): b is PersistedDoc => !!b);
  const localCards = locals.map((b) =>
    `<div class="scard" data-docid="${esc(b.document_id)}" data-name="${esc(b.filename)}"><div class="fn">${SVG_FILE}${esc(b.filename || '(未命名)')}</div><div class="fm">${b.page_count} 页 · 本地 · 可批注</div></div>`
  ).join('');
  // ①b 已挂上的链接型资料（妙记 docx）——和 detail 页同一份 material_links，不是这里下面「群里现拉」的 feishuCards。
  const linkItems = m?.material_links || [];
  const linkCards = linkItems.map((l) =>
    `<div class="scard" data-linkid="${esc(l.link_id)}"><div class="fn">${SVG_LINK}${esc(l.title || l.url)}</div><div class="fm">${esc(materialLinkStatusText(l))}</div></div>`
  ).join('');
  // ② 飞书群文件
  let files: FeishuMsg[] = [];
  if (mtg.chatId) {
    const res = await feishuGet<{ messages: FeishuMsg[] }>(`/api/feishu/workspaces/${mtg.chatId}/messages?limit=50`);
    if (liveMtg !== mtg) return;
    files = (res?.messages || []).filter((x) => (x.msg_type === 'file' && x.file_key) || (x.msg_type === 'image' && x.image_key));
  }
  const feishuCards = files.map((f) => {
    const img = f.msg_type === 'image';
    const name = img ? '［图片］' : (f.file_name || '文件');
    if (isConvertible(f)) {
      return `<div class="scard" data-conv="${esc(convertedPdfUrl(f))}" data-docid="mtgdoc_${esc(mtg.id)}_${esc(feishuMsgResourceKey(f))}" data-name="${esc(name)}"><div class="fn">${SVG_FILE}${esc(name)}</div><div class="fm">群文件 · 可批注</div></div>`;
    }
    return `<a class="scard" href="${esc(feishuFileUrl(f))}" target="_blank" rel="noopener"><div class="fn">${img ? SVG_IMG : SVG_FILE}${esc(name)}</div><div class="fm">群文件</div></a>`;
  }).join('');

  el('mtg-side-tab').textContent = `资料 ${locals.length + linkItems.length + files.length}`;
  const cards = localCards + linkCards + feishuCards;
  pager.content.innerHTML = `<div class="scard blank" id="mside-blank">✏ 会议手记 · 白板</div>${cards || '<p class="empty" style="padding:8px">还没有资料。回详情「+ 添加资料」或在群里发文件。</p>'}`;
  pager.relayout('first');
  // 回手记：reload 本会议手记 doc（document:loaded → 还原墨迹）+ 复位顶栏/页码
  list.querySelector('#mside-blank')?.addEventListener('click', () => {
    if (!liveMtg) return;
    document.body.classList.remove('side-open');
    void openMeetingNote(liveMtg.id);
  });
  // 资料卡：会中打开（保活会议）。本地无 conv 走 reopenBook，群 HTML 带 conv 走 openPdfFromUrl。
  list.querySelectorAll<HTMLElement>('.scard[data-docid]').forEach((c) => c.addEventListener('click', () => {
    void openMaterialInMeeting(c.dataset.docid!, c.dataset.name || '资料', c.dataset.conv);
  }));
  // 链接型资料卡（妙记 docx）→ 已导出直接会中打开；否则弹「打开链接/导出PDF」（导出成功后落回 material_doc_ids，下次按本地资料走）。
  list.querySelectorAll<HTMLElement>('.scard[data-linkid]').forEach((c) => c.addEventListener('click', () => {
    const link = linkItems.find((l) => l.link_id === c.dataset.linkid);
    if (link) void handleMaterialLinkClick(mtg.id, link, () => void mountSide(), (docId, name) => void openMaterialInMeeting(docId, name));
  }));
}

/** 时间脊（会中工作台左缘）：按 context_id 聚合本场会议**所有 surface**（白板 + 各资料）的标注，
 *  按「会议相对时刻」排。资料上的笔靠会中保持 meetingCtx 活跃而带同一 context_id，故一并汇入。chip 点击切显隐。 */
async function refreshSpine(): Promise<void> {
  const mtg = liveMtg; // capture：await 期间可能退会/切会，迟到结果不能用新 liveMtg 解释（跨会污染/空指针）
  if (!mtg) return;
  const marks = (await getFoldedMarksByContext('mtg_' + mtg.id)).sort((a, b) => (a.abs_timestamp || 0) - (b.abs_timestamp || 0));
  if (liveMtg !== mtg) return;
  setLiveMarkCount(marks.length);
  // surface 源标签：白板 + 各资料文件名，让聚合后的脊能区分笔来自哪儿
  const boardId = 'mtgboard_' + mtg.id;
  const nameOf = new Map((await listBooks()).map((b) => [b.document_id, b.filename || '(未命名)']));
  if (liveMtg !== mtg) return;
  const labelFor = (docId: string): string => (docId === boardId ? (liveNoteDoc?.filename || '会议手记') : nameOf.get(docId) || '资料'); // 脊上手记来源标签跟手记名（升格后不再叫"白板"）
  const blocks = marks.map((mk: PersistedMark) => {
    const rel = mtg.startedAt > 0 ? clk(Math.max(0, (mk.abs_timestamp || 0) - mtg.startedAt)) : '会前'; // M1·会前（t0 未定）笔标「会前」；精确会前段对齐留 M6(recap)
    const lines = (mk.marked_text || '').split('\n').filter(Boolean);
    const body = lines.length ? lines.map((l) => `<div class="hw"${/[一-龥]/.test(l) ? ' style="font-size:24px"' : ''}>${esc(l)}</div>`).join('') : '<div class="hw" style="color:var(--mut2);font-size:20px">（图形标注）</div>';
    return `<div class="mblk"><span class="tk"></span><div class="t">${rel}</div><div class="c"><div class="src">${esc(labelFor(mk.document_id))}</div>${body}</div></div>`;
  }).join('');
  el('mtg-spine').innerHTML = `<div class="mpg"><div class="mspine"></div>${blocks || '<p class="empty" style="padding:20px">还没有标注。在白板或资料上写下的内容会按会议时刻出现在这里。</p>'}</div>`;
}

export type SyntheticMeetingEventKind = 'decision' | 'action' | 'risk' | 'question' | 'note';

const SYNTHETIC_MEETING_EVENT_TEXT: Record<SyntheticMeetingEventKind, string> = {
  decision: '决策: MVP 演示闭环固定为 Web 导入、墨水屏标记、Obsidian 投影',
  action: '任务: 补齐 M103 低延迟手写验收数据',
  risk: '风险: T10C Plus 手写延迟还没有形成通用方案',
  question: '问题: Obsidian 回跳链接应该优先打开当前源文件还是最近设备',
  note: '记录: 会议场景只把用户标记的事件送入证据流水线',
};

function meetingEventStrokePoints(index = 0): StrokePoint[] {
  const y = 0.2 + (index % 5) * 0.115;
  const x = 0.18 + Math.floor(index / 5) * 0.12;
  return [
    { x, y, t: 0, pressure: 0.5 },
    { x: x + 0.04, y: y - 0.026, t: 18, pressure: 0.56 },
    { x: x + 0.09, y: y + 0.018, t: 36, pressure: 0.54 },
    { x: x + 0.15, y: y - 0.018, t: 54, pressure: 0.52 },
    { x: x + 0.22, y: y + 0.012, t: 72, pressure: 0.5 },
  ];
}

function bboxForMeetingPoints(points: StrokePoint[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

async function createSyntheticMeetingIfNeeded(title?: string): Promise<PersistedMeeting> {
  const ws = await upsertPanelWorkspace('InkLoop 演示会议');
  const now = new Date();
  const targetTitle = title?.trim();
  const existing = targetTitle
    ? (await listAllMeetings())
      .filter((m) => m.workspace_id === ws.workspace_id && m.title === targetTitle)
      .sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''))[0]
    : null;
  const meeting = existing
    ? (await updateMeeting(existing.meeting_id, {
      title: targetTitle,
      scheduled_at: now.toISOString(),
      status: 'live',
    })) ?? existing
    : await createMeeting(ws.workspace_id, {
      title: targetTitle || `InkLoop Paper Meeting E2E ${now.toISOString()}`,
      scheduled_at: now.toISOString(),
      status: 'live',
    });
  const live = await updateMeeting(meeting.meeting_id, {
    status: 'live',
    started_at: now.toISOString(),
    vc_meeting_start_t0: now.getTime(),
    panel_meeting_start: now.getTime(),
    t0_source: 'vc_event',
    align_state: 'event',
  });
  return live ?? meeting;
}

export async function createSyntheticMeetingEventMark(kind: SyntheticMeetingEventKind, opts: {
  newMeeting?: boolean;
  title?: string;
  text?: string;
  index?: number;
} = {}): Promise<{
  ok: boolean;
  kind: SyntheticMeetingEventKind;
  meeting_id?: string;
  runtime_document_id?: string;
  document_id?: string;
  context_id?: string;
  mark_id?: string;
  axis_count?: number;
  exported_kinds?: string[];
  error?: string;
}> {
  if (opts.newMeeting || !liveMtg || !meetingCtx) {
    const meeting = await createSyntheticMeetingIfNeeded(opts.title);
    await enterMeeting(meeting.meeting_id);
  }
  if (!liveMtg || !meetingCtx || !state.documentId || !state.pageId) {
    return { ok: false, kind, error: 'missing_live_meeting_context' };
  }
  const meetingId = liveMtg.id;
  const points = meetingEventStrokePoints(opts.index ?? liveMarkCount);
  const bbox = bboxForMeetingPoints(points);
  const markId = shortId('evt');
  const text = (opts.text || SYNTHETIC_MEETING_EVENT_TEXT[kind]).trim();
  const stroke: Stroke = { tool: 'pen', points };
  currentStrokes().push(stroke);
  strokeMarkIds.set(stroke, markId);
  redrawInk();
  signalInkArea(bbox);
  await appendMarkEntry({
    document_id: state.documentId,
    page_id: state.pageId,
    page_index: state.pageIndex,
    mark_id: markId,
    strokes: [{ tool: 'pen', points }],
    bbox,
    tool: 'pen',
    color: '#111111',
    pointer_type: 'synthetic',
    device_id: DEVICE_ID,
    abs_timestamp: Date.now(),
    context_id: `mtg_${meetingId}`,
    feature_type: kind === 'note' ? 'handwriting' : 'markup',
    feature_confidence: 1,
    kind,
    kind_source: 'manual_synthetic',
    scored_type: kind,
    scored_score: 1,
    hmp: null,
    marked_text: text,
    ai_eligible: true,
    origin: 'auto',
    is_tombstone: false,
  });
  bus.emit('mark:resolved', { feature: kind === 'note' ? 'handwriting' : 'markup', text });
  await refreshSpine();
  const axis = await getFoldedMarksByContext(`mtg_${meetingId}`);
  let exportedKinds: string[] = [];
  try {
    const exported = await import('../integration/inksurface/meeting-export').then((m) => m.buildMeetingL1Export(meetingId));
    exportedKinds = [...new Set(exported.knowledgeExport.objects.map((ko) => ko.kind))].sort();
  } catch {
    exportedKinds = [];
  }
  return {
    ok: true,
    kind,
    meeting_id: meetingId,
    runtime_document_id: `mtgdoc_${meetingId}`,
    document_id: state.documentId,
    context_id: `mtg_${meetingId}`,
    mark_id: markId,
    axis_count: axis.length,
    exported_kinds: exportedKinds,
  };
}

function wireBack(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-back]').forEach((b) => b.addEventListener('click', () => {
    const to = b.dataset.back;
    if (to === 'home') { setMtg('home'); void renderHome(); }
    else if (to === 'detail') { setMtg('detail'); void renderDetail(); }
  }));
}

/** 入口：mobile-main boot 时调一次。绑定会议 nav 进入 + live 静态控件 + 标注计数刷新。 */
export function initMobileMeeting(opts: { readerCtx: SurfaceContext }): void {
  readerCtx = opts.readerCtx;

  // 会议 rail 进入 → home（inline 已切 data-mode=meet + 高亮；这里补真数据）
  document.querySelector('.nav [data-mode="meet"]')?.addEventListener('click', () => {
    teardownLive();
    rememberMeetingHomeFilter('active');
    setMtg('home');
    void renderHome();
  });
  document.addEventListener('inkloop:feishu-oauth-complete', () => {
    if (document.body.dataset.mode !== 'meet') {
      void meetingPollTick();
      return;
    }
    if (document.body.dataset.mtg === 'home') void renderHome({ sync: 'blocking', keepPage: true });
    else if (document.body.dataset.mtg === 'detail') void renderDetail();
    else void meetingPollTick();
  });
  // 会议子导航（群聊/日程双子页）已删 → 单页面会议流：home 直接是会议列表（单页面收敛·阶段①）
  // 离开会议面（点阅读/dev）→ 若在会中，先收起白板搬回阅读
  document.querySelectorAll('.nav [data-mode="read"], .nav [data-mode="dev"]').forEach((b) => b.addEventListener('click', () => teardownLive()));
  startMeetingPoll(); // E 实时状态：会议面可见时每 12s 同步 panel/日历 + 抓窗口内群文件 + 变化重渲（不打断当前活动）

  // live 静态控件
  el('mlive-back').addEventListener('click', () => exitToDetail());
  el('mtg-side-tab').addEventListener('click', () => document.body.classList.toggle('side-open'));
  el('mtg-chip').addEventListener('click', () => { const sp = el('mtg-spine'); sp.hidden = !sp.hidden; if (!sp.hidden) void refreshSpine(); });

  // 会议手记 bar：翻页（瞬时·电纸屏无滑）+ 标题改名（落 doc）。
  el('mtg-note-prev').addEventListener('click', () => gotoMeetingNotePage(-1));
  el('mtg-note-next').addEventListener('click', () => gotoMeetingNotePage(1));
  el('mtg-note-title').addEventListener('blur', () => {
    if (!liveNoteDoc) return;
    const t = (el('mtg-note-title').textContent || '').trim() || liveNoteDoc.filename || '会议手记';
    el('mtg-note-title').textContent = t;
    liveNoteDoc.filename = t;
    void renameDiary(liveNoteDoc.document_id, t);
  });
  el('mtg-note-title').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } });
  const scheduleMeetingNoteResize = (): void => { window.setTimeout(resizeMeetingNoteSurface, 80); };
  const meetingResizeObserver = 'ResizeObserver' in window ? new ResizeObserver(scheduleMeetingNoteResize) : null;
  meetingResizeObserver?.observe(el('mtg-stage-host'));
  window.addEventListener('resize', scheduleMeetingNoteResize);
  window.addEventListener('orientationchange', scheduleMeetingNoteResize);
  window.visualViewport?.addEventListener('resize', scheduleMeetingNoteResize);

  // 基岩 lease 配套：用户会议中手动设过基岩 → 标记 override（退出别误关）；切后台/关页 flush 并按 lease 处理。
  bus.on('bedrock:user-set', () => { if (liveMtg && liveMtg.status === 'live' && !liveMtg.frozenAt) bedrockUserOverride = true; }); // 仅飞书已判 live 的会议里用户手动设过才接管（会前/已结束不接管·M1）
  window.addEventListener('pagehide', stopMeetingBedrock);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopMeetingBedrock();
    else if (liveMtg && liveMtg.status === 'live' && !liveMtg.frozenAt) startMeetingBedrock(); // 切回前台且在飞书已判 live 的会议 → 续租（会前不录·M1）
  });

  // 标注账本变化 → 从折叠后的真实账本刷新计数。擦除也会落 mark 事件，不能乐观 +1。
  // 时间脊重建去抖（普通笔逐笔发 mark:resolved，连续手写别逐笔重建 spine·过刷电纸屏）。
  let spineRefreshTimer = 0;
  bus.on('mark:resolved', () => {
    if (!liveMtg) return;
    clearTimeout(spineRefreshTimer);
    spineRefreshTimer = window.setTimeout(() => {
      if (el('mtg-spine').hidden) void refreshLiveMarkCounters();
      else void refreshSpine();
    }, 500);
  });
}
