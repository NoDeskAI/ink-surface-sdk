export interface MeetingTimelineClient {
  importTranscript?(input?: TranscriptImportInput, options?: Record<string, unknown>): Promise<unknown>;
  importMeetingTranscript?(input?: TranscriptImportInput, options?: Record<string, unknown>): Promise<unknown>;
}

export interface TranscriptSegmentInput {
  id?: string;
  segment_id?: string;
  segmentId?: string;
  sentence_id?: string;
  sentenceId?: string;
  start_ms?: number | string;
  startMs?: number | string;
  start_time_ms?: number | string | Date;
  startTimeMs?: number | string | Date;
  start_time?: number | string | Date;
  startTime?: number | string | Date;
  start?: number | string | Date;
  end_ms?: number | string;
  endMs?: number | string;
  end_time_ms?: number | string | Date;
  endTimeMs?: number | string | Date;
  end_time?: number | string | Date;
  endTime?: number | string | Date;
  end?: number | string | Date;
  speaker_id?: string;
  speakerId?: string;
  speaker_name?: string;
  speakerName?: string;
  participant_id?: string;
  participantId?: string;
  participant_name?: string;
  participantName?: string;
  user_id?: string;
  userId?: string;
  user_name?: string;
  userName?: string;
  text?: string;
  content?: string;
  sentence?: string;
  transcript?: string;
  language?: string;
  language_code?: string;
  languageCode?: string;
  source?: string;
  raw?: unknown;
  [key: string]: unknown;
}

export interface TranscriptImportInput {
  meeting?: Record<string, unknown>;
  meetingSession?: Record<string, unknown>;
  session?: Record<string, unknown>;
  meeting_id?: string;
  meetingId?: string;
  platform?: string;
  source?: string;
  transcript?: TranscriptSegmentInput[];
  segments?: TranscriptSegmentInput[];
  entries?: TranscriptSegmentInput[];
  items?: TranscriptSegmentInput[];
  artifact?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TranscriptNormalizeOptions {
  source?: string;
  language?: string;
  language_code?: string;
  platform?: string;
  meeting?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseTimedTextTranscript(raw?: string, options?: TranscriptNormalizeOptions): TranscriptSegmentInput[];
export function normalizeGoogleMeetTranscriptEntries(raw?: unknown, options?: TranscriptNormalizeOptions): TranscriptSegmentInput[];
export function normalizeMicrosoftTeamsTranscript(raw?: unknown, options?: TranscriptNormalizeOptions): TranscriptSegmentInput[];
export function normalizeZoomTranscript(raw?: unknown, options?: TranscriptNormalizeOptions): TranscriptSegmentInput[];
export function normalizeWebexTranscript(raw?: unknown, options?: TranscriptNormalizeOptions): TranscriptSegmentInput[];
export function buildPlatformTranscriptImportPayload(input?: TranscriptImportInput & {
  raw?: unknown;
  content?: unknown;
  platform?: string;
}): Record<string, unknown>;

export function importPlatformTranscript(
  client: MeetingTimelineClient,
  input?: TranscriptImportInput & {
    raw?: unknown;
    content?: unknown;
    platform?: string;
  },
  options?: {
    raw?: boolean;
    path?: string;
    platform?: string;
    source?: string;
    [key: string]: unknown;
  },
): Promise<{
  platform?: string;
  meeting_id?: string;
  segment_count?: number;
  payload: Record<string, unknown>;
  response: unknown;
}>;
