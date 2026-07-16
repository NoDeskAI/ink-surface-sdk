import { listLarkRealtimeMeetings, upsertLarkRealtimeMeeting, type LarkRealtimeMeetingRecord } from './lark-realtime-meeting-store';

// WS end 事件会因断线、hub 重启窗口、同 app 多长连接抢路由而丢，账本卡死在 live。
// 这里用 REST 对账兜底：周期拿 owner/参会者的用户 token 查 VC 会议真实状态，已结束就补记 ended（幂等）。

export interface LarkMeetingReconcileOptions {
  root: string;
  /** 按 open_id 解析可用的用户 access_token；不可用返回空串（不 throw）。 */
  resolveUserToken: (openId: string) => Promise<string>;
  /** 兜底候选：hub 全部已授权用户 open_id。owner/参会人都拿不到 token 时挨个试（飞书只对
   *  API 预约的会投 join/leave，普通会参会人恒空——同事主持的会没这兜底一个 token 都试不上）。 */
  listFallbackOpenIds?: () => string[];
  baseUrl?: string;
  nowMs?: number;
  /** live 起始至今低于该时长的不查（刚开始的会查了也是"进行中"，白耗限额）。 */
  minLiveAgeMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  logger?: (event: string, details?: unknown) => void;
}

export interface LarkMeetingReconcileResult {
  checked: number;
  ended: number;
  still_live: number;
  skipped: number;
  /** 参会人富化条数（with_participants 拉到真实名单并入实时库·桥每 10s 推给 panel）。 */
  enriched: number;
  errors: string[];
}

// 飞书 VC GetMeeting status 枚举：1=待开始 2=进行中 3=已结束
const VC_MEETING_STATUS_ENDED = 3;

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function tokenOpenIdCandidates(record: LarkRealtimeMeetingRecord, fallbackOpenIds: string[] = []): string[] {
  // owner→参会者→（都没有可用时）hub 已授权用户兜底。兜底封顶 5 个防 API 放大。
  return [...new Set([
    text(record.owner_open_id),
    ...(record.participant_open_ids ?? []).map(text),
    ...fallbackOpenIds.map(text).slice(0, 5),
  ].filter(Boolean))];
}

/** GetMeeting 响应里的参会人 open_id（user_id_type=open_id 时 participant.id 即 open_id；防御性兼容对象形态）。 */
function participantOpenIdsFromVc(vc: Record<string, unknown>): string[] {
  const list = Array.isArray(vc.participants) ? vc.participants : [];
  return [...new Set(list.map((item) => {
    const p = obj(item);
    return text(p.id) || text(obj(p.id).open_id);
  }).filter(Boolean))];
}

export function staleLiveLarkMeetings(root: string, nowMs: number, minLiveAgeMs: number): LarkRealtimeMeetingRecord[] {
  return listLarkRealtimeMeetings(root, { nowMs }).filter((record) => {
    if (record.status !== 'live' || !text(record.feishu_meeting_id)) return false;
    const startedMs = Date.parse(record.started_at || record.scheduled_at);
    return Number.isFinite(startedMs) && nowMs - startedMs >= minLiveAgeMs;
  });
}

