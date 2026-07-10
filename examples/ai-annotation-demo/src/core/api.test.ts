import { describe, expect, it } from 'vitest';
import { normalizeLocalCloudHubBase } from './api';

describe('normalizeLocalCloudHubBase', () => {
  it('routes private HTTPS CloudHub dev endpoints back to fixed HTTP port 8731', () => {
    expect(normalizeLocalCloudHubBase('https://172.168.21.253:8732')).toBe('http://172.168.21.253:8731');
    expect(normalizeLocalCloudHubBase('https://192.168.1.8:8732/')).toBe('http://192.168.1.8:8731');
    expect(normalizeLocalCloudHubBase('https://127.0.0.1:8732')).toBe('http://127.0.0.1:8731');
  });

  it('keeps public HTTPS routes unchanged', () => {
    expect(normalizeLocalCloudHubBase('https://inkloopai.xiaobuyu.trade')).toBe('https://inkloopai.xiaobuyu.trade');
  });
});
