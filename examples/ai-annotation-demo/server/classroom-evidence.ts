import { createHash } from 'node:crypto';
import type {
  ClassroomBoardEvent,
  ClassroomEvidenceBundle,
  ClassroomEvidenceIntent,
  ClassroomSnapshot,
  ClassroomSpatialRegion,
  ClassroomTimelineEntry,
  ClassroomTranscriptRevision,
  InkLoopSourceRef,
  RuntimeNormBBox,
} from 'ink-surface-sdk/runtime-schema';
import { latestRecognitionRevisions, recognitionRevisionFingerprint } from './classroom-recognition';
import { activeBoardEvents, boxesIntersect, eventBBox, eventRegion, normBoxToWorld, pageGeometry, sameSurface, worldBoxToNorm } from '../shared/classroom/classroom-spatial';

export interface BuildClassroomEvidenceInput {
  snapshot: ClassroomSnapshot;
  timeline?: ClassroomTimelineEntry[];
  intent: ClassroomEvidenceIntent;
  selection_bbox_norm?: RuntimeNormBBox;
  selection_region?: ClassroomSpatialRegion;
  trigger_time_ms?: number;
  time_start_ms?: number;
  time_end_ms?: number;
}

function intersectsBox(a: RuntimeNormBBox, b: RuntimeNormBBox): boolean {
  return a[0] <= b[0] + b[2] && a[0] + a[2] >= b[0] && a[1] <= b[1] + b[3] && a[1] + a[3] >= b[1];
}

