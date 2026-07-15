import { describe, expect, it } from 'vitest';
import { resolvePanelAuthBase } from './standalone-service-config';

describe('standalone service config', () => {
  it('does not inherit PANEL_FEISHU_BASE when PANEL_AUTH_BASE is empty', () => {
    expect(resolvePanelAuthBase({ PANEL_AUTH_BASE: '', PANEL_FEISHU_BASE: 'http://127.0.0.1:13001' })).toBe('');
    expect(resolvePanelAuthBase({ PANEL_AUTH_BASE: ' http://127.0.0.1:13002///' })).toBe('http://127.0.0.1:13002');
  });
});
