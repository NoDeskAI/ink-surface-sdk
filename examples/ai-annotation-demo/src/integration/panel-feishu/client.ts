/**
 * WS2-C panel 飞书事件中枢 client（会后对照取数）。
 * 走同源 `/api/panel-feishu/*` → vite dev proxy（注入 x-inkloop-secret·secret 不进前端）→ panel `/api/feishu/*`。
 * 经 `core/api.ts` 的 `getJson`（覆盖 dev 同源 + 生产 VITE_API_BASE_URL）·不裸 fetch。
 * 旧 `feishuGet`(:4321) 只管群/会议/消息/文件·与本 client（妙记转写）是两套·别混。
 */
import { getJson, postJson } from '../../core/api';
import type { PanelMeetingSummaryRecord } from '../../core/store-format';

const BASE = '/api/panel-feishu';
const FEISHU_SVC_BASE = '/api/feishu-svc/api/feishu';

/** panel 落库的飞书会议（含 t0 近似 start_time + 关联到的 minute_token）。 */
export interface PanelFeishuMeeting {
  meeting_id: string;
  meeting_no?: string;
  topic?: string;
  start_time?: number;   // epoch ms（录音 t0 近似）
  end_time?: number;     // epoch ms
  owner_open_id?: string;
  group_ids?: string[];
  minute_token?: string | null;
  minute_url?: string | null;
  /** 妙记↔会议关联可信度（panel WS2）：exact=端侧/人工显式绑定 · heuristic=topic/时间窗推测 · none=无。 */
  match?: MinuteMatch;
}

interface CloudHubMeetingSource {
  source_id?: string;
  source?: string;
  title?: string;
  status?: 'upcoming' | 'live' | 'ended';
  scheduled_at?: string;
  started_at?: string;
  ended_at?: string;
  meeting_no?: string;
  feishu_meeting_id?: string;
  feishu_minute_token?: string;
  meeting_url?: string;
  calendar_event_id?: string;
  calendar_id?: string;
  chat_id?: string;
  chat_name?: string;
}

interface CloudHubMeetingSourcesResponse {
  connected?: boolean;
  configured?: boolean;
  sources?: CloudHubMeetingSource[];
  errors?: Array<{ source?: string; code?: string; message?: string; required_scope?: string; permission_url?: string }>;
}

/** panel 妙记匹配元信息（向后兼容：老接口无此字段时为 undefined）。 */
export interface MinuteMatch {
  minute_token: string | null;
  confidence: 'exact' | 'heuristic' | 'none';
  source: 'explicit' | 'topic' | 'time_window' | null;
  matched_by?: string | null;
}

export interface PanelMinuteMeta {
  token?: string;
  title?: string;
  url?: string;
  duration?: string;
  create_time?: string;
  owner_id?: string;
}

export interface LarkMeetingNoteTranscript {
  connected: boolean;
  configured: boolean;
  source: 'lark_meeting_note_transcript';
  status: 'ready' | 'not_configured' | 'oauth_unavailable' | 'missing_scope' | 'meeting_not_found' | 'missing_note' | 'missing_transcript' | 'failed';
  meeting_id: string;
  meeting?: {
    id: string;
    topic?: string;
    meeting_no?: string;
    start_time?: string;
    end_time?: string;
    note_id?: string;
  };
  note?: { note_id: string; artifact_count: number };
  artifacts?: Array<{
    artifact_type?: number;
    document_id: string;
    title?: string;
    revision_id?: number;
    content_length?: number;
    segment_count?: number;
    speaker_count?: number;
  }>;
  transcript?: {
    source: 'feishu_note_docx';
    minute_token: string;
    document_id: string;
    title?: string;
    srt: string;
    cue_count: number;
    speaker_count: number;
    parser_version: 2;
    raw_content: string;
    segments: Array<{
      index: number;
      speaker: string;
      speaker_source: 'identified' | 'device_diarization';
      speaker_device_owner?: string;
      start_ms: number;
      end_ms: number;
      text: string;
    }>;
    content_length: number;
    fetched_at: string;
  };
  summary?: {
    source: 'feishu_note_docx';
    document_id: string;
    title?: string;
    content: string;
    content_length: number;
    fetched_at: string;
    images?: Array<{
      index: number;
      file_token: string;
    }>;
  };
  errors?: Array<{ source: string; code: string; message: string; required_scope?: string; permission_url?: string }>;
}

