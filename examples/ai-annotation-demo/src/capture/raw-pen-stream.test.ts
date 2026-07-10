import { describe, expect, it } from 'vitest';
import { INKLOOP_AI_PEN_CONTRACT_VERSION, type RawPenFrame } from 'ink-surface-sdk/runtime-schema';
import {
  createRawPenFrameBridge,
  groupRawFramesIntoStrokes,
  parseAndValidateRawFrameRecords,
  parseRawFrameRecords,
  pointFromRawFrame,
} from './raw-pen-stream';

function frame(overrides: Partial<RawPenFrame> = {}): RawPenFrame {
  return {
    schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
    pen_id: 'pen_hw_001',
    session_id: 'sess_hw_001',
    surface_id: 'surface_a2_hw',
    ts_device_ms: 100,
    ts_host_ms: 112,
    tip_state: 'down',
    pressure: 0.72,
    optical: {
      x_raw: 2048,
      y_raw: 1280,
      pattern_id: 'a2_grid',
      quality: 0.94,
    },
    firmware_version: '0.1.0',
    ...overrides,
  };
}

describe('raw pen stream', () => {
  it('parses JSONL, JSON arrays, and wrapped frame payloads', () => {
    const jsonl = [
      JSON.stringify({ frame: frame({ ts_device_ms: 100, tip_state: 'down' }) }),
      JSON.stringify({ raw_pen_frame: frame({ ts_device_ms: 140, tip_state: 'up' }) }),
    ].join('\n');
    expect(parseRawFrameRecords(jsonl)).toHaveLength(2);

    const array = JSON.stringify([
      frame({ ts_device_ms: 100, tip_state: 'down' }),
      frame({ ts_device_ms: 140, tip_state: 'up' }),
    ]);
    const parsed = parseAndValidateRawFrameRecords(array);
    expect(parsed.issues).toEqual([]);
    expect(parsed.records).toHaveLength(2);

    const wrappedBatch = JSON.stringify({
      frames: [
        { frame: frame({ ts_device_ms: 100, tip_state: 'down' }) },
        { frame: frame({ ts_device_ms: 140, tip_state: 'up' }) },
      ],
    });
    expect(parseAndValidateRawFrameRecords(wrappedBatch).records).toHaveLength(2);
  });

  it('normalizes raw optical coordinates and groups frames into strokes', () => {
    const frames = [
      frame({ ts_device_ms: 140, tip_state: 'hover', optical: { x_raw: 3000, y_raw: 1600, quality: 0.93 } }),
      frame({ ts_device_ms: 100, tip_state: 'down', optical: { x_raw: 0, y_raw: 0, quality: 0.91 } }),
      frame({ ts_device_ms: 180, tip_state: 'up', optical: { x_raw: 4096, y_raw: 2560, quality: 0.92 } }),
    ];

    expect(pointFromRawFrame(frames[0])?.x_norm).toBeCloseTo(3000 / 4096, 5);
    const groups = groupRawFramesIntoStrokes(frames);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((item) => item.tip_state)).toEqual(['down', 'hover', 'up']);
  });

  it('exposes one validated bridge entrypoint for native, serial, or BLE adapters', () => {
    type CapturedBatch = { frames: RawPenFrame[]; sourceName: string; sourceKind: string };
    const captured: CapturedBatch[] = [];
    const bridge = createRawPenFrameBridge((frames, meta) => {
      captured.push({ frames, sourceName: meta.sourceName, sourceKind: meta.sourceKind });
    });

    const ok = bridge.pushFrames([
      frame({ ts_device_ms: 100, tip_state: 'down' }),
      frame({ ts_device_ms: 140, tip_state: 'up' }),
    ], 'android socket', 'android_native');
    expect(ok).toMatchObject({
      ok: true,
      accepted: 2,
      source_name: 'android socket',
      source_kind: 'android_native',
      issues: [],
    });
    const capturedBatch = captured[0];
    expect(capturedBatch).toBeDefined();
    if (!capturedBatch) throw new Error('bridge callback did not capture frames');
    expect(capturedBatch.frames).toHaveLength(2);
    expect(capturedBatch.sourceKind).toBe('android_native');

    const bad = bridge.pushFrame({ ...frame(), tip_state: 'drag' }, 'bad frame', 'web_bluetooth');
    expect(bad.ok).toBe(false);
    expect(bad.accepted).toBe(0);
    expect(bad.issues.join('\n')).toContain('tip_state');
  });
});
