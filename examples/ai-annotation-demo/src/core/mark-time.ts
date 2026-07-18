export interface MarkTimeFields {
  abs_timestamp: number;
  pen_down_at?: number;
}

const MIN_EPOCH_MS = 946_684_800_000;
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export function isEpochMs(value: unknown, nowMs = Date.now()): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= MIN_EPOCH_MS
    && value <= nowMs + MAX_CLOCK_SKEW_MS;
}

export function markTime(mark: MarkTimeFields): number {
  if (isEpochMs(mark.pen_down_at)) return mark.pen_down_at;
  return isEpochMs(mark.abs_timestamp) ? mark.abs_timestamp : 0;
}
