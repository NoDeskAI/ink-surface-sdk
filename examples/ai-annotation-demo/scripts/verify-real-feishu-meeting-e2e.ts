import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assembleMeetingL1Export, type MeetingExportInput } from '../src/integration/inksurface/meeting-export';
import { parseSrtTranscript } from '../src/integration/panel-feishu/align';
import {
  postProcessContextFromLarkTimeline,
  type LarkTimelineAnnotationIngest,
  type LarkTimelineMeetingSessionStart,
} from '../src/integration/lark-meeting-timeline/adapter';
import type { PersistedMeeting } from '../src/core/store-format';
import { renderVaultMarkdown } from '../../../packages/adapter-obsidian/src/index';
import {
  buildKnowledgeObjectFromPostProcessResult,
  validateMeetingPostProcessSourceRefs,
  type DocumentProjection,
  type DocumentSchemaRef,
  type KnowledgeObject,
  type PostProcessResult,
  type ProjectMemoryRef,
} from '../../../packages/knowledge-schema/src/index';

interface CloudAiTurnRecord {
  schema_version: 'inkloop.cloud_hub.ai_turn.v1';
  ai_turn_id: string;
  document_id: string;
  mark_ids?: string[];
  prompt_md: string;
  response_md: string;
  status: 'accepted' | 'edited' | 'dismissed' | 'inbox';
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

interface LarkMeetingNoteTranscript {
  status: 'ready' | 'not_configured' | 'oauth_unavailable' | 'missing_scope' | 'meeting_not_found' | 'missing_note' | 'missing_transcript' | 'failed';
  meeting?: {
    id?: string;
    topic?: string;
    meeting_no?: string;
    start_time?: string;
    end_time?: string;
    note_id?: string;
  };
  transcript?: {
    srt: string;
    cue_count: number;
    speaker_count: number;
    content_length: number;
    fetched_at: string;
  };
  summary?: {
    title?: string;
    content: string;
    content_length: number;
    fetched_at: string;
  };
  errors?: Array<{ code?: string; message?: string; required_scope?: string; permission_url?: string }>;
}

interface MeetingSourceItem {
  title?: string;
  status?: string;
  scheduled_at?: string;
  started_at?: string;
  ended_at?: string;
  meeting_no?: string;
  meeting_url?: string;
  feishu_meeting_id?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

const startedAt = Date.now();
const root = resolve(new URL('..', import.meta.url).pathname);
const cloudHubBase = (process.env.INKLOOP_CLOUD_HUB_BASE || 'http://127.0.0.1:8731').replace(/\/+$/, '');
let tenantId = process.env.INKLOOP_TENANT_ID || 'local';
let userId = process.env.INKLOOP_USER_ID || 'local_demo';
let deviceId = process.env.INKLOOP_DEVICE_ID || 'meeting-real-feishu-e2e';
const localAuthStore = resolve(process.env.INKLOOP_LOCAL_AUTH_STORE || join(root, '.inkloop/auth-sessions.json'));
const vaultRoot = resolve(process.env.INKLOOP_ACTIVE_OBSIDIAN_VAULT || join(process.env.HOME || '', 'Desktop/InkLoop-Obsidian-Test-Vault'));
const testResultPath = resolve(process.env.INKLOOP_REAL_MEETING_E2E_RESULT || join(root, 'test-results/meeting-real-feishu-e2e.json'));
let localKnowledgeIndexPath = resolve(process.env.INKLOOP_KNOWLEDGE_INDEX || join(root, '.inkloop/knowledge', tenantId, userId, 'index.json'));
const feishuMeetingId = process.env.INKLOOP_REAL_FEISHU_MEETING_ID || '7659677460199738340';
const expectedTitle = process.env.INKLOOP_REAL_FEISHU_MEETING_TITLE || '出海创新周会';
const expectedMeetingNo = process.env.INKLOOP_REAL_FEISHU_MEETING_NO || '473388422';
const generatedAt = new Date().toISOString();

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) fail(`${options.method || 'GET'} ${url} HTTP ${response.status}: ${text}`);
  return body as T;
}

