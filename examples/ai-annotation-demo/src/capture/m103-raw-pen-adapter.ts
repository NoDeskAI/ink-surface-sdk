import {
  INKLOOP_AI_PEN_CONTRACT_VERSION,
  type RawPenFrame,
} from 'ink-surface-sdk/runtime-schema';
import {
  RAW_PEN_FRAME_BRIDGE_NAME,
  validateRawFrameRecords,
  validatorMessages,
  type RawPenFrameBridge,
} from './raw-pen-stream';
import type { HqSocketStroke } from './m103-hqhw-socket';
import type { M103PhysicalPenStroke } from './m103-input-source';

export const M103_RAW_PEN_CAPTURE_BRIDGE_NAME = 'InkLoopM103RawPenCapture' as const;

export interface M103RawPenSurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface M103RawPenAdapterOptions {
  penId: string;
  sessionId: string;
  surfaceId: string;
  firmwareVersion: string;
  surfaceRect: M103RawPenSurfaceRect;
  rawWidth?: number;
  rawHeight?: number;
  hostTimeOffsetMs?: number;
}

export interface M103RawPenCaptureBridge {
  getLastBatch(): RawPenFrame[];
  getAllFrames(): RawPenFrame[];
  getSummary(): M103RawPenCaptureSummary;
  exportJsonl(): string;
  exportAllJsonl(): string;
  clear(): void;
}

export interface M103RawPenCaptureSummary {
  batch_count: number;
  frame_count: number;
  last_batch_count: number;
  first_ts_device_ms?: number;
  last_ts_device_ms?: number;
  last_received_at_ms?: number;
}

export interface M103RawPenPublishResult {
  ok: boolean;
  frame_count: number;
  source: M103RawPenSource;
  issues: string[];
}

export type M103RawPenSource =
  | 'm103_hqunifiedsocket'
  | 'm103_motion_event'
  | 'onyx_touch_helper'
  | 'onyx_motion_event';

const DEFAULT_RAW_WIDTH = 4096;
const DEFAULT_RAW_HEIGHT = 2560;
const MAX_CAPTURED_BATCHES = 64;
const MAX_CAPTURED_FRAMES = 10_000;
const lastBatch: RawPenFrame[] = [];
const capturedFrames: RawPenFrame[] = [];
const capturedBatches: RawPenFrame[][] = [];
let lastReceivedAtMs: number | undefined;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function tipStateFor(index: number, count: number): RawPenFrame['tip_state'] {
  return index === count - 1 ? 'up' : 'down';
}

function toRawCoordinate(value: number, origin: number, size: number, rawSize: number): number {
  if (size <= 0) return 0;
  return Math.round(clamp((value - origin) / size) * rawSize);
}

export function m103SocketStrokeToRawPenFrames(
  stroke: Pick<HqSocketStroke | M103PhysicalPenStroke, 'seq' | 'points'>,
  options: M103RawPenAdapterOptions,
  source: M103RawPenSource = 'm103_hqunifiedsocket',
): RawPenFrame[] {
  const rawWidth = options.rawWidth ?? DEFAULT_RAW_WIDTH;
  const rawHeight = options.rawHeight ?? DEFAULT_RAW_HEIGHT;
  const offset = options.hostTimeOffsetMs ?? 12;
  return stroke.points.map((point, index) => ({
    schema_version: INKLOOP_AI_PEN_CONTRACT_VERSION,
    pen_id: options.penId,
    session_id: options.sessionId,
    surface_id: options.surfaceId,
    ts_device_ms: point.t,
    ts_host_ms: point.t + offset,
    tip_state: tipStateFor(index, stroke.points.length),
    pressure: clamp(point.pressure),
    optical: {
      x_raw: toRawCoordinate(point.x, options.surfaceRect.left, options.surfaceRect.width, rawWidth),
      y_raw: toRawCoordinate(point.y, options.surfaceRect.top, options.surfaceRect.height, rawHeight),
      pattern_id: `${source}_${stroke.seq}`,
      quality: 0.92,
    },
    firmware_version: options.firmwareVersion,
  }));
}

