/**
 * Zoom API 路径段编码：UUID 以 `/` 开头或包含 `//` 时必须 double-encode，
 * 其余 UUID/ID 只做一次 encodeURIComponent。所有 Zoom 动态路径段统一从这里进入。
 */
export function zoomUuidPathSegment(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(once) : once;
}
