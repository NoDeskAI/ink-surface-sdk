import { describe, expect, it } from 'vitest';
import type { PersistedMeeting } from '../../core/store-format';
import { appendProgressiveMeetingCard, deleteMeetingRawMedia, fetchMeetingRawMediaLifecycle, meetingPostprocessTemplateLabel, postprocessProjection, requestMeetingPostprocessTemplate, resolveMeetingPostprocessOccurrenceId, submitMeetingPostprocessConfiguration } from './meeting-postprocess-client';

const meeting = { meeting_id: 'm', workspace_id: 'w', title: 'M', scheduled_at: '2026-01-01T00:00:00Z', status: 'ended', material_doc_ids: [], created_at: '', updated_at: '' } as PersistedMeeting;
const cardsContent = (theme = '') => ({
  schema_version: '2.0' as const,
  theme,
  overview: '',
  artifact_state: 'final' as const,
  coverage: {
    utterances: 'complete' as const,
    handwriting_ocr: 'complete' as const,
    started_at_ms: null,
    ended_at_ms: null,
  },
});
describe('postprocessProjection', () => {
  it('projects canonical artifacts', () => {
    const patch = postprocessProjection(meeting, [{ artifact_id: 'a', kind: 'meeting.summary', revision: 1, finality: 'final', status: 'ready', content: '# Summary' }]);
    expect(patch).toMatchObject({ summary: '# Summary', summary_origin: 'postprocess_v2', summary_artifact_id: 'a' });
  });
  it('ignores a legacy full-report artifact', () => {
    const patch = postprocessProjection(meeting, [{ artifact_id: 'r', kind: 'meeting.full_report', revision: 1, finality: 'final', status: 'ready', content: { schema_version: '2.0', status: 'completed', markdown: '# Detail', source_fingerprint: 'f'.repeat(64), prompt_version: 'meeting_full_report_prompt_v2', generated_at: '2026-01-01T00:00:00.000Z' } }]);
    expect(patch).toBeNull();
  });
  it('does not project a full report from an older scene template snapshot', () => {
    const current = { ...meeting, full_report_v2: { artifact_id: 'old', title: 'M', report_markdown: '# Old', finality: 'final' as const } };
    const patch = postprocessProjection(current, [
      { artifact_id: 'cards-new', kind: 'meeting.summary_cards', revision: 2, finality: 'final', status: 'ready', snapshot_fingerprint: 'new', content: cardsContent() },
      { artifact_id: 'report-old', kind: 'meeting.full_report', revision: 1, finality: 'final', status: 'ready', snapshot_fingerprint: 'old', content: { markdown: '# Old' } },
    ]);
    expect(patch).toHaveProperty('full_report_v2', undefined);
  });
  it('does not project artifacts from another occurrence', () => {
    const patch = postprocessProjection({ ...meeting, postprocess_occurrence_id: 'zoom:one' }, [
      { artifact_id: 'other', occurrence_id: 'zoom:two', snapshot_id: 'snapshot-two', kind: 'meeting.summary', revision: 1, finality: 'final', status: 'ready', content: 'Wrong meeting' },
    ], 'zoom:one');
    expect(patch).toBeNull();
  });
  it('keeps all projected artifacts on the same evidence snapshot', () => {
    const patch = postprocessProjection({ ...meeting, summary: 'Old', summary_origin: 'postprocess_v2', mind_map_v1: { schema_version: '1.0', source: 'meeting.summary_cards', source_fingerprint: 'old', nodes: [{ id: 'old', parent_id: null, kind: 'root', label: 'Old', evidence_refs: [] }] } }, [
      { artifact_id: 'cards-new', kind: 'meeting.summary_cards', revision: 2, finality: 'final', status: 'ready', snapshot_fingerprint: 'new', content: cardsContent('New') },
      { artifact_id: 'summary-old', kind: 'meeting.summary', revision: 1, finality: 'final', status: 'ready', snapshot_fingerprint: 'old', content: 'Old summary' },
      { artifact_id: 'mind-old', kind: 'meeting.mind_map', revision: 1, finality: 'final', status: 'ready', snapshot_fingerprint: 'old', content: { schema_version: '1.0', nodes: [] } },
    ]);
    expect(patch).toMatchObject({ summary_cards_v2: { theme: 'New' } });
    expect(patch).toHaveProperty('summary', undefined);
    expect(patch).toHaveProperty('mind_map_v1', undefined);
  });
  it('ignores legacy text-tree mind-map artifacts', () => {
    const patch = postprocessProjection(meeting, [{
      artifact_id: 'mind', kind: 'meeting.mind_map', revision: 1, finality: 'final', status: 'ready',
      content: { schema_version: '1.0', source: 'meeting.summary_cards', source_fingerprint: 'f'.repeat(64), nodes: [{ id: 'root', parent_id: null, kind: 'root', label: 'Meeting', evidence_refs: [] }] },
    }]);
    expect(patch).toBeNull();
  });
  it('ignores malformed structured artifacts instead of persisting untrusted payloads', () => {
    expect(postprocessProjection(meeting, [{
      artifact_id: 'bad-cards',
      kind: 'meeting.summary_cards',
      revision: 1,
      finality: 'final',
      status: 'ready',
      content: { schema_version: '2.0', theme: 42 },
    }])).toBeNull();
    expect(postprocessProjection(meeting, [{
      artifact_id: 'bad-archive',
      kind: 'meeting.interview_archive_html',
      revision: 1,
      finality: 'final',
      status: 'ready',
      content: {
        filename: '../meeting.html',
        html: '<main>unsafe filename</main>',
        generated_at: '2026-01-01T00:00:00.000Z',
      },
    }])).toBeNull();
  });
  it('projects a valid archive even when no summary cards exist', () => {
    const patch = postprocessProjection(meeting, [{
      artifact_id: 'archive',
      occurrence_id: 'local:archive',
      snapshot_id: 'snapshot-archive',
      kind: 'meeting.interview_archive_html',
      revision: 1,
      finality: 'final',
      status: 'ready',
      content: {
        filename: 'meeting.html',
        html: '<main>Interview</main>',
        generated_at: '2026-01-01T00:00:00.000Z',
      },
    }]);
    expect(patch).toMatchObject({
      postprocess_occurrence_id: 'local:archive',
      postprocess_snapshot_id: 'snapshot-archive',
      interview_archive_html: {
        artifact_id: 'archive',
        filename: 'meeting.html',
        html: '<main>Interview</main>',
        finality: 'final',
      },
    });
  });
  it('validates progressive SSE cards before adding them to recap state', () => {
    const current = {
      ...cardsContent('Meeting'),
      key_points: [],
      decisions: [],
      action_items: [],
      highlights: [],
      risks: [],
      open_questions: [],
      personal_notes: [],
      template_id: 'meeting_expert' as const,
      template_version: 'meeting_expert.v2',
      meeting_metadata: {
        started_at: null,
        duration_ms: null,
        participants: [],
      },
    };
    expect(appendProgressiveMeetingCard(current, 'key_points', {
      id: 'kp-1',
      text: 'Validated',
      evidence_refs: ['u1'],
    })?.key_points).toEqual([{
      id: 'kp-1',
      text: 'Validated',
      evidence_refs: ['u1'],
    }]);
    expect(appendProgressiveMeetingCard(current, 'key_points', {
      id: 'kp-2',
      text: '',
      evidence_refs: [],
      injected: true,
    })).toBeNull();
    expect(appendProgressiveMeetingCard(current, 'unknown', {
      id: 'kp-3',
      text: 'Ignored',
      evidence_refs: ['u1'],
    })).toBeNull();
  });
  it('never overwrites a user-edited summary', () => {
    const patch = postprocessProjection({ ...meeting, summary: 'mine', summary_user_edited_at: 'now' }, [{ artifact_id: 'a', kind: 'meeting.summary', revision: 1, finality: 'final', status: 'ready', content: 'AI' }]);
    expect(patch).toBeNull();
  });
  it('exposes scene labels and requests a template-only reprocess', async () => {
    expect(meetingPostprocessTemplateLabel('university_notes')).toBe('大学课堂笔记');
    expect(meetingPostprocessTemplateLabel()).toBe('会议全面总结专家');
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ meeting_id: 'm', occurrence_id: 'zoom:occ', template_id: 'interview_memo' });
      return new Response(JSON.stringify({ status: 'queued', run: { run_id: 'run-template', artifact_kind: 'meeting.summary_cards', status: 'queued', created_at: '2026-01-01T00:00:00.000Z' }, snapshot: { template_id: 'interview_memo', template_version: 'interview_memo.v2' } }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await expect(requestMeetingPostprocessTemplate('m', 'zoom:occ', 'interview_memo')).resolves.toEqual({ status: 'queued', run_id: 'run-template', run_status: 'queued', reused_artifacts: 0, template_id: 'interview_memo', template_version: 'interview_memo.v2' });
    } finally { globalThis.fetch = original; }
  });
  it('accepts a template while the formal transcript is still pending', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'awaiting_transcript',
      reused_artifacts: 0,
      snapshot: {
        template_id: 'meeting_expert',
        template_version: 'meeting_expert.v2',
      },
    }), { status: 202, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      await expect(
        requestMeetingPostprocessTemplate('m', 'zoom:occ', 'meeting_expert'),
      ).resolves.toEqual({
        status: 'awaiting_transcript',
        reused_artifacts: 0,
        template_id: 'meeting_expert',
        template_version: 'meeting_expert.v2',
      });
    } finally {
      globalThis.fetch = original;
    }
  });
  it('does not mark a transcript final merely because provisional cues exist', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ utterances: [{ text: 'partial cue' }] });
      expect(body).not.toHaveProperty('transcript_final');
      return new Response(JSON.stringify({}), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const { enqueueMeetingPostprocess } = await import('./meeting-postprocess-client');
      await enqueueMeetingPostprocess({ ...meeting, provider_transcript_status: 'pending' }, [{ index: 1, startMs: 0, endMs: 1, text: 'partial cue', rawText: 'partial cue' }]);
    } finally { globalThis.fetch = original; }
  });
  it('derives a local occurrence when WebView crypto.subtle is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    try {
      const { resolveMeetingPostprocessOccurrenceId } = await import('./meeting-postprocess-client');
      await expect(resolveMeetingPostprocessOccurrenceId(meeting)).resolves.toMatch(/^local:[a-f0-9]{32}$/);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  });
  it('submits template and user guidance through the configuration gate', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ meeting_id: 'm', occurrence_id: 'zoom:occ', template_id: 'meeting_expert', user_guidance: { conclusions: ['ship'], deepest_impressions: ['focused'], pain_points: ['latency'] } });
      return new Response(JSON.stringify({ status: 'awaiting_transcript', configuration: { template_id: 'meeting_expert', template_version: 'meeting_expert.v2', user_guidance: { conclusions: ['ship'], deepest_impressions: ['focused'], pain_points: ['latency'] } } }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await expect(submitMeetingPostprocessConfiguration({ meeting_id: 'm', occurrence_id: 'zoom:occ', template_id: 'meeting_expert', user_guidance: { conclusions: ['ship'], deepest_impressions: ['focused'], pain_points: ['latency'] } })).resolves.toMatchObject({ status: 'awaiting_transcript' });
    } finally { globalThis.fetch = original; }
  });
  it('mirrors Hub occurrence identity for provider and local meetings', async () => {
    await expect(resolveMeetingPostprocessOccurrenceId({ ...meeting, platform: 'zoom', provider_calendar_event_id: 'event/1' })).resolves.toBe('zoom:event_1');
    await expect(resolveMeetingPostprocessOccurrenceId({ ...meeting, platform: 'manual' })).resolves.toMatch(/^local:[a-f0-9]{32}$/);
  });
  it('resolves a meeting-scoped media session before deleting only its raw audio', async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/session-scope')) {
        expect(init?.method).toBe('GET');
        return new Response(JSON.stringify({ session_id: 'media-session-1', meeting_doc_id: 'mtgdoc_m' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await expect(deleteMeetingRawMedia('m')).resolves.toEqual({ deleted: true, session_id: 'media-session-1' });
      expect(urls[0]).toContain('meeting_doc_id=mtgdoc_m');
      expect(urls[1]).toContain('session_id=media-session-1');
    } finally { globalThis.fetch = original; }
  });
  it('deletes the canonical meeting lifecycle through the distinct whole-meeting endpoint', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toContain('/api/meeting-postprocess/meeting?meeting_id=m');
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({
        command_id: 'meeting_delete_1', replay: false, pending_companion: true, cloud_sessions_deleted: 1,
        deleted: { runs: 1, snapshots: 1, configurations: 1, artifacts: 2, events: 4, chunk_cache: 1, registrations: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const { deleteWholeMeeting } = await import('./meeting-postprocess-client');
      await expect(deleteWholeMeeting('m')).resolves.toMatchObject({ command_id: 'meeting_delete_1', pending_companion: true, cloud_sessions_deleted: 1 });
    } finally { globalThis.fetch = original; }
  });
  it('loads the durable raw-media lifecycle for the meeting-scoped session', async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      urls.push(url);
      expect(init?.method).toBe('GET');
      if (url.includes('/session-scope')) {
        return new Response(JSON.stringify({ session_id: 'media-session-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ lifecycle: { status: 'delete_failed', reason: 'user_requested', updated_at_ms: 123, error: 'disk busy' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await expect(fetchMeetingRawMediaLifecycle('m')).resolves.toEqual({
        session_id: 'media-session-1',
        lifecycle: { status: 'delete_failed', reason: 'user_requested', updated_at_ms: 123, error: 'disk busy' },
      });
      expect(urls[1]).toContain('/raw-media?session_id=media-session-1');
    } finally { globalThis.fetch = original; }
  });
});