export function framesToJsonl(frames: readonly RawPenFrame[]): string {
  return frames.map((frame) => JSON.stringify(frame)).join('\n');
}

function captureSummary(): M103RawPenCaptureSummary {
  return {
    batch_count: capturedBatches.length,
    frame_count: capturedFrames.length,
    last_batch_count: lastBatch.length,
    first_ts_device_ms: capturedFrames[0]?.ts_device_ms,
    last_ts_device_ms: capturedFrames[capturedFrames.length - 1]?.ts_device_ms,
    last_received_at_ms: lastReceivedAtMs,
  };
}

function appendCaptureBatch(frames: RawPenFrame[]): void {
  lastBatch.splice(0, lastBatch.length, ...frames);
  capturedBatches.push([...frames]);
  capturedFrames.push(...frames);
  while (capturedBatches.length > MAX_CAPTURED_BATCHES) capturedBatches.shift();
  if (capturedFrames.length > MAX_CAPTURED_FRAMES) {
    capturedFrames.splice(0, capturedFrames.length - MAX_CAPTURED_FRAMES);
  }
  lastReceivedAtMs = Date.now();
}

export function installM103RawPenCaptureBridge(): M103RawPenCaptureBridge | null {
  if (typeof window === 'undefined') return null;
  const host = window as unknown as Partial<Record<typeof M103_RAW_PEN_CAPTURE_BRIDGE_NAME, M103RawPenCaptureBridge>>;
  const existing = host[M103_RAW_PEN_CAPTURE_BRIDGE_NAME] as Partial<M103RawPenCaptureBridge> | undefined;
  if (
    typeof existing?.getAllFrames === 'function'
    && typeof existing.getSummary === 'function'
    && typeof existing.exportAllJsonl === 'function'
  ) {
    return existing as M103RawPenCaptureBridge;
  }
  const bridge: M103RawPenCaptureBridge = {
    getLastBatch: () => [...lastBatch],
    getAllFrames: () => [...capturedFrames],
    getSummary: () => captureSummary(),
    exportJsonl: () => framesToJsonl(lastBatch),
    exportAllJsonl: () => framesToJsonl(capturedFrames),
    clear: () => {
      lastBatch.splice(0, lastBatch.length);
      capturedFrames.splice(0, capturedFrames.length);
      capturedBatches.splice(0, capturedBatches.length);
      lastReceivedAtMs = undefined;
    },
  };
  host[M103_RAW_PEN_CAPTURE_BRIDGE_NAME] = bridge;
  return bridge;
}

export function publishM103RawPenStroke(
  stroke: Pick<HqSocketStroke | M103PhysicalPenStroke, 'seq' | 'points'>,
  options: M103RawPenAdapterOptions,
  source: M103RawPenSource = 'm103_hqunifiedsocket',
): M103RawPenPublishResult {
  const frames = m103SocketStrokeToRawPenFrames(stroke, options, source);
  const issues = validateRawFrameRecords(frames, 'm103.frames');
  if (issues.length > 0) {
    return {
      ok: false,
      frame_count: 0,
      source,
      issues: validatorMessages(issues),
    };
  }

  appendCaptureBatch(frames);
  installM103RawPenCaptureBridge();

  if (typeof window !== 'undefined') {
    const host = window as unknown as Partial<Record<typeof RAW_PEN_FRAME_BRIDGE_NAME, RawPenFrameBridge>>;
    const sourceName = source === 'm103_hqunifiedsocket'
      ? 'M103 hqunifiedsocket'
      : source === 'onyx_touch_helper'
        ? 'ONYX TouchHelper'
        : source === 'onyx_motion_event'
          ? 'ONYX MotionEvent'
          : 'M103 MotionEvent';
    host[RAW_PEN_FRAME_BRIDGE_NAME]?.pushFrames(frames, sourceName, 'android_native');
    window.dispatchEvent(new CustomEvent('inkloop:m103-raw-pen-frames', {
      detail: {
        source,
        frame_count: frames.length,
        bridge: RAW_PEN_FRAME_BRIDGE_NAME,
        capture: captureSummary(),
      },
    }));
  }

  return {
    ok: true,
    frame_count: frames.length,
    source,
    issues: [],
  };
}
