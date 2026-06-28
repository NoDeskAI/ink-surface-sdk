import { describe, expect, it } from 'vitest';
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  bridgeError,
  bridgeSuccess,
  isNativeBridgeRequest,
  validateNativeBridgeRequest,
  type NativeBridgeRequest,
} from './index';

describe('native bridge contract', () => {
  it('accepts a local document snapshot request', () => {
    const request: NativeBridgeRequest = {
      protocol_version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      request_id: 'req_1',
      type: 'document.snapshot.get',
      doc_id: 'doc_cached',
    };

    expect(validateNativeBridgeRequest(request)).toEqual([]);
    expect(isNativeBridgeRequest(request)).toBe(true);
  });

  it('validates mutation requests before they reach the native runtime', () => {
    const request: NativeBridgeRequest = {
      protocol_version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      request_id: 'req_2',
      type: 'mutation.apply',
      mutation: {
        operation: 'annotation.add',
        doc_id: 'doc_cached',
        block_id: 'blk_1',
        annotation: { ko_id: 'ko_new', render_mode: 'stroke_only' },
      },
    };

    expect(validateNativeBridgeRequest(request)).toEqual([]);
  });

  it('rejects unsupported protocol versions and malformed mutations', () => {
    const issues = validateNativeBridgeRequest({
      protocol_version: 'old.bridge.v0',
      request_id: 'req_bad',
      type: 'mutation.apply',
      mutation: { operation: 'block.update', doc_id: 'doc_cached' },
    });

    expect(issues.map((issue) => issue.path)).toContain('protocol_version');
    expect(issues.map((issue) => issue.path)).toContain('block_id');
    expect(issues.map((issue) => issue.path)).toContain('content');
  });

  it('creates typed success and error responses', () => {
    const request: NativeBridgeRequest = {
      protocol_version: NATIVE_BRIDGE_PROTOCOL_VERSION,
      request_id: 'req_3',
      type: 'sync.status.get',
    };

    expect(bridgeSuccess(request, { online: false })).toMatchObject({ request_id: 'req_3', ok: true });
    expect(bridgeError('req_4', 'offline_asset_missing', 'PDF page is not cached')).toMatchObject({
      request_id: 'req_4',
      ok: false,
      error: { code: 'offline_asset_missing' },
    });
  });
});