interface DiscoveredSession {
  token: string;
  tenant_id?: string;
  user_id?: string;
  device_id?: string;
  feishu_open_id?: string | null;
}

async function discoverLocalSession(): Promise<DiscoveredSession | null> {
  if (process.env.INKLOOP_SESSION_TOKEN || process.env.INKLOOP_DEVICE_SESSION_TOKEN) {
    return {
      token: process.env.INKLOOP_SESSION_TOKEN || process.env.INKLOOP_DEVICE_SESSION_TOKEN || '',
      tenant_id: tenantId,
      user_id: userId,
      device_id: deviceId,
    };
  }
  try {
    const parsed = JSON.parse(await readFile(localAuthStore, 'utf8')) as {
      sessions?: Record<string, { tenant_id?: string; user_id?: string; device_id?: string; expires_at?: number; updated_at?: number; created_at?: number; feishu_open_id?: string | null }>;
    };
    const explicitUser = !!process.env.INKLOOP_USER_ID;
    const sessions = Object.entries(parsed.sessions || {})
      .filter(([, session]) => session.tenant_id === tenantId && Number(session.expires_at || 0) > Date.now())
      .filter(([, session]) => !explicitUser || session.user_id === userId)
      .sort(([, left], [, right]) => {
        const leftFeishu = left.feishu_open_id ? 1 : 0;
        const rightFeishu = right.feishu_open_id ? 1 : 0;
        return (rightFeishu - leftFeishu) || (Number(right.updated_at || right.created_at || 0) - Number(left.updated_at || left.created_at || 0));
      });
    const hit = sessions[0];
    return hit ? { token: String(hit[0]), ...hit[1] } : null;
  } catch {
    return null;
  }
}

function cloudHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const sessionToken = process.env.INKLOOP_SESSION_TOKEN || process.env.INKLOOP_DEVICE_SESSION_TOKEN || '';
  return {
    'x-inkloop-tenant-id': tenantId,
    'x-inkloop-user-id': userId,
    'x-inkloop-device-id': deviceId,
    ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    ...extra,
  };
}

