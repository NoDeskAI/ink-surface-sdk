// The SDK ships this renderer model as ESM beside a declaration file, but this app's
// TS config does not resolve declarations outside src for relative .mjs imports.
// Keep the escape hatch narrow so pdfjs .mjs typing stays untouched.
// @ts-ignore - local SDK ESM import is verified by vitest and Vite at runtime.
import { buildMeetingPlatformTimelineView as sdkBuildMeetingPlatformTimelineView } from '../../../Lark-Meeting-Timeline-main/packages/meeting-timeline-sdk/adapters/platform-timeline-view.mjs';
import type { PersistedMeeting } from '../../core/store-format';
import type { TranscriptCue } from '../panel-feishu/align';
import { buildSegments, buildSegmentMarks, type RecapSegment, type SegmentMark } from '../panel-feishu/segment';

export interface EpaperSdkTimelineMarker {
  id: string;
  rail: string;
  source: string;
  kind: string;
  label: string;
  time_ms?: number;
  captured_at_ms?: number;
  calibrated: boolean;
  warnings: string[];
  visible: boolean;
  x_ratio?: number;
  raw?: unknown;
}

export interface EpaperSdkTimelineView {
  type: 'meeting_platform_timeline_view';
  schema: 'meeting_platform_timeline_view';
  schema_version: number;
  platform: string;
  status: string;
  meeting: Record<string, unknown>;
  viewport: Record<string, unknown>;
  ticks: Array<{ ms: number; label: string }>;
  rails: Array<Record<string, unknown>>;
  markers: EpaperSdkTimelineMarker[];
  visible_markers: EpaperSdkTimelineMarker[];
  uncalibrated_markers: EpaperSdkTimelineMarker[];
  diagnostics: Record<string, unknown>;
  next_actions: string[];
}

const buildMeetingPlatformTimelineView = sdkBuildMeetingPlatformTimelineView as (
  platform: string,
  input?: Record<string, unknown>,
  options?: Record<string, unknown>,
) => EpaperSdkTimelineView;

export interface EpaperTimelineMarkInput {
  mark_id: string;
  abs_timestamp: number;
  feature_type?: string;
  marked_text?: string;
  page_index?: number;
}

export interface EpaperMeetingTimelineInput {
  meeting: PersistedMeeting;
  cues: TranscriptCue[];
  marks: EpaperTimelineMarkInput[];
  t0AbsMs: number;
  offsetMs: number;
}

export interface EpaperMeetingTimeline {
  segments: RecapSegment[];
  segmentMarks: SegmentMark[];
  sdkView: EpaperSdkTimelineView;
  diagnostics: {
    cueCount: number;
    markCount: number;
    segmentCount: number;
    sdkMarkerCount: number;
    sdkVisibleMarkerCount: number;
    sdkUncalibratedMarkerCount: number;
  };
}

const SDK_RAILS = [
  { id: 'transcript', label: 'Transcript', role: 'post_meeting_transcript', order: 10 },
  { id: 'annotations', label: 'Annotations', role: 'human_marks', order: 20 },
  { id: 'events', label: 'Events', role: 'meeting_and_provider_events', order: 30 },
];

const safeTime = (...values: Array<number | string | null | undefined>): number | undefined => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
};

function meetingPayload(meeting: PersistedMeeting, t0AbsMs: number): Record<string, unknown> {
  const start = safeTime(t0AbsMs, meeting.vc_meeting_start_t0, meeting.feishu_recording_t0, meeting.panel_meeting_start, meeting.started_at, meeting.scheduled_at);
  const end = safeTime(meeting.ended_at);
  return {
    platform: 'lark',
    meeting_id: meeting.feishu_meeting_id || meeting.feishu_meeting_no || meeting.meeting_id,
    external_meeting_id: meeting.feishu_meeting_no || meeting.calendar_meeting_no,
    title: meeting.feishu_topic || meeting.title || '会议',
    minute_token: meeting.feishu_minute_token,
    start_time_ms: start,
    end_time_ms: end,
  };
}

