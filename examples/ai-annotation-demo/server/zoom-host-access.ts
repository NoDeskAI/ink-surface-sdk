/** Explicit InkLoop tenant/user → Zoom host allow-list for account-level S2S data. */
export interface ZoomHostAccessSession {
  tenant_id?: string;
  user_id?: string;
}

export interface ZoomHostAccessEnv {
  INKLOOP_ZOOM_HOST_ACCESS_JSON?: string;
}

interface ZoomHostAccessEntry {
  tenantId: string;
  userId: string;
  hostUserIds: string[];
}

function entries(env: ZoomHostAccessEnv): ZoomHostAccessEntry[] {
  try {
    const value = JSON.parse(String(env.INKLOOP_ZOOM_HOST_ACCESS_JSON || '[]')) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): ZoomHostAccessEntry[] => {
      if (!item || typeof item !== 'object') return [];
      const input = item as Record<string, unknown>;
      const tenantId = String(input.tenant_id || '').trim();
      const userId = String(input.user_id || '').trim();
      const hostUserIds = Array.isArray(input.host_user_ids)
        ? [...new Set(input.host_user_ids.map((host) => String(host || '').trim()).filter(Boolean))]
        : [];
      return tenantId && userId && hostUserIds.length ? [{ tenantId, userId, hostUserIds }] : [];
    });
  } catch {
    return [];
  }
}

export function authorizedZoomHostUserIds(
  session: ZoomHostAccessSession,
  env: ZoomHostAccessEnv = process.env,
): string[] {
  if (!session.tenant_id || !session.user_id) return [];
  return [...new Set(entries(env)
    .filter((entry) => entry.tenantId === session.tenant_id && entry.userId === session.user_id)
    .flatMap((entry) => entry.hostUserIds))];
}
