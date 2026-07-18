import { describe, expect, it } from 'vitest';
import {
  MEETING_SUMMARY_MAX_BODY_BYTES,
  meetingSummaryPayloadTooLargeError,
  resolvePanelAuthBase,
} from './standalone-service-config';

describe('standalone service config', () => {
  it('does not inherit PANEL_FEISHU_BASE when PANEL_AUTH_BASE is empty', () => {
    expect(resolvePanelAuthBase({ PANEL_AUTH_BASE: '', PANEL_FEISHU_BASE: 'http://127.0.0.1:13001' })).toBe('');
    expect(resolvePanelAuthBase({ PANEL_AUTH_BASE: ' http://127.0.0.1:13002///' })).toBe('http://127.0.0.1:13002');
  });

  it('sets the meeting summary body gate to 192KB and reports overflow as 413', () => {
    expect(MEETING_SUMMARY_MAX_BODY_BYTES).toBe(192 * 1024);
    expect(meetingSummaryPayloadTooLargeError()).toMatchObject({
      message: 'meeting_summary_payload_too_large',
      status: 413,
    });
  });
});
