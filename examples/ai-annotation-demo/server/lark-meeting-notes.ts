import { resolveUserOAuthToken } from './lark-oauth-state';
import { createLarkClient } from '../Lark-Meeting-Timeline-main/src/larkClient.mjs';
import { parseFeishuTranscriptSpeakerMarker, type FeishuTranscriptSpeakerSource } from '../src/integration/panel-feishu/transcript-speaker-marker';

const DEFAULT_FEISHU_BASE_URL = 'https://open.feishu.cn';
const REQUIRED_USER_SCOPES = ['vc:note:read', 'docx:document:readonly'];
const MEDIA_DOWNLOAD_SCOPES = ['docs:document.media:download', 'drive:drive:readonly', 'drive:file:download'];

export interface LarkMeetingNotesEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  FEISHU_BASE_URL?: string;
  LARK_BASE_URL?: string;
  LARK_MEETING_AUTH_STATE_PATH?: string;
}

interface MinimalLarkClient {
  isConfigured?: boolean;
  fetchMeetingDetail?: (meetingId: string) => Promise<unknown>;
  fetchMeetingDetailWithToken?: (meetingId: string, token: string) => Promise<unknown>;
}

export interface FeishuDocxTranscriptSegment {
  index: number;
  speaker: string;
  speaker_source: FeishuTranscriptSpeakerSource;
  speaker_device_owner?: string;
  start_ms: number;
  end_ms: number;
  text: string;
}

interface LarkMeetingNoteArtifact {
  artifact_type?: number;
  document_id: string;
  title?: string;
  revision_id?: number;
  content_length?: number;
  segment_count?: number;
  speaker_count?: number;
}

export interface FeishuDocxImageResource {
  index: number;
  file_token: string;
}

export interface LarkMeetingNoteTranscriptResult {
  connected: boolean;
  configured: boolean;
  source: 'lark_meeting_note_transcript';
  status: 'ready' | 'not_configured' | 'oauth_unavailable' | 'missing_scope' | 'meeting_not_found' | 'missing_note' | 'missing_transcript' | 'failed';
  meeting_id: string;
  meeting?: {
    id: string;
    topic?: string;
    meeting_no?: string;
    start_time?: string;
    end_time?: string;
    note_id?: string;
  };
  note?: {
    note_id: string;
    artifact_count: number;
  };
  artifacts: LarkMeetingNoteArtifact[];
  transcript?: {
    source: 'feishu_note_docx';
    minute_token: string;
    document_id: string;
    title?: string;
    srt: string;
    cue_count: number;
    speaker_count: number;
    parser_version: 2;
    raw_content: string;
    segments: FeishuDocxTranscriptSegment[];
    content_length: number;
    fetched_at: string;
  };
  summary?: {
    source: 'feishu_note_docx';
    document_id: string;
    title?: string;
    content: string;
    content_length: number;
    fetched_at: string;
    images?: FeishuDocxImageResource[];
  };
  errors: Array<{ source: string; code: string; message: string; required_scope?: string; permission_url?: string }>;
}

export interface LarkDocxMediaDownloadResult {
  ok: boolean;
  status: number;
  content_type?: string;
  filename?: string;
  body?: Buffer;
  error?: { code: string; message: string; required_scope?: string; permission_url?: string };
}

interface AppConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
}

function appConfig(env: LarkMeetingNotesEnv): AppConfig | null {
  const appId = String(env.LARK_APP_ID || env.FEISHU_APP_ID || '').trim();
  const appSecret = String(env.LARK_APP_SECRET || env.FEISHU_APP_SECRET || '').trim();
  const baseUrl = String(env.LARK_BASE_URL || env.FEISHU_BASE_URL || DEFAULT_FEISHU_BASE_URL).trim().replace(/\/+$/, '');
  if (!appId || !appSecret) return null;
  return { appId, appSecret, baseUrl: baseUrl || DEFAULT_FEISHU_BASE_URL };
}

