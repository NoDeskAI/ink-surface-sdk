export interface TimedStrokePoint {
  t: number;
}

/** Native drain strokes have no DOM pointerdown, so reconstruct it from their relative point clock. */
export function estimatePenDownAt(points: readonly TimedStrokePoint[], nowMs = Date.now()): number {
  const durationMs = points.reduce((max, point) => Number.isFinite(point.t) ? Math.max(max, point.t) : max, 0);
  return nowMs - durationMs;
}

export function earliestPenDownAt(strokes: ReadonlyArray<{ penDownAt?: number }>): number | undefined {
  let earliest: number | undefined;
  for (const stroke of strokes) {
    const value = stroke.penDownAt;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    earliest = earliest === undefined ? value : Math.min(earliest, value);
  }
  return earliest;
}