async function cloudFetchJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  return fetchJson<T>(`${cloudHubBase}${path}`, {
    ...options,
    headers: {
      ...cloudHeaders(),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
}

function epochMs(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resultTypeFromLabel(label: string): PostProcessResult['result_type'] {
  if (/^(任务|待办|action|todo)/i.test(label)) return 'task';
  if (/^(决策|决定|decision)/i.test(label)) return 'decision';
  if (/^(风险|risk)/i.test(label)) return 'risk';
  if (/^(问题|疑问|question|q)/i.test(label)) return 'question';
  return 'knowledge_note';
}

function markIdsFromSourceRefs(refs: readonly PostProcessResult['source_refs'][number][]): string[] {
  return refs
    .filter((ref): ref is Extract<PostProcessResult['source_refs'][number], { ref_type: 'meeting_mark' }> => ref.ref_type === 'meeting_mark')
    .map((ref) => ref.meeting_mark_id);
}

function aiTurnStatusFromPostProcess(status: PostProcessResult['status']): CloudAiTurnRecord['status'] {
  if (status === 'accepted' || status === 'edited' || status === 'dismissed') return status;
  return 'inbox';
}

function stripFrontmatter(markdown: string): string {
  const text = String(markdown || '');
  if (!text.startsWith('---\n')) return text.trim();
  const end = text.indexOf('\n---', 4);
  return end < 0 ? text.trim() : text.slice(end + '\n---'.length).trim();
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const text = String(markdown || '');
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^"|"$/g, '');
  }
  return out;
}

function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripLinkedNotesSection(markdown: string): string {
  return String(markdown || '').replace(/\n## 笔记\n[\s\S]*$/u, '').trimEnd();
}

function canonicalMeetingHubPath(path: string): string {
  const parts = path.split('/');
  if (parts.length >= 4 && parts[0] === 'InkLoop' && parts[1] === 'Meetings') {
    const title = parts[2].replace(/^\d{4}-\d{2}-\d{2}\s+/, '');
    return ['InkLoop', 'Meetings', title, ...parts.slice(3)].join('/');
  }
  return path;
}

function collapseMeetingProjectionFiles(files: Array<{ path: string; markdown: string }>): Array<{ path: string; markdown: string }> {
  const meetingFiles = files.filter((file) => file.path.startsWith('InkLoop/Meetings/'));
  const hub = meetingFiles.find((file) => parseFrontmatter(file.markdown).inkloop_projection_role === 'source_file_unit') ?? meetingFiles[0];
  if (!hub) return [];
  const knowledgeNotes = meetingFiles.filter((file) => file.path !== hub.path);
  const sections = knowledgeNotes.map((file) => {
    const front = parseFrontmatter(file.markdown);
    const body = stripFrontmatter(file.markdown)
      .replace(/^# .+\n+/u, '')
      .replace(/\n## Controlled Fields/g, '\n#### Controlled Fields')
      .trim();
    return [
      `<!-- inkloop:begin-ko document_id="${escapeHtml(front.inkloop_document_id || '')}" document_uri="${escapeHtml(front.inkloop_document_uri || '')}" ko_id="${escapeHtml(front.inkloop_knowledge_object_id || '')}" kind="${escapeHtml(front.inkloop_knowledge_kind || '')}" -->`,
      body,
      '<!-- inkloop:end-ko -->',
    ].filter(Boolean).join('\n\n');
  });
  const markdown = [
    stripLinkedNotesSection(hub.markdown).replace(/\n## 文档\n/u, '\n## 原始文字记录\n'),
    sections.length ? '## 笔记' : '',
    sections.join('\n\n---\n\n'),
  ].filter(Boolean).join('\n\n').trimEnd();
  return [{ path: canonicalMeetingHubPath(hub.path), markdown: `${markdown}\n` }];
}

function insertAfterSourceFile(markdown: string, addition: string): string {
  const marker = '\n## 原始文字记录\n';
  const idx = markdown.indexOf(marker);
  if (idx >= 0) return `${markdown.slice(0, idx)}\n${addition.trim()}\n${markdown.slice(idx)}`;
  return `${markdown.trimEnd()}\n\n${addition.trim()}\n`;
}

function postProcessSection(results: PostProcessResult[]): string {
  const label = (type: PostProcessResult['result_type']): string => {
    if (type === 'task') return '任务';
    if (type === 'decision') return '决策';
    if (type === 'risk') return '风险';
    if (type === 'question') return '问题';
    return '知识';
  };
  return [
    '## 后处理结果',
    ...results.map((result) => `- **${label(result.result_type)}** ${result.title}`),
  ].join('\n');
}

function handwritingSection(items: Array<{ id: string; label: string; offsetMs: number }>): string {
  const min = (ms: number): string => `${Math.round(ms / 60_000)}min`;
  return [
    '## InkLoop 手写记录（模拟）',
    '这部分模拟当场电子纸手写锚点，用来验证右侧手写稿和后处理链路；真实手写接入后会由 Runtime Sync 写入同一类 mark。',
    ...items.map((item) => `- ${min(item.offsetMs)} · ${item.label} (${item.id})`),
  ].join('\n');
}

function enhanceMeetingMarkdown(
  markdown: string,
  note: LarkMeetingNoteTranscript,
  markInputs: Array<{ id: string; label: string; offsetMs: number }>,
  results: PostProcessResult[],
): string {
  const summary = note.summary?.content.trim()
    ? ['## 飞书智能纪要', note.summary.content.trim()].join('\n\n')
    : '## 飞书智能纪要\n\n飞书智能纪要暂未返回。';
  return insertAfterSourceFile(markdown, [
    summary,
    handwritingSection(markInputs),
    postProcessSection(results),
  ].join('\n\n'));
}

async function writeRenderedFiles(rootDir: string, files: Array<{ path: string; markdown: string }>): Promise<string[]> {
  const written: string[] = [];
  for (const file of files) {
    const target = join(rootDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.markdown, 'utf8');
    written.push(target);
  }
  return written;
}

async function pruneOtherLocalMeetingKnowledge(keepDocumentId: string): Promise<{
  ai_turns_removed: number;
  knowledge_objects_removed: number;
  document_projections_removed: number;
}> {
  if (process.env.INKLOOP_PRUNE_OTHER_MEETING_DOCS === '0') {
    return { ai_turns_removed: 0, knowledge_objects_removed: 0, document_projections_removed: 0 };
  }
  try {
    const parsed = JSON.parse(await readFile(localKnowledgeIndexPath, 'utf8')) as {
      ai_turns?: Array<{ document_id?: string }>;
      knowledge_objects?: Array<{ source?: { document_id?: string }; document_id?: string }>;
      document_projections?: Array<{ document_id?: string }>;
      updated_at?: string;
      [key: string]: unknown;
    };
    const isOldMeetingDoc = (documentId: string | undefined): boolean => !!documentId && documentId.startsWith('mtgdoc_') && documentId !== keepDocumentId;
    const aiTurns = parsed.ai_turns ?? [];
    const objects = parsed.knowledge_objects ?? [];
    const projections = parsed.document_projections ?? [];
    const next = {
      ...parsed,
      updated_at: new Date().toISOString(),
      ai_turns: aiTurns.filter((item) => !isOldMeetingDoc(item.document_id)),
      knowledge_objects: objects.filter((item) => !isOldMeetingDoc(item.source?.document_id || item.document_id)),
      document_projections: projections.filter((item) => !isOldMeetingDoc(item.document_id)),
    };
    const removed = {
      ai_turns_removed: aiTurns.length - next.ai_turns.length,
      knowledge_objects_removed: objects.length - next.knowledge_objects.length,
      document_projections_removed: projections.length - next.document_projections.length,
    };
    if (removed.ai_turns_removed || removed.knowledge_objects_removed || removed.document_projections_removed) {
      await writeFile(localKnowledgeIndexPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    }
    return removed;
  } catch {
    return { ai_turns_removed: 0, knowledge_objects_removed: 0, document_projections_removed: 0 };
  }
}

async function findMeetingSource(): Promise<MeetingSourceItem | null> {
  try {
    const result = await cloudFetchJson<{ sources?: MeetingSourceItem[]; meetings?: MeetingSourceItem[] }>(
      '/api/feishu-svc/api/feishu/meeting-sources?lookback_days=30&lookahead_days=14&page_size=10',
    );
    const items = [...(result.sources ?? []), ...(result.meetings ?? [])];
    return items.find((item) => item.feishu_meeting_id === feishuMeetingId)
      ?? items.find((item) => item.meeting_no === expectedMeetingNo)
      ?? items.find((item) => String(item.title || '').includes(expectedTitle))
      ?? null;
  } catch {
    return null;
  }
}

function requiredString(value: string | undefined, fallback: string): string {
  const text = String(value || '').trim();
  return text || fallback;
}

const discoveredSession = await discoverLocalSession();
if (discoveredSession?.token && !process.env.INKLOOP_SESSION_TOKEN && !process.env.INKLOOP_DEVICE_SESSION_TOKEN) {
  process.env.INKLOOP_SESSION_TOKEN = discoveredSession.token;
  tenantId = discoveredSession.tenant_id || tenantId;
  userId = discoveredSession.user_id || userId;
  deviceId = discoveredSession.device_id || deviceId;
  if (!process.env.INKLOOP_KNOWLEDGE_INDEX) {
    localKnowledgeIndexPath = resolve(join(root, '.inkloop/knowledge', tenantId, userId, 'index.json'));
  }
}
if (!process.env.INKLOOP_SESSION_TOKEN && !process.env.INKLOOP_DEVICE_SESSION_TOKEN) {
  fail(`No active InkLoop device session found in ${localAuthStore}`);
}

const [meetingSource, note] = await Promise.all([
  findMeetingSource(),
  cloudFetchJson<LarkMeetingNoteTranscript>(`/api/feishu-svc/api/feishu/meetings/${encodeURIComponent(feishuMeetingId)}/note-transcript`),
]);
if (note.status !== 'ready' || !note.transcript?.srt.trim()) {
  fail(`Feishu note transcript is not ready: ${note.status} ${JSON.stringify(note.errors || [])}`);
}
if (!note.summary?.content.trim()) fail('Feishu smart minutes summary is missing');

const cues = parseSrtTranscript(note.transcript.srt);
if (cues.length < 50) fail(`expected a real transcript, got only ${cues.length} cues`);
const speakerCount = new Set(cues.map((cue) => cue.speaker || '').filter(Boolean)).size;
if (speakerCount < 3) fail(`expected multiple speakers, got ${speakerCount}`);

const startMs = epochMs(note.meeting?.start_time) || Date.parse(meetingSource?.started_at || meetingSource?.scheduled_at || '');
const endMs = epochMs(note.meeting?.end_time) || Date.parse(meetingSource?.ended_at || '');
if (!Number.isFinite(startMs) || startMs <= 0) fail('missing meeting start time');
const meetingId = `mtg_feishu_${feishuMeetingId}`;
const documentTitle = requiredString(note.meeting?.topic || meetingSource?.title, expectedTitle);
const meeting: PersistedMeeting = {
  meeting_id: meetingId,
  workspace_id: 'ws_real_feishu',
  title: documentTitle,
  scheduled_at: new Date(startMs).toISOString(),
  status: 'ended',
  started_at: new Date(startMs).toISOString(),
  ...(Number.isFinite(endMs) && endMs > startMs ? { ended_at: new Date(endMs).toISOString() } : {}),
  material_doc_ids: [],
  summary: `飞书智能纪要\n\n${note.summary.content.trim()}`,
  created_at: new Date(startMs).toISOString(),
  updated_at: generatedAt,
  feishu_meeting_id: feishuMeetingId,
  feishu_meeting_no: note.meeting?.meeting_no || expectedMeetingNo,
  feishu_topic: documentTitle,
  vc_meeting_start_t0: startMs,
  panel_meeting_start: startMs,
  t0_source: 'vc_event',
  align_state: 'event',
  align_offset_ms: 0,
  feishu_note_summary: {
    source: 'feishu_note_docx',
    document_id: 'feishu_smart_minutes',
    title: note.summary.title || '飞书智能纪要',
    content: note.summary.content,
    content_length: note.summary.content_length,
    fetched_at: note.summary.fetched_at,
  },
  feishu_note_summary_status: 'ready',
};

const markInputs = [
  { id: 'real_feishu_action_demo', offsetMs: 12 * 60_000, label: '任务：确认出海创新周会的资料归属和会议资料导入路径' },
  { id: 'real_feishu_decision_demo', offsetMs: 31 * 60_000, label: '决策：会后页采用飞书原始文字记录、飞书智能纪要、InkLoop 手写记录三层分开展示' },
  { id: 'real_feishu_risk_demo', offsetMs: 54 * 60_000, label: '风险：会议手写锚点如果不持久化到 Cloud Hub，Obsidian 输出会和电子纸不一致' },
  { id: 'real_feishu_question_demo', offsetMs: 78 * 60_000, label: '问题：群归属是否可以由日历来源和会议资料自动推断' },
];
const marks: MeetingExportInput['marks'] = markInputs.map((item, index) => ({
  mark_id: item.id,
  entry_id: `entry_${item.id}`,
  abs_timestamp: startMs + item.offsetMs,
  feature_type: 'handwriting',
  marked_text: item.label,
  page_index: 0,
  strokes: [{
    tool: 'pen',
    color: '#1A1A1A',
    points: [
      { x: 0.10 + index * 0.02, y: 0.22, t: 0, pressure: 0.45 },
      { x: 0.18 + index * 0.02, y: 0.27, t: 90, pressure: 0.52 },
      { x: 0.29 + index * 0.02, y: 0.24, t: 180, pressure: 0.5 },
    ],
  }],
  color: '#1A1A1A',
}));

const exportResult = await assembleMeetingL1Export({ meeting, cues, marks }, { generatedAt });
const pruned = await pruneOtherLocalMeetingKnowledge(exportResult.documentId);
const projection = exportResult.documentProjections.document_projections[0];
if (!projection) fail('meeting export did not produce a document projection');
const eventKinds = exportResult.knowledgeExport.objects.map((object) => object.kind);
for (const expected of ['meeting_action', 'meeting_decision', 'meeting_risk', 'qa'] as const) {
  if (!eventKinds.includes(expected)) fail(`missing meeting event KnowledgeObject: ${expected}`);
}

const sdkSessionInput: LarkTimelineMeetingSessionStart = {
  platform: 'feishu',
  meeting_id: feishuMeetingId,
  title: documentTitle,
  meeting_url: meetingSource?.meeting_url,
  start_time_ms: startMs,
  detector_source: 'lark_meeting_note_transcript',
};
const projectMemoryRef: ProjectMemoryRef = {
  ref_type: 'project_memory',
  memory_id: 'mem_inkloop_v1_meeting_loop',
  kind: 'milestone',
  title: 'InkLoop V1 meeting loop: Feishu note -> Paper handwriting -> Cloud Hub -> Obsidian',
};
const annotationPayloads: LarkTimelineAnnotationIngest[] = markInputs.map((item) => ({
  id: item.id,
  source: 'inkloop_epaper_simulated',
  captured_at_ms: startMs + item.offsetMs,
  kind: 'handwriting_trigger',
  label: item.label,
  text: item.label,
  device_id: 'paper-meeting-sim',
  mark: { action: 'freehand', target_text: item.label },
}));
const adapterBundle = postProcessContextFromLarkTimeline({
  session: sdkSessionInput,
  annotations: annotationPayloads,
  documentRefForAnnotation: (annotation, mark, index): DocumentSchemaRef => ({
    ref_type: 'document',
    document_id: exportResult.documentId,
    page_id: `pg_${meetingId}_0`,
    page_index: 0,
    event_id: annotation.id,
    trace_id: mark.trace_id,
    bbox: [0.08, Math.min(0.9, 0.12 + index * 0.12), 0.78, 0.08],
    object_refs: [String(annotation.id || mark.id)],
    quote: annotation.label,
    confidence: 0.9,
  }),
  projectMemoryRefs: [projectMemoryRef],
  userFeedback: 'accepted',
  createdAt: generatedAt,
});
if (adapterBundle.alignedEvents.some((event) => event.alignment_status !== 'aligned' || event.schema_refs.length === 0)) {
  fail(`meeting schema alignment failed: ${JSON.stringify(adapterBundle.alignedEvents)}`);
}

const labelById = new Map(markInputs.map((item) => [item.id, item.label] as const));
const postProcessResults: PostProcessResult[] = adapterBundle.alignedEvents.map((event) => {
  const label = labelById.get(event.meeting_mark_id) || String(event.payload.label || event.meeting_mark_id);
  const title = label.replace(/^(决策|决定|任务|待办|风险|问题|疑问|action|todo|risk|question|q)\s*[:：-]\s*/i, '');
  return {
    schema_version: 'inkloop.post_process_result.v1',
    result_id: `result_${event.meeting_mark_id}`,
    trace_id: event.trace_id,
    result_type: resultTypeFromLabel(label),
    title,
    content_md: `后处理结论：${label}\n\n这条结果来自会中手写锚点，并已绑定飞书会议 ${expectedMeetingNo} 的时间轴和会议文档投影。`,
    source_refs: event.source_refs,
    confidence: 0.88,
    status: 'accepted',
    created_at: generatedAt,
  };
});
const invalidPostProcessResults = postProcessResults
  .map((result) => ({ result_id: result.result_id, issues: validateMeetingPostProcessSourceRefs(result.source_refs) }))
  .filter((item) => item.issues.length);
if (invalidPostProcessResults.length) fail(`post-process source_refs invalid: ${JSON.stringify(invalidPostProcessResults)}`);

const postprocessKnowledgeObjects = await Promise.all(postProcessResults.map((result) => buildKnowledgeObjectFromPostProcessResult({
  result,
  documentTitle,
})));
const postprocessKinds = postprocessKnowledgeObjects.map((object) => object.kind);
for (const expected of ['meeting_action', 'meeting_decision', 'meeting_risk', 'qa'] as const) {
  if (!postprocessKinds.includes(expected)) fail(`meeting post-process KnowledgeObject missing ${expected}`);
}

const aiTurns: CloudAiTurnRecord[] = postProcessResults.map((result) => ({
  schema_version: 'inkloop.cloud_hub.ai_turn.v1',
  ai_turn_id: result.result_id,
  document_id: exportResult.documentId,
  mark_ids: markIdsFromSourceRefs(result.source_refs),
  prompt_md: [
    `Meeting: ${documentTitle}`,
    `Feishu meeting: ${feishuMeetingId}`,
    '',
    'Source refs:',
    '```json',
    JSON.stringify(result.source_refs, null, 2),
    '```',
  ].join('\n'),
  response_md: result.content_md,
  status: aiTurnStatusFromPostProcess(result.status),
  created_at: result.created_at,
  updated_at: result.created_at,
  metadata: {
    source: 'real_feishu_meeting_e2e',
    meeting_id: meetingId,
    feishu_meeting_id: feishuMeetingId,
    result_type: result.result_type,
  },
}));

const allKnowledgeObjects: KnowledgeObject[] = [
  ...exportResult.knowledgeExport.objects,
  ...postprocessKnowledgeObjects,
];
for (const aiTurn of aiTurns) {
  await cloudFetchJson<{ ok: boolean; ai_turn: CloudAiTurnRecord }>('/v1/knowledge/ai-turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ai_turn: aiTurn }),
  });
}
for (const object of allKnowledgeObjects) {
  await cloudFetchJson<{ ok: boolean; object: KnowledgeObject }>('/v1/knowledge/objects', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ object }),
  });
}
await cloudFetchJson<{ ok: boolean; document_projection: DocumentProjection }>('/v1/knowledge/document-projections', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ document_projection: projection }),
});