function permissionUrl(appId: string, scopes: string[]): string {
  return `https://open.feishu.cn/app/${appId}/auth?q=${encodeURIComponent(scopes.join(','))}&op_from=openapi&token_type=user`;
}

function hasScopes(actual: string[], required: string[]): boolean {
  const set = new Set(actual);
  return required.every((scope) => set.has(scope));
}

function hasAnyScope(actual: string[], required: string[]): boolean {
  const set = new Set(actual);
  return required.some((scope) => set.has(scope));
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function feishuMsg(json: Record<string, unknown>): string {
  return String(json.msg || json.message || json.error || json.code || 'unknown Feishu error');
}

function dataOf(json: Record<string, unknown>): Record<string, unknown> {
  return obj(json.data || {});
}

async function requestJson(baseUrl: string, token: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
  });
  const raw = await res.text();
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { return { code: res.status, raw }; }
}

async function requestBinary(baseUrl: string, token: string, path: string): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

function normalizeMeeting(raw: unknown): LarkMeetingNoteTranscriptResult['meeting'] {
  const data = dataOf(obj(raw));
  const meeting = obj(data.meeting || data);
  const id = text(meeting.id);
  if (!id) return undefined;
  return {
    id,
    ...(text(meeting.topic) ? { topic: text(meeting.topic) } : {}),
    ...(text(meeting.meeting_no) ? { meeting_no: text(meeting.meeting_no) } : {}),
    ...(text(meeting.start_time) ? { start_time: text(meeting.start_time) } : {}),
    ...(text(meeting.end_time) ? { end_time: text(meeting.end_time) } : {}),
    ...(text(meeting.note_id) ? { note_id: text(meeting.note_id) } : {}),
  };
}

function normalizeArtifacts(raw: unknown): LarkMeetingNoteArtifact[] {
  const data = dataOf(obj(raw));
  const source = obj(data.note || data);
  return arr(source.artifacts || source.artifact_list || data.artifacts)
    .map((artifact) => ({
      artifact_type: num(artifact.artifact_type),
      document_id: String(artifact.document_id || artifact.doc_token || artifact.token || '').trim(),
      ...(text(artifact.title) ? { title: text(artifact.title) } : {}),
      ...(num(artifact.revision_id) !== undefined ? { revision_id: num(artifact.revision_id) } : {}),
    }))
    .filter((artifact) => artifact.document_id);
}

function normalizeRawContent(raw: unknown): string {
  const data = dataOf(obj(raw));
  return String(data.content || data.raw_content || data.text || obj(raw).content || obj(raw).raw_content || '');
}

function extractImageToken(block: Record<string, unknown>): string | undefined {
  const image = obj(block.image);
  return text(image.token)
    || text(image.file_token)
    || text(image.image_token)
    || text(image.resource_token)
    || text(block.image_token)
    || text(block.file_token)
    || text(block.token);
}

function normalizeImageBlocks(raw: unknown): FeishuDocxImageResource[] {
  const data = dataOf(obj(raw));
  return arr(data.items || data.blocks || obj(raw).items)
    .map((block) => extractImageToken(block))
    .filter((token): token is string => !!token)
    .map((file_token, index) => ({ index, file_token }));
}

