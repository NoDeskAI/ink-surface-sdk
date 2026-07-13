/**
 * 权威身份校准：前端 core session 的 userId 在设备授权时被设成 local_user/local_demo，
 * 飞书登录后【后端】同一 token 被升级成 feishu_ou_*，但前端 localStorage 从不更新
 * （整页重定向登录回来只更新会议 UI 的 fsIdentityCache）。→ runtimeUserId() 恒 local_user，
 * 与后端权威身份分歧，导致 vault 403 / runtime-sync cursor 错桶 / library SSE 不重连。
 *
 * 此模块以【后端 /api/feishu/me 返回的 session】为权威，覆盖前端 core session。
 * 调用点：装 runtime host 前、拉 /me 后、pageshow/visibilitychange（web 重定向登录回来）。
 * setSession 会 emit 'login' 事件 → runtime-sync-host / library-sync 借此重建 namespace。
 */
import { getJson } from './api';
import { getSession, setSession, type InkLoopSession } from './auth';

interface AuthorityMeResponse {
  session?: {
    tenant_id?: string;
    user_id?: string;
    device_id?: string;
    feishu_open_id?: string | null;
  };
}

let inFlight: Promise<boolean> | null = null;

/** 拉后端权威身份覆盖前端 core session；身份有变返回 true。并发去重。失败静默返回 false（不打断离线）。 */
export function refreshCoreSessionFromAuthority(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = doRefresh().finally(() => { inFlight = null; });
  return inFlight;
}

async function doRefresh(): Promise<boolean> {
  const current = getSession();
  if (!current) return false; // 没登录设备就没得校准
  let me: AuthorityMeResponse;
  try {
    me = await getJson<AuthorityMeResponse>('/api/feishu-svc/api/feishu/me', { auth: true });
  } catch {
    return false; // 离线/网络失败：保留现有本地身份，不打断
  }
  const remote = me.session;
  if (!remote?.tenant_id || !remote.user_id) return false;
  // 请求期间若发生 登出/换人（token 变了）→ 旧响应作废，绝不能用旧身份覆盖新 session（否则恢复已登出账号/覆盖新账号）。
  const latest = getSession();
  if (!latest || latest.sessionToken !== current.sessionToken || latest.sessionId !== current.sessionId || latest.deviceId !== current.deviceId) return false;
  // 设备身份不该在校准中被换掉——换设备是异常，宁可不动（避免把 A 设备的库挂到 B）。
  if (remote.device_id && remote.device_id !== latest.deviceId) return false;

  if (remote.tenant_id === latest.tenantId && remote.user_id === latest.userId) return false;

  const next: InkLoopSession = {
    ...latest,
    tenantId: remote.tenant_id,
    userId: remote.user_id,
    deviceId: remote.device_id || latest.deviceId,
  };
  setSession(next); // emit 'login' → runtime/library 监听重建 namespace
  return true;
}