const [persistedAiTurns, persistedObjects, persistedProjections] = await Promise.all([
  cloudFetchJson<{ ai_turns: CloudAiTurnRecord[] }>(`/v1/knowledge/ai-turns?document_id=${encodeURIComponent(exportResult.documentId)}`),
  cloudFetchJson<{ objects: KnowledgeObject[] }>(`/v1/knowledge/objects?document_id=${encodeURIComponent(exportResult.documentId)}`),
  cloudFetchJson<{ document_projections: DocumentProjection[] }>(`/v1/knowledge/document-projections?document_id=${encodeURIComponent(exportResult.documentId)}`),
]);
const expectedAiTurnIds = new Set(aiTurns.map((turn) => turn.ai_turn_id));
const expectedObjectIds = new Set(allKnowledgeObjects.map((object) => object.ko_id));
const expectedPostprocessObjectIds = new Set(postprocessKnowledgeObjects.map((object) => object.ko_id));
const persistedExpectedAiTurns = persistedAiTurns.ai_turns.filter((turn) => expectedAiTurnIds.has(turn.ai_turn_id));
const persistedExpectedObjects = persistedObjects.objects.filter((object) => expectedObjectIds.has(object.ko_id));
const persistedProjection = persistedProjections.document_projections.find((item) => item.projection_id === projection.projection_id);
if (persistedExpectedAiTurns.length !== aiTurns.length) fail(`Cloud Hub did not persist all ai_turns: ${persistedExpectedAiTurns.length}/${aiTurns.length}`);
if (persistedExpectedObjects.length !== allKnowledgeObjects.length) fail(`Cloud Hub did not persist all KnowledgeObjects: ${persistedExpectedObjects.length}/${allKnowledgeObjects.length}`);
if (!persistedProjection) fail('Cloud Hub did not persist the meeting DocumentProjection');
if (persistedExpectedObjects.some((object) => expectedPostprocessObjectIds.has(object.ko_id) && !(object.source_refs || []).some((ref) => (ref as { ref_type?: string }).ref_type === 'meeting_mark'))) {
  fail('Cloud Hub meeting KnowledgeObject lost meeting_mark source_refs');
}

