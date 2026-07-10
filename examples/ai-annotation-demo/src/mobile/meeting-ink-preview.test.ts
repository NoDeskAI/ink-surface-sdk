import { describe, expect, it } from 'vitest';
import type { PersistedMark } from '../core/store-format';
import { meetingInkStats, renderMeetingInkPageSvg, renderMeetingInkPreviewSvg } from './meeting-ink-preview';

function mark(strokes: PersistedMark['strokes']): PersistedMark {
  return { strokes } as PersistedMark;
}

describe('meeting ink preview', () => {
  it('renders persisted stroke points as an svg preview', () => {
    const html = renderMeetingInkPreviewSvg(mark([
      { tool: 'pen', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }, { x: 0.4, y: 0.5, t: 16, pressure: 0.5 }] },
    ]));

    expect(html).toContain('<svg');
    expect(html).toContain('<path');
    expect(html).toContain('原始手写笔迹预览');
  });

  it('uses surface points when the mark was captured on a reader surface', () => {
    const html = renderMeetingInkPreviewSvg(mark([
      {
        tool: 'pen',
        points: [{ x: 0.01, y: 0.01, t: 0, pressure: 0.5 }],
        surface_points: [{ x: 100, y: 200, t: 0, pressure: 0.5 }, { x: 140, y: 240, t: 16, pressure: 0.5 }],
      },
    ]));

    expect(html).toContain('<path');
    expect(html).not.toContain('0.01');
  });

  it('reports stroke and point counts from the raw persisted ink', () => {
    const stats = meetingInkStats(mark([
      { tool: 'pen', points: [{ x: 1, y: 1, t: 0, pressure: 0.5 }, { x: 2, y: 2, t: 16, pressure: 0.5 }] },
      { tool: 'pen', points: [{ x: 3, y: 3, t: 0, pressure: 0.5 }] },
    ]));

    expect(stats).toEqual({ strokeCount: 2, pointCount: 3 });
  });

  it('shows an empty state when raw points are missing', () => {
    expect(renderMeetingInkPreviewSvg(mark([]))).toContain('没有可预览的原始笔迹');
  });

  it('renders multiple marks back onto one original note page', () => {
    const html = renderMeetingInkPageSvg({
      documentId: 'mtgboard_demo',
      pageIndex: 0,
      marks: [
        mark([{ tool: 'pen', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }, { x: 0.2, y: 0.2, t: 10, pressure: 0.5 }] }]),
        mark([{ tool: 'pen', points: [{ x: 0.7, y: 0.8, t: 0, pressure: 0.5 }, { x: 0.8, y: 0.8, t: 10, pressure: 0.5 }] }]),
      ],
    });

    expect(html).toContain('会议原始手记整页');
    expect(html).toContain('M100,248.4 L200,248.4');
    expect(html).toContain('M700,993.6 L800,993.6');
  });
});