export async function reconcileLarkLiveMeetings(options: LarkMeetingReconcileOptions): Promise<LarkMeetingReconcileResult> {
  const nowMs = options.nowMs ?? Date.now();
  const baseUrl = (options.baseUrl || 'https://open.feishu.cn').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || fetch;
  const result: LarkMeetingReconcileResult = { checked: 0, ended: 0, still_live: 0, skipped: 0, enriched: 0, errors: [] };
  const stale = staleLiveLarkMeetings(options.root, nowMs, options.minLiveAgeMs ?? 90_000);
  const tokenCache = new Map<string, string>();

  const resolveTokenCached = async (openId: string): Promise<string> => {
    if (!tokenCache.has(openId)) {
      try {
        tokenCache.set(openId, await options.resolveUserToken(openId));
      } catch {
        tokenCache.set(openId, '');
      }
    }
    return tokenCache.get(openId) || '';
  };

  const fallbackOpenIds = options.listFallbackOpenIds?.() ?? [];

  // 单场会议逐 token 查 VC 状态+参会人。权限类失败换下一个 token；网络/429/5xx 停止（别放大）。
  const checkMeeting = async (meeting: LarkRealtimeMeetingRecord): Promise<
    { outcome: 'no_token' } | { outcome: 'failed'; error: string } |
    { outcome: 'ok'; status: number; endTime: string; participants: string[] }
  > => {
    let anyToken = false;
    let lastError = '';
    for (const openId of tokenOpenIdCandidates(meeting, fallbackOpenIds)) {
      const token = await resolveTokenCached(openId);
      if (!token) continue;
      anyToken = true;
      try {
        const meetingId = encodeURIComponent(text(meeting.feishu_meeting_id));
        const res = await fetchImpl(`${baseUrl}/open-apis/vc/v1/meetings/${meetingId}?with_participants=true&user_id_type=open_id`, {
          headers: { authorization: `Bearer ${token}` },
          signal: options.signal,
        });
        const json = obj(await res.json().catch(() => ({})));
        const code = Number(json.code);
        if (res.status === 429 || res.status >= 500) return { outcome: 'failed', error: `vc_get_failed http=${res.status}` };
        if (!res.ok || code !== 0) {
          lastError = `vc_get_failed code=${Number.isFinite(code) ? code : res.status} ${text(json.msg)}`.trim();
          continue;
        }
        const vc = obj(obj(json.data).meeting);
        const status = Number(vc.status);
        if (![1, 2, VC_MEETING_STATUS_ENDED].includes(status)) {
          return { outcome: 'failed', error: `vc_get_invalid_response status=${String(vc.status ?? 'missing')}` };
        }
        return { outcome: 'ok', status, endTime: text(vc.end_time), participants: participantOpenIdsFromVc(vc) };
      } catch (e) {
        return { outcome: 'failed', error: String((e as Error)?.message || e) };
      }
    }
    return anyToken ? { outcome: 'failed', error: lastError || 'unknown' } : { outcome: 'no_token' };
  };

  const mergeParticipants = (meeting: LarkRealtimeMeetingRecord, participants: string[]): boolean => {
    const known = new Set((meeting.participant_open_ids ?? []).map(text));
    const fresh = participants.filter((openId) => !known.has(openId));
    if (!fresh.length) return false;
    upsertLarkRealtimeMeeting(options.root, {
      feishu_meeting_id: meeting.feishu_meeting_id,
      scheduled_at: meeting.scheduled_at,
      status: meeting.status,
      participant_open_ids: participants,
      source_event_type: 'vc.meeting.rest_reconcile',
      source_transport: 'lark_rest_reconcile',
    }, nowMs);
    return true;
  };

  const checkedFids = new Set<string>();
  for (const meeting of stale) {
    checkedFids.add(text(meeting.feishu_meeting_id));
    const checked = await checkMeeting(meeting);
    if (checked.outcome === 'no_token') {
      result.skipped += 1;
      result.errors.push(`${meeting.id}: no_usable_token`);
      continue;
    }
    result.checked += 1;
    if (checked.outcome === 'failed') {
      result.errors.push(`${meeting.id}: ${checked.error}`);
      continue;
    }
    if (checked.status !== VC_MEETING_STATUS_ENDED) {
      result.still_live += 1;
      if (mergeParticipants(meeting, checked.participants)) result.enriched += 1;
      continue;
    }
    const endedAt = checked.endTime || new Date(nowMs).toISOString();
    upsertLarkRealtimeMeeting(options.root, {
      feishu_meeting_id: meeting.feishu_meeting_id,
      scheduled_at: meeting.scheduled_at,
      status: 'ended',
      ended_at: endedAt,
      ...(checked.participants.length ? { participant_open_ids: checked.participants } : {}),
      source_event_type: 'vc.meeting.rest_reconcile',
      source_transport: 'lark_rest_reconcile',
    }, nowMs);
    result.ended += 1;
    if (checked.participants.length) result.enriched += 1;
    options.logger?.('lark-meeting-reconcile:ended', {
      id: meeting.id,
      title: meeting.title,
      ended_at: checked.endTime || null,
    });
  }

  // 二遍扫：已结束但参会人还空的会（WS end 不带参会人·多数会走不到上面的 stale-live 分支）——
  // 限量补拉真实名单，桥推给 panel 后访问门/summarizer 可逐步回到严判。每轮封顶 5 场防 API 放大。
  const needEnrich = listLarkRealtimeMeetings(options.root, { nowMs })
    .filter((record) => record.status === 'ended' && text(record.feishu_meeting_id)
      && !(record.participant_open_ids ?? []).length && !checkedFids.has(text(record.feishu_meeting_id)))
    .slice(0, 5);
  for (const meeting of needEnrich) {
    const checked = await checkMeeting(meeting);
    if (checked.outcome !== 'ok' || !checked.participants.length) continue;
    if (mergeParticipants(meeting, checked.participants)) {
      result.enriched += 1;
      options.logger?.('lark-meeting-reconcile:enriched', { id: meeting.id, title: meeting.title, participants: checked.participants.length });
    }
  }
  return result;
}
