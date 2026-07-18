export interface StandaloneServiceEnv {
  PANEL_AUTH_BASE?: string;
  PANEL_FEISHU_BASE?: string;
}

export const MEETING_SUMMARY_MAX_BODY_BYTES = 192 * 1024;

export function meetingSummaryPayloadTooLargeError(): Error & { status: number } {
  return Object.assign(new Error('meeting_summary_payload_too_large'), { status: 413 });
}

export function resolvePanelAuthBase(env: StandaloneServiceEnv): string {
  return String(env.PANEL_AUTH_BASE || '').trim().replace(/\/+$/, '');
}

// APK 烧死的旧 feishu-service 绝对地址（VITE_FEISHU_SERVICE_ABSOLUTE 历史值）。迁 AWS 后这些内网源
// convert sidecar 既够不着、也过不了它的 SSRF 白名单——在 hub 转发层重写为 hub 自身的 feishu-svc 代理，
// 已装机设备不用重刷即可恢复图片/HTML→PDF。下次重建 APK 改对 env 后此表只服务存量包。
const LEGACY_FEISHU_SOURCE_ORIGINS = ['http://172.168.100.15:4321', 'http://10.4.36.30:4321', 'http://localhost:4321'];

export function rewriteLegacyConvertSource(rest: string, selfFeishuBase: string): string {
  const u = new URL(rest || '/', 'http://inkloop.local');
  const src = u.searchParams.get('url') || '';
  const legacy = LEGACY_FEISHU_SOURCE_ORIGINS.find((origin) => src === origin || src.startsWith(`${origin}/`));
  if (!legacy) return rest;
  u.searchParams.set('url', `${selfFeishuBase}${src.slice(legacy.length)}`);
  return `${u.pathname}${u.search}`;
}
