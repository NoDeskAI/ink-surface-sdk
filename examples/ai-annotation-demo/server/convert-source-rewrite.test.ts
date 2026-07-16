import { describe, expect, it } from 'vitest';
import { rewriteLegacyConvertSource } from './standalone-service-config';

const SELF = 'http://127.0.0.1:8731/api/feishu-svc';

describe('rewriteLegacyConvertSource', () => {
  it('把 APK 烧死的旧 feishu-service 源重写为 hub 自身代理', () => {
    const rest = `/to-pdf?url=${encodeURIComponent('http://172.168.100.15:4321/api/feishu/messages/om_1/file/k_1?type=image&name=a.png')}&name=a.png`;
    const out = rewriteLegacyConvertSource(rest, SELF);
    const url = new URL(out, 'http://x').searchParams.get('url');
    expect(url).toBe(`${SELF}/api/feishu/messages/om_1/file/k_1?type=image&name=a.png`);
  });

  it('三个历史源都命中', () => {
    for (const origin of ['http://172.168.100.15:4321', 'http://10.4.36.30:4321', 'http://localhost:4321']) {
      const out = rewriteLegacyConvertSource(`/to-pdf?url=${encodeURIComponent(`${origin}/api/feishu/x`)}`, SELF);
      expect(new URL(out, 'http://x').searchParams.get('url')).toBe(`${SELF}/api/feishu/x`);
    }
  });

  it('非旧源原样透传（不误伤正常地址）', () => {
    const rest = `/to-pdf?url=${encodeURIComponent(`${SELF}/api/feishu/x`)}&name=b.html`;
    expect(rewriteLegacyConvertSource(rest, SELF)).toBe(rest);
    const other = '/to-pdf?url=https%3A%2F%2Fexample.com%2Fa.html';
    expect(rewriteLegacyConvertSource(other, SELF)).toBe(other);
  });

  it('前缀相似但非边界不命中（http://localhost:43210 不算 localhost:4321）', () => {
    const rest = '/to-pdf?url=http%3A%2F%2Flocalhost%3A43210%2Fapi%2Ffeishu%2Fx';
    expect(rewriteLegacyConvertSource(rest, SELF)).toBe(rest);
  });
});
