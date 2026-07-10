import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateRawPenFrame } from 'ink-surface-sdk/runtime-schema';
import {
  framesToJsonl,
  installM103RawPenCaptureBridge,
  m103SocketStrokeToRawPenFrames,
  publishM103RawPenStroke,
  type M103RawPenSurfaceRect,
} from './m103-raw-pen-adapter';
import type { HqSocketStroke } from './m103-hqhw-socket';

const globalHost = globalThis as unknown as {
  window?: Record<string, unknown>;
  CustomEvent?: new (type: string, init?: { detail?: unknown }) => Event;
};
const originalWindow = globalHost.window;
const originalCustomEvent = globalHost.CustomEvent;

const surfaceRect: M103RawPenSurfaceRect = {
  left: 10,
  top: 20,
  width: 200,
  height: 100,
};

const stroke: Pick<HqSocketStroke, 'seq' | 'points'> = {
  seq: 7,
  points: [
    { x: 10, y: 20, pressure: 0.21, t: 0, strokeWidth: 3, flag: 320 },
    { x: 110, y: 70, pressure: 0.68, t: 24, strokeWidth: 3, flag: 320 },
    { x: 210, y: 120, pressure: 0.1, t: 48, strokeWidth: 3, flag: 320 },
  ],
};

describe('m103 raw pen adapter', () => {
  beforeEach(() => {
    globalHost.window = { dispatchEvent: () => true };
    globalHost.CustomEvent = originalCustomEvent ?? class CustomEventShim extends Event {
      detail: unknown;

      constructor(type: string, init?: { detail?: unknown }) {
        super(type);
        this.detail = init?.detail;
      }
    };
    installM103RawPenCaptureBridge()?.clear();
  });

  afterEach(() => {
    installM103RawPenCaptureBridge()?.clear();
    if (originalWindow === undefined) delete globalHost.window;
    else globalHost.window = originalWindow;
    if (originalCustomEvent === undefined) delete globalHost.CustomEvent;
    else globalHost.CustomEvent = originalCustomEvent;
  });

  it('maps M103 hqunifiedsocket CSS points into valid RawPenFrame records', () => {
    const frames = m103SocketStrokeToRawPenFrames(stroke, {
      penId: 'm103_hqhw_stylus',
      sessionId: 'doc_mobile_demo',
      surfaceId: 'page_1',
      firmwareVersion: 'm103-hqhw-bridge',
      surfaceRect,
    });

    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => frame.tip_state)).toEqual(['down', 'down', 'up']);
    expect(frames[0].optical?.x_raw).toBe(0);
    expect(frames[0].optical?.y_raw).toBe(0);
    expect(frames[1].optical?.x_raw).toBe(2048);
    expect(frames[1].optical?.y_raw).toBe(1280);
    expect(frames[2].optical?.x_raw).toBe(4096);
    expect(frames[2].optical?.y_raw).toBe(2560);
    expect(frames.flatMap((frame, index) => validateRawPenFrame(frame, `frames.${index + 1}`))).toEqual([]);
  });

  it('exports JSONL that can be attached to hardware prototype evidence', () => {
    const frames = m103SocketStrokeToRawPenFrames(stroke, {
      penId: 'm103_hqhw_stylus',
      sessionId: 'doc_mobile_demo',
      surfaceId: 'page_1',
      firmwareVersion: 'm103-hqhw-bridge',
      surfaceRect,
    });
    const jsonl = framesToJsonl(frames);
    expect(jsonl.split('\n')).toHaveLength(3);
    expect(jsonl).toContain('"pattern_id":"m103_hqunifiedsocket_7"');
    expect(jsonl).toContain('"firmware_version":"m103-hqhw-bridge"');
  });

  it('installs a startup capture bridge and accumulates physical pen batches', () => {
    const bridge = installM103RawPenCaptureBridge();
    expect(bridge).not.toBeNull();
    expect(bridge?.getSummary()).toMatchObject({
      batch_count: 0,
      frame_count: 0,
      last_batch_count: 0,
    });

    const first = publishM103RawPenStroke(stroke, {
      penId: 'm103_hqhw_stylus',
      sessionId: 'doc_mobile_demo',
      surfaceId: 'page_1',
      firmwareVersion: 'm103-hqhw-bridge',
      surfaceRect,
    });
    const second = publishM103RawPenStroke({ ...stroke, seq: 8 }, {
      penId: 'm103_hqhw_stylus',
      sessionId: 'doc_mobile_demo',
      surfaceId: 'page_1',
      firmwareVersion: 'm103-hqhw-bridge',
      surfaceRect,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(bridge?.getLastBatch()).toHaveLength(3);
    expect(bridge?.getAllFrames()).toHaveLength(6);
    expect(bridge?.getSummary()).toMatchObject({
      batch_count: 2,
      frame_count: 6,
      last_batch_count: 3,
      first_ts_device_ms: 0,
      last_ts_device_ms: 48,
    });
    expect(bridge?.exportJsonl().split('\n')).toHaveLength(3);
    expect(bridge?.exportAllJsonl().split('\n')).toHaveLength(6);

    bridge?.clear();
    expect(bridge?.getSummary()).toMatchObject({
      batch_count: 0,
      frame_count: 0,
      last_batch_count: 0,
    });
  });
});