/** 最近会议（按 start_time 倒序·已附最可能的 minute_token）。 */
export async function listRecentPanelMeetings(limit = 20, opts?: { signal?: AbortSignal }): Promise<PanelFeishuMeeting[]> {
  try {
    const r = await getJson<CloudHubMeetingSourcesResponse>(
      `${FEISHU_SVC_BASE}/meeting-sources?lookback_days=30&lookahead_days=14&page_size=${encodeURIComponent(String(limit))}`,
      opts,
    );
    const sources = r.sources ?? [];
    if (!sources.length && r.errors?.length) {
      throw new Error(meetingSourceErrorMessage(r.errors));
    }
    return sources
      .map(panelMeetingFromCloudHubSource)
      .filter((meeting): meeting is PanelFeishuMeeting => !!meeting)
      .sort((a, b) => (b.start_time || 0) - (a.start_time || 0))
      .slice(0, limit);
  } catch (cloudHubError) {
    try {
      const r = await getJson<{ meetings: PanelFeishuMeeting[] }>(`${BASE}/meetings/recent?limit=${encodeURIComponent(String(limit))}`, opts);
      return r.meetings ?? [];
    } catch {
      throw cloudHubError;
    }
  }
}

function meetingSourceErrorMessage(errors: NonNullable<CloudHubMeetingSourcesResponse['errors']>): string {
  const first = errors[0];
  const message = first?.message || first?.code || '飞书会议源为空';
  const scope = first?.required_scope ? `；需要权限：${first.required_scope}` : '';
  return `${message}${scope}`;
}

function epochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

function panelMeetingFromCloudHubSource(source: CloudHubMeetingSource): PanelFeishuMeeting | null {
  const meetingId = source.feishu_meeting_id || source.meeting_no || source.source_id || source.calendar_event_id;
  if (!meetingId) return null;
  const start = epochMs(source.started_at || source.scheduled_at);
  const end = epochMs(source.ended_at);
  return {
    meeting_id: meetingId,
    meeting_no: source.meeting_no,
    topic: source.title,
    start_time: start,
    end_time: end,
    minute_token: source.feishu_minute_token ?? null,
    minute_url: null,
    match: source.feishu_minute_token
      ? { minute_token: source.feishu_minute_token, confidence: 'exact', source: 'explicit' }
      : { minute_token: null, confidence: 'none', source: null },
  };
}

/** L1+L5 增量事件（设备增量轮询·seq 游标）：一条 event 内嵌完整会议（带真 start_time + match + 当前 minute_token）。 */
export interface PanelMeetingEvent {
  seq: number;
  type: 'started' | 'ended' | 'minute_bound' | 'summary_ready';
  occurred_at: number;          // epoch ms（started=会议开始 / ended=会议结束 / minute_bound=妙记绑定 / summary_ready=总结生成）
  created_at: number;           // epoch ms（panel 落库时刻）
  meeting: PanelFeishuMeeting;
}

/**
 * 拉自 since(游标 seq) 之后的会议开始/结束事件。设备休眠/离线/无公网 → 增量轮询而非推送。
 * 返回 cursor 存本地，下次带上；server_time 供时钟漂移参考。
 */
export async function pollPanelMeetingEvents(since = 0, opts?: { signal?: AbortSignal }): Promise<{ server_time: number; cursor: number; events: PanelMeetingEvent[] }> {
  return getJson<{ server_time: number; cursor: number; events: PanelMeetingEvent[] }>(
    `${BASE}/meetings/events?since=${encodeURIComponent(String(since))}`,
    opts,
  );
}

/** 当前进行中的会议快照（新设备无 cursor / 迟到打开时补 active·12h 内开始且未结束）。 */
export async function listActivePanelMeetings(limit = 20, opts?: { signal?: AbortSignal }): Promise<PanelFeishuMeeting[]> {
  const r = await getJson<{ meetings: PanelFeishuMeeting[] }>(`${BASE}/meetings/active?limit=${encodeURIComponent(String(limit))}`, opts);
  return r.meetings ?? [];
}