function intersectsTime(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

function samePage(event: ClassroomBoardEvent, materialId: string, pageIndex: number): boolean {
  const surface = event.surface;
  if (surface?.kind === 'textbook_page') return surface.material_id === materialId && surface.page_index === pageIndex;
  if (surface?.kind === 'scratch') return surface.linked_material_id === materialId && surface.linked_page_index === pageIndex;
  return false;
}

function latestTranscripts(history: ClassroomTranscriptRevision[]): ClassroomTranscriptRevision[] {
  const latest = new Map<string, ClassroomTranscriptRevision>();
  for (const item of history) {
    const current = latest.get(item.transcript_id);
    if (!current || current.revision < item.revision) latest.set(item.transcript_id, item);
  }
  return [...latest.values()].sort((a, b) => a.relative_start_ms - b.relative_start_ms || a.transcript_id.localeCompare(b.transcript_id));
}

function transcriptAbsoluteRange(item: ClassroomTranscriptRevision, timeline: ClassroomTimelineEntry[]): { start: number; end: number } {
  const recording = timeline.find((entry) => entry.kind === 'recording_state'
    && entry.recording.recording_id === item.recording_id
    && entry.recording.recording_generation === item.recording_generation);
  if (!recording || recording.kind !== 'recording_state') return { start: item.relative_start_ms, end: item.relative_end_ms };
  const origin = Date.parse(recording.recording.started_at);
  if (!Number.isFinite(origin)) return { start: item.relative_start_ms, end: item.relative_end_ms };
  return { start: origin + item.relative_start_ms, end: origin + item.relative_end_ms };
}

export function transcriptRevisionFingerprint(revisions: ClassroomTranscriptRevision[]): string {
  const projection = latestTranscripts(revisions).map((item) => `${item.transcript_id}:${item.revision}:${item.status}`).sort().join('|');
  return `transcript_${createHash('sha256').update(projection).digest('hex').slice(0, 24)}`;
}

function inkRef(event: ClassroomBoardEvent): InkLoopSourceRef {
  return {
    type: 'ink_event', session_id: event.classroom_id, event_id: event.event.event_id,
    ts_start_ms: event.event.ts_start_ms, ts_end_ms: event.event.ts_end_ms,
    ...(event.geometry_version === 'classroom_page_world_v1' ? { spatial_region: eventRegion(event) } : { bbox_norm: event.event.bbox_norm }),
  };
}

function focusBoundaryStart(input: BuildClassroomEvidenceInput, trigger: number, fallback: number): number {
  const timeline = input.timeline ?? [];
  let boundary = fallback;
  for (let index = 0; index < timeline.length; index += 1) {
    if (timeline[index].kind !== 'confirmed_focus') continue;
    const nextBoard = timeline.slice(index + 1).find((entry) => entry.kind === 'board_event_ref');
    if (!nextBoard || nextBoard.kind !== 'board_event_ref') continue;
    const event = input.snapshot.board_events.find((item) => item.sequence === nextBoard.board_sequence);
    if (event && event.event.ts_start_ms <= trigger) boundary = Math.max(boundary, event.event.ts_start_ms);
  }
  return boundary;
}

function selectEvents(input: BuildClassroomEvidenceInput): { events: ClassroomBoardEvent[]; bbox?: RuntimeNormBBox; region?: ClassroomSpatialRegion; start: number; end: number } {
  const all = activeBoardEvents(input.snapshot.board_events);
  if (all.length === 0) throw new Error('insufficient_evidence');
  if (input.intent === 'missed_segment') {
    const trigger = input.trigger_time_ms ?? all.at(-1)!.event.ts_end_ms;
    const requestedStart = input.time_start_ms ?? trigger - 60_000;
    const start = input.time_start_ms ?? focusBoundaryStart(input, trigger, Math.max(0, requestedStart));
    const end = input.time_end_ms ?? trigger;
    if (end < start || end - start > 60_000) throw new Error('evidence_time_range_invalid');
    const events = all.filter((item) => intersectsTime(item.event.ts_start_ms, item.event.ts_end_ms, start, end));
    if (events.length === 0) throw new Error('insufficient_evidence');
    return { events, start, end };
  }
  if (input.intent === 'selected_region') {
    if (!input.selection_bbox_norm && !input.selection_region) throw new Error('selection_bbox_required');
    const view = input.snapshot.teacher_view;
    const material = view ? input.snapshot.materials?.find((item) => item.material_id === view.material_id) : undefined;
    const geometry = view ? pageGeometry(material, view.page_index) : undefined;
    const region = input.selection_region ?? (geometry && view && input.selection_bbox_norm ? {
      coordinate_space: 'classroom_page_world_v1' as const,
      surface: { kind: 'textbook_page' as const, material_id: view.material_id, page_index: view.page_index },
      bbox_world: normBoxToWorld(input.selection_bbox_norm, geometry),
    } : undefined);
    const events = all.filter((item) => {
      if (region) return sameSurface(item.surface, region.surface) && boxesIntersect(eventBBox(item, material), region.bbox_world);
      return (!view || samePage(item, view.material_id, view.page_index)) && item.geometry_version !== 'classroom_page_world_v1' && intersectsBox(item.event.bbox_norm, input.selection_bbox_norm!);
    });
    if (events.length === 0) throw new Error('insufficient_evidence');
    return { events, ...(input.selection_bbox_norm ? { bbox: input.selection_bbox_norm } : {}), ...(region ? { region } : {}), start: events[0].event.ts_start_ms, end: events.at(-1)!.event.ts_end_ms };
  }
  if (input.intent === 'current_step') {
    const focus = input.snapshot.confirmed_focus;
    const material = focus ? input.snapshot.materials?.find((item) => item.material_id === focus.material_id) : undefined;
    let events = focus
      ? all.filter((item) => samePage(item, focus.material_id, focus.page_index) && (focus.spatial_region
        ? boxesIntersect(eventBBox(item, material), focus.spatial_region.bbox_world)
        : item.geometry_version !== 'classroom_page_world_v1' && intersectsBox(item.event.bbox_norm, focus.bbox_norm!)))
      : all.slice(-8);
    if (events.length === 0) events = all.slice(-1);
    return { events, ...(focus?.bbox_norm ? { bbox: focus.bbox_norm } : {}), ...(focus?.spatial_region ? { region: focus.spatial_region } : {}), start: events[0].event.ts_start_ms, end: events.at(-1)!.event.ts_end_ms };
  }
  return { events: all, start: all[0].event.ts_start_ms, end: all.at(-1)!.event.ts_end_ms };
}

export function buildClassroomEvidenceBundle(input: BuildClassroomEvidenceInput): ClassroomEvidenceBundle {
  const selected = selectEvents(input);
  const eventIds = new Set(selected.events.map((item) => item.event.event_id));
  const relevantRecognitions = latestRecognitionRevisions(input.snapshot.recognitions ?? []).filter((item) => item.event_ids.some((id) => eventIds.has(id)));
  const recognitions = relevantRecognitions.filter((item) => item.status === 'confirmed' || item.status === 'corrected');
  const transcriptHistory = latestTranscripts(input.snapshot.transcripts ?? []).filter((item) => {
    const range = transcriptAbsoluteRange(item, input.timeline ?? []);
    return intersectsTime(range.start, range.end, selected.start, selected.end);
  });
  const transcripts = transcriptHistory.filter((item) => item.status === 'final' || item.status === 'corrected');
  const view = input.snapshot.teacher_view;
  const focus = input.snapshot.confirmed_focus;
  const materialId = focus?.material_id ?? view?.material_id;
  const pageIndex = focus?.page_index ?? view?.page_index;
  const materialRecord = materialId ? input.snapshot.materials?.find((item) => item.material_id === materialId) : undefined;
  const geometry = materialRecord && pageIndex !== undefined ? pageGeometry(materialRecord, pageIndex) : undefined;
  const materialBox = selected.bbox ?? (geometry && selected.region ? worldBoxToNorm(selected.region.bbox_world, geometry) : undefined);
  const material = materialRecord && pageIndex !== undefined
    ? { material_id: materialRecord.material_id, title: materialRecord.title, page_index: pageIndex, ...(materialBox ? { bbox_norm: materialBox } : selected.region ? {} : { bbox_norm: [0, 0, 1, 1] as RuntimeNormBBox }) }
    : undefined;
  const sourceRefs: InkLoopSourceRef[] = [
    ...(material ? [{ type: 'material_page' as const, session_id: input.snapshot.classroom_id, material_id: material.material_id, page_index: material.page_index, ...(material.bbox_norm ? { bbox_norm: material.bbox_norm } : {}) }] : []),
    ...selected.events.map(inkRef),
    ...transcripts.map((item): InkLoopSourceRef => ({
      type: 'audio_segment', session_id: input.snapshot.classroom_id, start_ms: item.relative_start_ms,
      end_ms: item.relative_end_ms, speaker: 'teacher', transcript_ref: `${item.transcript_id}:${item.revision}`,
    })),
  ];
  const recognitionFingerprint = recognitionRevisionFingerprint(relevantRecognitions);
  const transcriptFingerprint = transcriptRevisionFingerprint(transcriptHistory);
  const fingerprint = `evidence_${createHash('sha256').update(JSON.stringify({
    classroom_id: input.snapshot.classroom_id, intent: input.intent, sequences: selected.events.map((item) => item.sequence),
    bbox: selected.bbox, region: selected.region, start: selected.start, end: selected.end, material, recognitionFingerprint, transcriptFingerprint,
  })).digest('hex').slice(0, 24)}`;
  const missingSources: ClassroomEvidenceBundle['missing_sources'] = [];
  if (!material) missingSources.push('material');
  if (recognitions.length === 0) missingSources.push('trusted_formula');
  if (transcripts.length === 0) missingSources.push('trusted_transcript');
  const hasPendingFormula = relevantRecognitions.some((item) => (item.kind === 'formula' || item.kind === 'mixed') && !['confirmed', 'corrected', 'dismissed'].includes(item.status));
  const hasProvisionalTranscript = transcriptHistory.some((item) => item.status === 'provisional');
  const trustStatus = hasPendingFormula || hasProvisionalTranscript ? 'needs_confirmation' : missingSources.length ? 'insufficient' : 'trusted';
  return {
    intent: input.intent, classroom_id: input.snapshot.classroom_id, fingerprint, trust_status: trustStatus,
    missing_sources: missingSources, ...(material ? { material } : {}), events: selected.events,
    recognitions, transcripts, source_refs: sourceRefs,
    checkpoint: {
      checkpoint_id: `checkpoint_${fingerprint.slice('evidence_'.length)}`, classroom_id: input.snapshot.classroom_id,
      sequence_start: selected.events[0].sequence, sequence_end: selected.events.at(-1)!.sequence,
      time_start_ms: selected.start, time_end_ms: selected.end, ...(selected.bbox ? { selection_bbox_norm: selected.bbox } : {}),
      ...(selected.region ? { selection_region: selected.region } : {}),
      source_refs: sourceRefs, recognition_revision_fingerprint: recognitionFingerprint,
      transcript_revision_fingerprint: transcriptFingerprint, evidence_revision_fingerprint: fingerprint,
    },
  };
}