const renderedFiles = renderVaultMarkdown({
  entities: [{
    documentId: exportResult.documentId,
    documentTitle: exportResult.documentTitle,
    mode: 'meeting',
    dates: [new Date(startMs).toISOString().slice(0, 10)],
    knowledgeObjects: persistedExpectedObjects,
    documentProjections: [persistedProjection],
    visualModel: exportResult.visualModel,
  }],
});
const collapsedFiles = collapseMeetingProjectionFiles(renderedFiles).map((file) => ({
  ...file,
  markdown: enhanceMeetingMarkdown(file.markdown, note, markInputs, postProcessResults),
}));
if (vaultRoot.split('/').at(-1) === 'InkLoop-Obsidian-Test-Vault') {
  await rm(join(vaultRoot, 'InkLoop/Meetings'), { recursive: true, force: true });
}
const writtenFiles = await writeRenderedFiles(vaultRoot, collapsedFiles);
const hubFile = writtenFiles[0] || '';
const hubMarkdown = hubFile ? await readFile(hubFile, 'utf8') : '';
for (const required of ['## 飞书智能纪要', '## 原始文字记录', '## InkLoop 手写记录（模拟）', '## 后处理结果', '"ref_type": "meeting_mark"']) {
  if (!hubMarkdown.includes(required)) fail(`Obsidian meeting markdown missing ${required}`);
}
await mkdir(dirname(testResultPath), { recursive: true });
const result = {
  ok: true,
  latency_ms: Date.now() - startedAt,
  meeting: {
    title: documentTitle,
    feishu_meeting_id: feishuMeetingId,
    meeting_no: note.meeting?.meeting_no || expectedMeetingNo,
    start_time: new Date(startMs).toISOString(),
    end_time: Number.isFinite(endMs) && endMs > startMs ? new Date(endMs).toISOString() : null,
    source_status: meetingSource?.status || null,
  },
  feishu_note: {
    transcript_cue_count: cues.length,
    speaker_count: speakerCount,
    transcript_content_length: note.transcript.content_length,
    summary_content_length: note.summary.content_length,
  },
  inkloop: {
    document_id: exportResult.documentId,
    knowledge_kinds: [...new Set(persistedExpectedObjects.map((object) => object.kind))].sort(),
    simulated_mark_count: markInputs.length,
    postprocess_result_count: postProcessResults.length,
    cloud_hub: {
      base_url: cloudHubBase,
      tenant_id: tenantId,
      user_id: userId,
      pruned_other_meeting_docs: pruned,
      persisted_ai_turn_count: persistedExpectedAiTurns.length,
      persisted_knowledge_object_count: persistedExpectedObjects.length,
      persisted_document_projection_count: persistedProjection ? 1 : 0,
    },
    obsidian: {
      vault_root: vaultRoot,
      files: writtenFiles,
      single_meeting_file: hubFile,
      contains_feishu_summary: hubMarkdown.includes('## 飞书智能纪要'),
      contains_raw_transcript: hubMarkdown.includes('## 原始文字记录'),
      contains_handwriting_marks: hubMarkdown.includes('## InkLoop 手写记录（模拟）'),
      contains_postprocess: hubMarkdown.includes('## 后处理结果'),
    },
    warnings: exportResult.warnings,
  },
};
await writeFile(testResultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
