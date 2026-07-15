import { listLarkRealtimeMeetings, upsertLarkRealtimeMeeting, type LarkRealtimeMeetingRecord } from './lark-realtime-meeting-store';

// WS end 事件会因断线、hub 重启窗口、同 app 多长连接抢路由而丢，账本卡死在 live。
// 这里用 REST 对账兜底：周期拿 owner/参会者的用户 token 查 VC 会议真实状态，已结束就补记 ended（幂等）。

export interface LarkMeetingReconcileOptions {
  root: string;
  /** 按 open_id 解析可用的用户 access_token；不可用返回空串（不 throw）。 */
  resolveUserToken: (openId: string) => Promise<string>;
  baseUrl?: string;
  nowMs?: number;
  /** live 起始至今低于该时长的不查（刚开始的会查了也是"进行中"，白耗限额）。 */
  minLiveAgeMs?: number;
  fetchImpl?: typeof fetch;
  logger?: (event: string, details?: unknown) => void;
}

export interface LarkMeetingReconcileResult {
  checked: number;
  ended: number;
  still_live: number;
  skipped: number;
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

function tokenOpenIdCandidates(record: LarkRealtimeMeetingRecord): string[] {
  return [...new Set([text(record.owner_open_id), ...(record.participant_open_ids ?? []).map(text)].filter(Boolean))];
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
  const result: LarkMeetingReconcileResult = { checked: 0, ended: 0, still_live: 0, skipped: 0, errors: [] };
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

  for (const meeting of stale) {
    // owner token 可能对该会议无 VC 权限（旧授权缺 scope）——逐 token 尝试 owner→参会者，
    // 权限类失败换下一个；网络/429/5xx 停止（别放大）。
    let anyToken = false;
    let handled = false;
    let lastError = '';
    for (const openId of tokenOpenIdCandidates(meeting)) {
      const token = await resolveTokenCached(openId);
      if (!token) continue;
      anyToken = true;
      try {
        const meetingId = encodeURIComponent(text(meeting.feishu_meeting_id));
        const res = await fetchImpl(`${baseUrl}/open-apis/vc/v1/meetings/${meetingId}?with_participants=false`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const json = obj(await res.json().catch(() => ({})));
        const code = Number(json.code);
        if (res.status === 429 || res.status >= 500) {
          lastError = `vc_get_failed http=${res.status}`;
          break;
        }
        if (!res.ok || code !== 0) {
          lastError = `vc_get_failed code=${Number.isFinite(code) ? code : res.status} ${text(json.msg)}`.trim();
          continue;
        }
        const vc = obj(obj(json.data).meeting);
        const status = Number(vc.status);
        if (![1, 2, VC_MEETING_STATUS_ENDED].includes(status)) {
          lastError = `vc_get_invalid_response status=${String(vc.status ?? 'missing')}`;
          break;
        }
        handled = true;
        if (status !== VC_MEETING_STATUS_ENDED) {
          result.still_live += 1;
          break;
        }
        const endTime = text(vc.end_time);
        upsertLarkRealtimeMeeting(options.root, {
          feishu_meeting_id: meeting.feishu_meeting_id,
          scheduled_at: meeting.scheduled_at,
          status: 'ended',
          ended_at: endTime || new Date(nowMs).toISOString(),
          source_event_type: 'vc.meeting.rest_reconcile',
          source_transport: 'lark_rest_reconcile',
        }, nowMs);
        result.ended += 1;
        options.logger?.('lark-meeting-reconcile:ended', {
          id: meeting.id,
          title: meeting.title,
          ended_at: endTime || null,
        });
        break;
      } catch (e) {
        lastError = String((e as Error)?.message || e);
        break;
      }
    }
    if (!anyToken) {
      result.skipped += 1;
      result.errors.push(`${meeting.id}: no_usable_token`);
      continue;
    }
    result.checked += 1;
    if (!handled) result.errors.push(`${meeting.id}: ${lastError || 'unknown'}`);
  }
  return result;
}
