export interface MarkTimeFields {
  abs_timestamp: number;
  pen_down_at?: number;
}

export function markTime(mark: MarkTimeFields): number {
  return mark.pen_down_at ?? mark.abs_timestamp;
}
