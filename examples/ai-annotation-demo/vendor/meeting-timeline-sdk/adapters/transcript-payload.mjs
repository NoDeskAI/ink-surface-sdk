// Dependency extracted from packages/meeting-timeline-sdk/index.mjs at 475cd6c.
// transcript.mjs uses this builder; keeping it here avoids vendoring the full entrypoint.
import { compactObject } from './internal-utils.mjs';
import { normalizeAbsoluteMs } from '../time.mjs';

function firstNonEmpty(...values) {
  return values.find((value) => value != null && value !== '');
}

function normalizeIsoTime(value) {
  const ms = value == null ? undefined : normalizeAbsoluteMs(value);
  return ms == null ? undefined : new Date(ms).toISOString();
}

function buildTranscriptMeetingPayload(input = {}, defaults = {}) {
  const startTime = firstNonEmpty(input.start_time, input.startTime, input.started_at, input.startedAt);
  const startTimeMs = firstNonEmpty(input.start_time_ms, input.startTimeMs, input.started_at_ms, input.startedAtMs);
  const endTime = firstNonEmpty(input.end_time, input.endTime, input.ended_at, input.endedAt);
  const endTimeMs = firstNonEmpty(input.end_time_ms, input.endTimeMs, input.ended_at_ms, input.endedAtMs);
  return compactObject({
    platform: input.platform ?? defaults.platform,
    meeting_id: firstNonEmpty(input.meeting_id, input.meetingId, input.id, defaults.meeting_id, defaults.meetingId),
    external_meeting_id: firstNonEmpty(input.external_meeting_id, input.externalMeetingId, input.externalId),
    meeting_url: firstNonEmpty(input.meeting_url, input.meetingUrl, input.url, input.join_url, input.joinUrl),
    minute_token: firstNonEmpty(input.minute_token, input.minuteToken),
    title: firstNonEmpty(input.title, input.topic, input.name),
    timezone: input.timezone ?? defaults.timezone,
    start_time: startTime != null ? normalizeIsoTime(startTime) : normalizeIsoTime(startTimeMs),
    end_time: endTime != null ? normalizeIsoTime(endTime) : normalizeIsoTime(endTimeMs),
    source: input.source ?? defaults.source,
  });
}

function buildTranscriptSegment(input = {}, index = 0, defaults = {}) {
  return compactObject({
    id: firstNonEmpty(input.id, input.segment_id, input.segmentId, input.sentence_id, input.sentenceId, `seg-${index + 1}`),
    start_ms: firstNonEmpty(input.start_ms, input.startMs, input.start_time_ms, input.startTimeMs, input.offset_ms, input.offsetMs),
    end_ms: firstNonEmpty(input.end_ms, input.endMs, input.end_time_ms, input.endTimeMs),
    start_time: firstNonEmpty(input.start_time, input.startTime, input.start, input.ts),
    end_time: firstNonEmpty(input.end_time, input.endTime, input.end),
    speaker_id: firstNonEmpty(input.speaker_id, input.speakerId, input.participant_id, input.participantId, input.user_id, input.userId),
    speaker_name: firstNonEmpty(input.speaker_name, input.speakerName, input.participant_name, input.participantName, input.user_name, input.userName, input.name),
    text: firstNonEmpty(input.text, input.content, input.sentence, input.transcript),
    language: firstNonEmpty(input.language, input.language_code, input.languageCode),
    source: input.source ?? defaults.source ?? 'transcript_import',
    raw: input.raw,
  });
}

export function buildTranscriptImportPayload(input = {}, defaults = {}) {
  const meetingInput = input.meeting ?? input.meetingSession ?? input.session ?? {};
  const rows = firstNonEmpty(input.transcript, input.segments, input.entries, input.items, []);
  const transcript = Array.isArray(rows)
    ? rows.map((item, index) => buildTranscriptSegment(item, index, {
      source: input.source ?? defaults.source,
    }))
    : rows;
  return compactObject({
    meeting: buildTranscriptMeetingPayload(meetingInput, {
      platform: input.platform ?? defaults.platform,
      source: input.source ?? defaults.source,
      meeting_id: input.meeting_id ?? input.meetingId,
    }),
    transcript,
    artifact: input.artifact,
    source: input.source ?? defaults.source,
  });
}
