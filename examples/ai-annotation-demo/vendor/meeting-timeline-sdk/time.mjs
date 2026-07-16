// Extracted from packages/meeting-timeline-sdk/index.mjs at 475cd6c.
// Keep this file small so the demo does not vendor the SDK package entrypoint.
import { MeetingTimelineSdkError } from './adapters/internal-utils.mjs';

export function normalizeAbsoluteMs(value, fieldName = 'timestamp') {
  if (value == null || value === '') return undefined;
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return ms;
    throw new MeetingTimelineSdkError(`Invalid ${fieldName}: Date is not finite`, { fieldName, value });
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MeetingTimelineSdkError(`Invalid ${fieldName}: number is not finite`, { fieldName, value });
    }
    if (value > 10_000_000_000_000) return Math.round(value / 1000);
    if (value > 10_000_000_000) return Math.round(value);
    if (value > 1_000_000_000) return Math.round(value * 1000);
    throw new MeetingTimelineSdkError(`Invalid ${fieldName}: expected absolute unix time`, { fieldName, value });
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return normalizeAbsoluteMs(numeric, fieldName);
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return parsed;
  throw new MeetingTimelineSdkError(`Invalid ${fieldName}: cannot parse absolute time`, { fieldName, value });
}