function transcriptPayload(cues: TranscriptCue[]): Array<Record<string, unknown>> {
  return cues.map((cue) => ({
    id: `cue-${cue.index}`,
    start_ms: cue.startMs,
    end_ms: cue.endMs,
    speaker_name: cue.speaker || '未知说话人',
    text: cue.text,
    source: 'lark_minute',
    raw: { index: cue.index, rawText: cue.rawText },
  }));
}

function markLabel(mark: SegmentMark): string {
  const text = mark.marked_text.trim();
  if (text) return text;
  return mark.feature_type === 'drawing' ? '图形标注 / 圈画' : '未识别手写';
}

function annotationPayload(marks: SegmentMark[], rawById: Map<string, EpaperTimelineMarkInput>): Array<Record<string, unknown>> {
  return marks.map((mark) => {
    const raw = rawById.get(mark.mark_id);
    return {
      id: mark.mark_id,
      time_ms: mark.relMs,
      captured_at_ms: raw?.abs_timestamp,
      kind: mark.feature_type || 'handwriting',
      label: markLabel(mark),
      source: 'hanwang_epaper',
      payload: {
        mark_id: mark.mark_id,
        page_index: mark.page_index,
        feature_type: mark.feature_type,
        marked_text: mark.marked_text,
      },
    };
  });
}

function fullDurationMs(cues: TranscriptCue[], marks: SegmentMark[]): number {
  const cueMax = cues.reduce((max, cue) => Math.max(max, cue.endMs), 0);
  const markMax = marks.reduce((max, mark) => Math.max(max, mark.relMs), 0);
  return Math.max(10 * 60_000, cueMax, markMax + 30_000);
}

function markerId(marker: EpaperSdkTimelineMarker): string {
  return String(marker.id || '');
}

function annotationMarkers(view: EpaperSdkTimelineView): Map<string, EpaperSdkTimelineMarker> {
  const out = new Map<string, EpaperSdkTimelineMarker>();
  for (const marker of view.markers) {
    if (marker.rail !== 'annotations') continue;
    out.set(markerId(marker), marker);
  }
  return out;
}

function marksFromSdkView(segmentMarks: SegmentMark[], view: EpaperSdkTimelineView): SegmentMark[] {
  const markers = annotationMarkers(view);
  return segmentMarks.map((mark) => {
    const sdkMarker = markers.get(mark.mark_id);
    if (!sdkMarker || !Number.isFinite(sdkMarker.time_ms)) return mark;
    return { ...mark, relMs: Math.round(Number(sdkMarker.time_ms)) };
  }).sort((a, b) => a.relMs - b.relMs);
}

export function buildEpaperMeetingTimeline(input: EpaperMeetingTimelineInput): EpaperMeetingTimeline {
  const rawById = new Map(input.marks.map((mark) => [mark.mark_id, mark] as const));
  const localSegmentMarks = buildSegmentMarks(input.marks, input.t0AbsMs, input.offsetMs);
  const transcript = transcriptPayload(input.cues);
  const annotations = annotationPayload(localSegmentMarks, rawById);
  const sdkView = buildMeetingPlatformTimelineView('lark', {
    meeting: meetingPayload(input.meeting, input.t0AbsMs),
    transcript_segments: transcript,
    marks: annotations,
  }, {
    rails: SDK_RAILS,
    fullDurationMs: fullDurationMs(input.cues, localSegmentMarks),
  });
  const segmentMarks = marksFromSdkView(localSegmentMarks, sdkView);
  const segments = buildSegments({ cues: input.cues, marks: segmentMarks });
  return {
    segments,
    segmentMarks,
    sdkView,
    diagnostics: {
      cueCount: input.cues.length,
      markCount: segmentMarks.length,
      segmentCount: segments.length,
      sdkMarkerCount: sdkView.diagnostics.marker_count as number,
      sdkVisibleMarkerCount: sdkView.diagnostics.visible_marker_count as number,
      sdkUncalibratedMarkerCount: sdkView.diagnostics.uncalibrated_marker_count as number,
    },
  };
}
