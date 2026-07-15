export interface StandaloneServiceEnv {
  PANEL_AUTH_BASE?: string;
  PANEL_FEISHU_BASE?: string;
}

export function resolvePanelAuthBase(env: StandaloneServiceEnv): string {
  return String(env.PANEL_AUTH_BASE || '').trim().replace(/\/+$/, '');
}