/** 妙记带时间戳转写（SRT 文本·cue 时间相对录音 t=0）。 */
export async function getMinuteTranscript(token: string, format: 'srt' | 'txt' = 'srt', opts?: { signal?: AbortSignal }): Promise<string> {
  const r = await getJson<{ transcript: string }>(`${BASE}/minutes/${encodeURIComponent(token)}/transcript?format=${format}`, opts);
  return r.transcript ?? '';
}

/** 飞书会议 note/docx 会后文字记录：meeting_id -> note_id -> artifact_type=2 docx -> SRT。 */
export async function getMeetingNoteTranscript(meetingId: string, opts?: { signal?: AbortSignal }): Promise<LarkMeetingNoteTranscript> {
  return getJson<LarkMeetingNoteTranscript>(`${FEISHU_SVC_BASE}/meetings/${encodeURIComponent(meetingId)}/note-transcript`, opts);
}

/**
 * 单场按需解析：入会短号 + 该场计划时间 → 真 VC meeting_id（±6h 窗单次 list_by_no）。
 * 打开某场会议时才调，避免批量解析触发飞书频率限流。返回 null = 没解析出真 id（保持短号未关联态）。
 */
export async function resolveMeetingInstance(meetingNo: string, scheduledAt: string, opts?: { signal?: AbortSignal }): Promise<{ meeting_id: string; meeting_no?: string; topic?: string; started_at?: string; ended_at?: string } | null> {
  if (!meetingNo || !scheduledAt) return null;
  const q = new URLSearchParams({ meeting_no: meetingNo, scheduled_at: scheduledAt });
  const r = await getJson<{ meeting: CloudHubMeetingSource | null }>(`${FEISHU_SVC_BASE}/meeting-instance?${q}`, opts);
  const s = r.meeting;
  const id = s?.feishu_meeting_id;
  if (!s || !id || id === (s.meeting_no || meetingNo)) return null;
  return { meeting_id: id, meeting_no: s.meeting_no, topic: s.title, started_at: s.started_at, ended_at: s.ended_at };
}

/** 妙记元信息（标题/时长/url）。 */
export async function getMinuteMeta(token: string, opts?: { signal?: AbortSignal }): Promise<PanelMinuteMeta> {
  const r = await getJson<{ minute: PanelMinuteMeta }>(`${BASE}/minutes/${encodeURIComponent(token)}`, opts);
  return r.minute ?? {};
}

/**
 * 显式把 minute_token 绑定到 panel 会议（端侧确认关联后回写）。
 * 把 panel 的 topic/时间窗 heuristic 升成 exact；失败返回 null（不阻断本地关联，本地已存 token）。
 */
export async function bindPanelMinute(meetingId: string, minuteToken: string, opts?: { signal?: AbortSignal }): Promise<PanelFeishuMeeting | null> {
  try {
    const r = await postJson<{ meeting: PanelFeishuMeeting }>(
      `${BASE}/meetings/${encodeURIComponent(meetingId)}/bind-minute`,
      { minute_token: minuteToken, bound_by: 'inkloop' },
      opts,
    );
    return r.meeting ?? null;
  } catch {
    return null;
  }
}

/** L5 总结取数状态。missing_minute 仅保留一个版本兼容旧 panel，设备收到后归一为 not_generated。 */
export type PanelMeetingSummaryStatus = 'ready' | 'not_generated' | 'missing_minute' | 'transcript_not_ready' | 'not_found' | 'failed';

/** GET 已生成的 panel 五要素总结（不触发生成·未生成时 summary=null·status 指示原因）。 */
export async function getPanelMeetingSummary(meetingId: string, opts?: { signal?: AbortSignal }): Promise<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }> {
  return getJson<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }>(
    `${BASE}/meetings/${encodeURIComponent(meetingId)}/summary`,
    opts,
  );
}

/** POST 触发 panel 现总结并落库（用户点「生成总结」时·panel 侧 in-flight 去重·M3 一次几秒~十几秒）。
 *  409 用于转写仍在生成等可重试状态；旧 panel 也可能返回 legacy missing_minute，必须保留 body 供设备归一。 */
export async function generatePanelMeetingSummary(meetingId: string, opts?: { signal?: AbortSignal }): Promise<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }> {
  return postJson<{ status: PanelMeetingSummaryStatus; summary: PanelMeetingSummaryRecord | null }>(
    `${BASE}/meetings/${encodeURIComponent(meetingId)}/summary`,
    {},
    { ...opts, acceptStatuses: [409] },
  );
}