async function fetchDocxImageResources(baseUrl: string, token: string, documentId: string): Promise<FeishuDocxImageResource[]> {
  const images: FeishuDocxImageResource[] = [];
  let pageToken = '';
  for (let guard = 0; guard < 20; guard++) {
    const qs = new URLSearchParams({ page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const raw = await requestJson(baseUrl, token, `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${qs.toString()}`);
    if (raw.code !== 0) break;
    images.push(...normalizeImageBlocks(raw).map((image) => ({ ...image, index: images.length + image.index })));
    const data = dataOf(raw);
    pageToken = text(data.page_token) || text(data.next_page_token) || '';
    if (!pageToken || data.has_more === false) break;
  }
  return images;
}

function compactTranscriptText(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseFeishuDocxTranscriptContent(content: string): FeishuDocxTranscriptSegment[] {
  const lines = String(content || '').split(/\r?\n/);
  const segments: Array<Omit<FeishuDocxTranscriptSegment, 'index' | 'end_ms'>> = [];
  let current: {
    speaker: string;
    speaker_source: FeishuTranscriptSpeakerSource;
    speaker_device_owner?: string;
    start_ms: number;
    textLines: string[];
  } | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const marker = parseFeishuTranscriptSpeakerMarker(line);
    if (marker) {
      if (current) {
        const textValue = compactTranscriptText(current.textLines);
        if (textValue) {
          const { textLines: _textLines, ...segment } = current;
          segments.push({ ...segment, text: textValue });
        }
      }
      current = {
        speaker: marker.speaker,
        speaker_source: marker.source,
        ...(marker.deviceOwner ? { speaker_device_owner: marker.deviceOwner } : {}),
        start_ms: marker.startMs,
        textLines: [],
      };
      continue;
    }
    if (current && line) current.textLines.push(line);
  }
  if (current) {
    const textValue = compactTranscriptText(current.textLines);
    if (textValue) {
      const { textLines: _textLines, ...segment } = current;
      segments.push({ ...segment, text: textValue });
    }
  }
  return segments.map((segment, index) => ({
    ...segment,
    index,
    end_ms: segments[index + 1]?.start_ms ?? segment.start_ms + Math.max(1000, Math.min(15_000, Math.ceil(segment.text.length / 18) * 1000)),
  }));
}

function formatSrtTime(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  const h = Math.floor(safe / 3_600_000);
  const m = Math.floor((safe % 3_600_000) / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  const n = safe % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(n).padStart(3, '0')}`;
}

export function feishuDocxSegmentsToSrt(segments: FeishuDocxTranscriptSegment[]): string {
  return segments.map((segment, i) => [
    String(i + 1),
    `${formatSrtTime(segment.start_ms)} --> ${formatSrtTime(Math.max(segment.start_ms + 1, segment.end_ms))}`,
    `${segment.speaker}：${segment.text}`,
  ].join('\n')).join('\n\n');
}

function speakerCount(segments: FeishuDocxTranscriptSegment[]): number {
  return new Set(segments.map((segment) => segment.speaker).filter(Boolean)).size;
}

function chooseTranscriptArtifact(artifacts: Array<LarkMeetingNoteArtifact & { content?: string; segments?: FeishuDocxTranscriptSegment[] }>): LarkMeetingNoteArtifact & { content: string; segments: FeishuDocxTranscriptSegment[] } | null {
  const candidates = artifacts
    .map((artifact) => ({
      ...artifact,
      content: artifact.content || '',
      segments: artifact.segments || [],
    }))
    .filter((artifact) => artifact.content.trim() && artifact.segments.length);
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const typeScoreA = a.artifact_type === 2 ? 1 : 0;
    const typeScoreB = b.artifact_type === 2 ? 1 : 0;
    if (typeScoreA !== typeScoreB) return typeScoreB - typeScoreA;
    return b.segments.length - a.segments.length;
  });
  return candidates[0];
}

function chooseSummaryArtifact(artifacts: Array<LarkMeetingNoteArtifact & { content?: string }>): LarkMeetingNoteArtifact & { content: string } | null {
  const candidates = artifacts
    .map((artifact) => ({ ...artifact, content: artifact.content || '' }))
    .filter((artifact) => artifact.content.trim());
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const score = (artifact: LarkMeetingNoteArtifact & { content: string }): number => {
      const title = artifact.title || '';
      if (artifact.artifact_type === 1) return 3;
      if (/智能纪要|纪要|summary/i.test(title)) return 2;
      if (artifact.artifact_type === 2) return 0;
      return 1;
    };
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sb - sa;
    return b.content.length - a.content.length;
  });
  const picked = candidates[0];
  return picked ? { ...picked, content: picked.content.trim() } : null;
}

export async function fetchLarkDocxMedia(documentId: string, fileToken: string, options: {
  nowMs?: number;
  env?: LarkMeetingNotesEnv;
  createClient?: (env: Record<string, unknown>) => MinimalLarkClient;
} = {}): Promise<LarkDocxMediaDownloadResult> {
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env || process.env;
  const config = appConfig(env);
  if (!config) {
    return { ok: false, status: 503, error: { code: 'not_configured', message: 'FEISHU_APP_ID/FEISHU_APP_SECRET or LARK_APP_ID/LARK_APP_SECRET is not configured' } };
  }
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(documentId) || !/^[A-Za-z0-9_-]{6,200}$/.test(fileToken)) {
    return { ok: false, status: 400, error: { code: 'bad_request', message: 'invalid document_id or file_token' } };
  }
  const userOAuth = await resolveUserOAuthToken(env, nowMs, { createClient: options.createClient });
  if (!userOAuth.usable || !userOAuth.token) {
    return {
      ok: false,
      status: 401,
      error: {
        code: userOAuth.reason || 'oauth_unavailable',
        message: '未检测到可用飞书用户 OAuth token；登录后才能读取飞书纪要图片。',
        required_scope: MEDIA_DOWNLOAD_SCOPES[0],
        permission_url: permissionUrl(config.appId, MEDIA_DOWNLOAD_SCOPES),
      },
    };
  }
  if (!hasAnyScope(userOAuth.scopes, MEDIA_DOWNLOAD_SCOPES)) {
    return {
      ok: false,
      status: 403,
      error: {
        code: 'missing_oauth_scope',
        message: '当前飞书 OAuth token 缺少云文档媒体下载权限。',
        required_scope: MEDIA_DOWNLOAD_SCOPES.join(','),
        permission_url: permissionUrl(config.appId, MEDIA_DOWNLOAD_SCOPES),
      },
    };
  }
  const r = await requestBinary(config.baseUrl, userOAuth.token, `/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`);
  const contentType = r.headers.get('content-type') || 'application/octet-stream';
  if (!r.status.toString().startsWith('2') || /application\/json/i.test(contentType)) {
    let message = `Feishu media download HTTP ${r.status}`;
    let code = `http_${r.status}`;
    try {
      const json = JSON.parse(r.body.toString('utf8')) as Record<string, unknown>;
      message = feishuMsg(json);
      code = String(json.code || code);
    } catch { /* binary-ish error body */ }
    return { ok: false, status: r.status, error: { code, message, required_scope: MEDIA_DOWNLOAD_SCOPES.join(','), permission_url: permissionUrl(config.appId, MEDIA_DOWNLOAD_SCOPES) } };
  }
  return {
    ok: true,
    status: r.status,
    content_type: contentType,
    filename: r.headers.get('content-disposition') || undefined,
    body: r.body,
  };
}

export async function fetchLarkMeetingNoteTranscript(meetingId: string, options: {
  nowMs?: number;
  env?: LarkMeetingNotesEnv;
  createClient?: (env: Record<string, unknown>) => MinimalLarkClient;
} = {}): Promise<LarkMeetingNoteTranscriptResult> {
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env || process.env;
  const errors: LarkMeetingNoteTranscriptResult['errors'] = [];
  const config = appConfig(env);
  if (!config) {
    return { connected: false, configured: false, source: 'lark_meeting_note_transcript', status: 'not_configured', meeting_id: meetingId, artifacts: [], errors: [{ source: 'config', code: 'not_configured', message: 'FEISHU_APP_ID/FEISHU_APP_SECRET or LARK_APP_ID/LARK_APP_SECRET is not configured' }] };
  }

  const userOAuth = await resolveUserOAuthToken(env, nowMs, { createClient: options.createClient });
  if (!userOAuth.usable || !userOAuth.token) {
    const expiredWithoutRefresh = userOAuth.reason === 'oauth_token_expired' && !userOAuth.refreshTokenPresent;
    const refreshFailed = userOAuth.reason === 'oauth_refresh_failed';
    return {
      connected: false,
      configured: true,
      source: 'lark_meeting_note_transcript',
      status: 'oauth_unavailable',
      meeting_id: meetingId,
      artifacts: [],
      errors: [{
        source: 'lark_oauth',
        code: userOAuth.reason || 'oauth_unavailable',
        message: expiredWithoutRefresh
          ? '飞书用户 OAuth token 已过期，且本地没有 refresh_token；需要重新登录一次，之后才能自动续期。'
          : refreshFailed
            ? `飞书用户 OAuth token 自动续期失败：${userOAuth.refreshError || 'unknown'}`
            : '未检测到可用飞书用户 OAuth token；登录后才能读取会议纪要和文字记录。',
        required_scope: REQUIRED_USER_SCOPES.join(','),
        permission_url: permissionUrl(config.appId, REQUIRED_USER_SCOPES),
      }],
    };
  }
  if (!hasScopes(userOAuth.scopes, REQUIRED_USER_SCOPES)) {
    return {
      connected: false,
      configured: true,
      source: 'lark_meeting_note_transcript',
      status: 'missing_scope',
      meeting_id: meetingId,
      artifacts: [],
      errors: [{
        source: 'lark_oauth',
        code: 'missing_oauth_scope',
        message: '当前飞书 OAuth token 缺少会议纪要或云文档只读权限。',
        required_scope: REQUIRED_USER_SCOPES.join(','),
        permission_url: permissionUrl(config.appId, REQUIRED_USER_SCOPES),
      }],
    };
  }

  const client = (options.createClient || createLarkClient)({
    ...process.env,
    ...env,
    LARK_APP_ID: config.appId,
    LARK_APP_SECRET: config.appSecret,
    LARK_BASE_URL: config.baseUrl,
  }) as MinimalLarkClient;

  let meeting: LarkMeetingNoteTranscriptResult['meeting'];
  try {
    let raw: unknown;
    if (client.fetchMeetingDetail) {
      try {
        raw = await client.fetchMeetingDetail(meetingId);
      } catch (tenantError) {
        if (!client.fetchMeetingDetailWithToken) throw tenantError;
        raw = await client.fetchMeetingDetailWithToken(meetingId, userOAuth.token);
      }
    } else {
      raw = await client.fetchMeetingDetailWithToken?.(meetingId, userOAuth.token);
    }
    meeting = normalizeMeeting(raw);
  } catch (e) {
    return { connected: false, configured: true, source: 'lark_meeting_note_transcript', status: 'meeting_not_found', meeting_id: meetingId, artifacts: [], errors: [{ source: 'vc_meeting', code: 'meeting_detail_failed', message: String((e as Error)?.message || e), required_scope: 'vc:meeting.meetingid:read', permission_url: permissionUrl(config.appId, ['vc:meeting.meetingid:read']) }] };
  }
  if (!meeting) return { connected: false, configured: true, source: 'lark_meeting_note_transcript', status: 'meeting_not_found', meeting_id: meetingId, artifacts: [], errors: [{ source: 'vc_meeting', code: 'meeting_not_found', message: '飞书会议详情为空或缺少会议 id。' }] };
  if (!meeting.note_id) return { connected: true, configured: true, source: 'lark_meeting_note_transcript', status: 'missing_note', meeting_id: meetingId, meeting, artifacts: [], errors: [{ source: 'vc_note', code: 'missing_note_id', message: '这场会议还没有生成飞书智能纪要/文字记录。' }] };

  const noteRaw = await requestJson(config.baseUrl, userOAuth.token, `/open-apis/vc/v1/notes/${encodeURIComponent(meeting.note_id)}`);
  if (noteRaw.code !== 0) {
    return {
      connected: true,
      configured: true,
      source: 'lark_meeting_note_transcript',
      status: 'failed',
      meeting_id: meetingId,
      meeting,
      artifacts: [],
      errors: [{ source: 'vc_note', code: 'note_fetch_failed', message: feishuMsg(noteRaw), required_scope: 'vc:note:read', permission_url: permissionUrl(config.appId, ['vc:note:read']) }],
    };
  }

  const artifacts = normalizeArtifacts(noteRaw);
  const enriched: Array<LarkMeetingNoteArtifact & { content?: string; segments?: FeishuDocxTranscriptSegment[] }> = [];
  for (const artifact of artifacts) {
    const raw = await requestJson(config.baseUrl, userOAuth.token, `/open-apis/docx/v1/documents/${encodeURIComponent(artifact.document_id)}/raw_content`);
    if (raw.code !== undefined && raw.code !== 0) {
      errors.push({
        source: 'docx',
        code: String(raw.code || 'raw_content_failed'),
        message: feishuMsg(raw),
        required_scope: 'docx:document:readonly',
        permission_url: permissionUrl(config.appId, ['docx:document:readonly']),
      });
      enriched.push({
        ...artifact,
        content_length: 0,
        segment_count: 0,
        speaker_count: 0,
      });
      continue;
    }
    const content = normalizeRawContent(raw);
    const segments = parseFeishuDocxTranscriptContent(content);
    enriched.push({
      ...artifact,
      content_length: content.length,
      segment_count: segments.length,
      speaker_count: speakerCount(segments),
      content,
      segments,
    });
  }

  const summaryArtifact = chooseSummaryArtifact(enriched);
  const fetchedAt = new Date(nowMs).toISOString();
  const summaryImages = summaryArtifact ? await fetchDocxImageResources(config.baseUrl, userOAuth.token, summaryArtifact.document_id).catch(() => []) : [];
  const summary = summaryArtifact ? {
    source: 'feishu_note_docx' as const,
    document_id: summaryArtifact.document_id,
    ...(summaryArtifact.title ? { title: summaryArtifact.title } : {}),
    content: summaryArtifact.content,
    content_length: summaryArtifact.content.length,
    fetched_at: fetchedAt,
    ...(summaryImages.length ? { images: summaryImages } : {}),
  } : undefined;

  const chosen = chooseTranscriptArtifact(enriched);
  if (!chosen) {
    return {
      connected: true,
      configured: true,
      source: 'lark_meeting_note_transcript',
      status: errors.length ? 'failed' : 'missing_transcript',
      meeting_id: meetingId,
      meeting,
      note: { note_id: meeting.note_id, artifact_count: artifacts.length },
      artifacts: enriched.map(({ content: _content, segments: _segments, ...artifact }) => artifact),
      ...(summary ? { summary } : {}),
      errors: errors.length
        ? errors
        : [{ source: 'docx', code: 'transcript_artifact_missing', message: '飞书纪要已生成，但没有可解析的文字记录 docx。' }],
    };
  }

  const srt = feishuDocxSegmentsToSrt(chosen.segments);
  return {
    connected: true,
    configured: true,
    source: 'lark_meeting_note_transcript',
    status: 'ready',
    meeting_id: meetingId,
    meeting,
    note: { note_id: meeting.note_id, artifact_count: artifacts.length },
    artifacts: enriched.map(({ content: _content, segments: _segments, ...artifact }) => artifact),
    transcript: {
      source: 'feishu_note_docx',
      minute_token: `feishu_note_docx:${meetingId}:${chosen.document_id}`,
      document_id: chosen.document_id,
      ...(chosen.title ? { title: chosen.title } : {}),
      srt,
      cue_count: chosen.segments.length,
      speaker_count: speakerCount(chosen.segments),
      parser_version: 2,
      raw_content: chosen.content,
      segments: chosen.segments,
      content_length: chosen.content.length,
      fetched_at: fetchedAt,
    },
    ...(summary ? { summary } : {}),
    errors,
  };
}
