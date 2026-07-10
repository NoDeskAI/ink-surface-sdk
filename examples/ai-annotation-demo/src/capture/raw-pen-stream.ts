import {
  validateRawPenFrame,
  type InkLoopStrokePoint,
  type RawPenFrame,
  type RuntimeSchemaValidationIssue,
} from 'ink-surface-sdk/runtime-schema';

export const RAW_PEN_FRAME_BRIDGE_NAME = 'InkLoopRawPen' as const;

export type RawPenFrameSourceKind =
  | 'file'
  | 'browser_bridge'
  | 'android_native'
  | 'web_serial'
  | 'web_bluetooth'
  | 'simulator';

export interface RawPenFrameBatchMeta {
  sourceName: string;
  sourceKind: RawPenFrameSourceKind;
}

export interface RawPenFrameBridgeResult {
  ok: boolean;
  accepted: number;
  source_name: string;
  source_kind: RawPenFrameSourceKind;
  issues: string[];
}

export interface RawPenFrameBridge {
  pushFrame(payload: unknown, sourceName?: string, sourceKind?: RawPenFrameSourceKind): RawPenFrameBridgeResult;
  pushFrames(payload: unknown, sourceName?: string, sourceKind?: RawPenFrameSourceKind): RawPenFrameBridgeResult;
  pushJsonl(text: string, sourceName?: string, sourceKind?: RawPenFrameSourceKind): RawPenFrameBridgeResult;
}

export interface RawPenSurfaceGeometry {
  widthRaw: number;
  heightRaw: number;
}

const DEFAULT_GEOMETRY: RawPenSurfaceGeometry = {
  widthRaw: 4096,
  heightRaw: 2560,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validatorMessages(issues: readonly RuntimeSchemaValidationIssue[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message}`);
}

export function unwrapRawFrame(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.frame ?? value.raw_pen_frame ?? value;
}

function recordsFromStructuredPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload.map(unwrapRawFrame);
  if (isRecord(payload) && Array.isArray(payload.frames)) return payload.frames.map(unwrapRawFrame);
  return [unwrapRawFrame(payload)];
}

export function parseRawFrameRecords(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const values = JSON.parse(trimmed) as unknown[];
    if (!Array.isArray(values)) throw new Error('Raw frame JSON input must be an array.');
    return values.map(unwrapRawFrame);
  }
  if (trimmed.startsWith('{')) {
    try {
      return recordsFromStructuredPayload(JSON.parse(trimmed));
    } catch (error) {
      if (!trimmed.includes('\n')) throw error;
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((lineText) => lineText.trim())
    .filter((lineText) => lineText && !lineText.startsWith('#'))
    .map((lineText) => unwrapRawFrame(JSON.parse(lineText)));
}

export function validateRawFrameRecords(records: readonly unknown[], path = 'frames'): RuntimeSchemaValidationIssue[] {
  return records.flatMap((record, index) => validateRawPenFrame(record, `${path}.${index + 1}`));
}

export function parseAndValidateRawFrameRecords(text: string, path = 'frames'): {
  records: RawPenFrame[];
  issues: RuntimeSchemaValidationIssue[];
} {
  const records = parseRawFrameRecords(text);
  const issues = validateRawFrameRecords(records, path);
  return {
    records: issues.length > 0 ? [] : records as RawPenFrame[],
    issues,
  };
}

export function pointFromRawFrame(
  frame: RawPenFrame,
  geometry: RawPenSurfaceGeometry = DEFAULT_GEOMETRY,
): InkLoopStrokePoint | null {
  const xRaw = frame.optical?.x_raw;
  const yRaw = frame.optical?.y_raw;
  if (typeof xRaw !== 'number' || typeof yRaw !== 'number') return null;
  return {
    x_norm: Math.max(0, Math.min(1, xRaw / geometry.widthRaw)),
    y_norm: Math.max(0, Math.min(1, yRaw / geometry.heightRaw)),
    t_ms: frame.ts_device_ms,
    pressure: frame.pressure,
    quality: frame.optical?.quality,
  };
}

export function groupRawFramesIntoStrokes(frames: readonly RawPenFrame[]): RawPenFrame[][] {
  const groups: RawPenFrame[][] = [];
  const active = new Map<string, RawPenFrame[]>();
  for (const frame of [...frames].sort((a, b) => a.ts_device_ms - b.ts_device_ms)) {
    if (!pointFromRawFrame(frame)) continue;
    const key = `${frame.session_id}:${frame.pen_id}`;
    const current = active.get(key);
    if (frame.tip_state === 'down') {
      if (current) current.push(frame);
      else active.set(key, [frame]);
    } else if (frame.tip_state === 'hover') {
      if (current) current.push(frame);
    } else if (current) {
      current.push(frame);
      if (current.length >= 2) groups.push(current);
      active.delete(key);
    }
  }
  for (const current of active.values()) {
    if (current.length >= 2) groups.push(current);
  }
  return groups;
}

export function createRawPenFrameBridge(
  onFrames: (frames: RawPenFrame[], meta: RawPenFrameBatchMeta) => void,
): RawPenFrameBridge {
  function pushRecords(
    records: unknown[],
    sourceName: string = RAW_PEN_FRAME_BRIDGE_NAME,
    sourceKind: RawPenFrameSourceKind = 'browser_bridge',
  ): RawPenFrameBridgeResult {
    const issues = validateRawFrameRecords(records, 'bridge.frames');
    if (issues.length > 0) {
      return {
        ok: false,
        accepted: 0,
        source_name: sourceName,
        source_kind: sourceKind,
        issues: validatorMessages(issues).slice(0, 8),
      };
    }
    const frames = records as RawPenFrame[];
    onFrames(frames, { sourceName, sourceKind });
    return {
      ok: true,
      accepted: frames.length,
      source_name: sourceName,
      source_kind: sourceKind,
      issues: [],
    };
  }

  return {
    pushFrame(payload, sourceName, sourceKind) {
      return pushRecords(recordsFromStructuredPayload(payload), sourceName, sourceKind);
    },
    pushFrames(payload, sourceName, sourceKind) {
      if (typeof payload === 'string') {
        return pushRecords(parseRawFrameRecords(payload), sourceName, sourceKind);
      }
      return pushRecords(recordsFromStructuredPayload(payload), sourceName, sourceKind);
    },
    pushJsonl(text, sourceName, sourceKind) {
      return pushRecords(parseRawFrameRecords(text), sourceName, sourceKind);
    },
  };
}
