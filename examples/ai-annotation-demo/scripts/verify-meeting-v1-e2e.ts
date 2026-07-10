import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildRuntimeSnapshotFromProjection } from '../src/integration/inksurface/runtime-sync-bridge';
import { assembleMeetingL1Export, type MeetingExportInput } from '../src/integration/inksurface/meeting-export';
import {
  postProcessContextFromLarkTimeline,
  type LarkTimelineAnnotationIngest,
  type LarkTimelineMeetingSessionStart,
} from '../src/integration/lark-meeting-timeline/adapter';
import type { KnowledgeKind } from '../src/knowledge/knowledge-object';
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

function fail(message: string): never {
  throw new Error(message);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (!address || typeof address === 'string') fail('failed to allocate local port');
  return address.port;
}

async function fetchJson(url: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) fail(`${options.method || 'GET'} ${url} HTTP ${response.status}: ${text}`);
  return body;
}

async function waitForServer(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/state`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw lastError instanceof Error ? lastError : new Error('meeting timeline server did not start');
}

function createSseStateWatcher(
  baseUrl: string,
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): { ready: Promise<void>; done: Promise<{ latency_ms: number; sequence_count: number }> } {
  const started = Date.now();
  const controller = new AbortController();
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const unrefTimer = (timer as { unref?: () => void }).unref;
  if (typeof unrefTimer === 'function') unrefTimer.call(timer);

  const done = (async () => {
    try {
      const response = await fetch(`${baseUrl}/api/stream`, { signal: controller.signal });
      if (!response.ok || !response.body) fail(`GET ${baseUrl}/api/stream HTTP ${response.status}`);
      readyResolve();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          let event = 'message';
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
            if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
          }
          if (event !== 'state' || data.length === 0) continue;
          const state = JSON.parse(data.join('\n')) as Record<string, unknown>;
          if (predicate(state)) {
            await reader.cancel().catch(() => undefined);
            clearTimeout(timer);
            return {
              latency_ms: Date.now() - started,
              sequence_count: Array.isArray(state.sequence) ? state.sequence.length : 0,
            };
          }
        }
      }
      fail('SSE stream ended before the expected meeting mark appeared');
    } catch (error) {
      if (timedOut) fail(`SSE did not publish the expected meeting mark within ${timeoutMs}ms`);
      readyReject(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();

  return { ready, done };
}

function obsidianSection(kind: KnowledgeKind): 'Reading Note' | 'Task' | 'Decision' | 'Risk' {
  if (kind === 'meeting_action' || kind === 'task') return 'Task';
  if (kind === 'meeting_decision') return 'Decision';
  if (kind === 'meeting_risk') return 'Risk';
  return 'Reading Note';
}

function resultTypeFromLabel(label: string): PostProcessResult['result_type'] {
  if (/^(任务|待办|action|todo)/i.test(label)) return 'task';
  if (/^(决策|决定|decision)/i.test(label)) return 'decision';
  if (/^(风险|risk)/i.test(label)) return 'risk';
  if (/^(问题|疑问|question|q)/i.test(label)) return 'question';
  return 'knowledge_note';
}

const startedAt = Date.now();
const root = resolve(new URL('..', import.meta.url).pathname);
const repoRoot = resolve(root, '../..');
const sdkRoot = join(root, 'Lark-Meeting-Timeline-main');
const tempDir = await mkdtemp(join(tmpdir(), 'inkloop-meeting-v1-e2e-'));
const vaultRoot = resolve(process.env.INKLOOP_MEETING_E2E_VAULT || join(repoRoot, 'test-results/meeting-v1-e2e-vault'));
const shouldResetVaultRoot = !process.env.INKLOOP_MEETING_E2E_VAULT;
const activeObsidianVaultRoot = resolve(process.env.INKLOOP_ACTIVE_OBSIDIAN_VAULT || join(process.env.HOME || '', 'Desktop/InkLoop-Obsidian-Test-Vault'));
const mirrorActiveVault = process.env.INKLOOP_MIRROR_MEETING_E2E_TO_ACTIVE === '1';
const cloudHubBase = (process.env.INKLOOP_CLOUD_HUB_BASE || 'http://127.0.0.1:8731').replace(/\/+$/, '');
const tenantId = process.env.INKLOOP_TENANT_ID || 'local';
const userId = process.env.INKLOOP_USER_ID || 'local_demo';
const deviceId = process.env.INKLOOP_DEVICE_ID || 'meeting-v1-e2e';
const localAuthStore = resolve(process.env.INKLOOP_LOCAL_AUTH_STORE || join(root, '.inkloop/auth-sessions.json'));
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const meetingStartMs = Date.parse('2026-07-03T02:00:00.000Z');
const meetingId = 'mtg_v1_sdk_e2e';
const documentTitle = 'V1 SDK Meeting E2E';
const markAsTestRun = process.env.INKLOOP_MARK_MEETING_E2E_AS_TEST_RUN !== '0';

async function discoverLocalSessionToken(): Promise<string> {
  if (process.env.INKLOOP_SESSION_TOKEN || process.env.INKLOOP_DEVICE_SESSION_TOKEN) {
    return process.env.INKLOOP_SESSION_TOKEN || process.env.INKLOOP_DEVICE_SESSION_TOKEN || '';
  }
  try {
    const parsed = JSON.parse(await readFile(localAuthStore, 'utf8')) as {
      sessions?: Record<string, { tenant_id?: string; user_id?: string; expires_at?: number; updated_at?: number; created_at?: number }>;
    };
    const sessions = Object.entries(parsed.sessions || {})
      .filter(([, session]) => session.tenant_id === tenantId && session.user_id === userId && Number(session.expires_at || 0) > Date.now())
      .sort(([, left], [, right]) => Number(right.updated_at || right.created_at || 0) - Number(left.updated_at || left.created_at || 0));
    return String(sessions[0]?.[0] || '');
  } catch {
    return '';
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
  const response = await fetch(`${cloudHubBase}${path}`, {
    ...options,
    headers: {
      ...cloudHeaders(),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) fail(`${options.method || 'GET'} ${cloudHubBase}${path} HTTP ${response.status}: ${text}`);
  return body as T;
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

function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const text = String(markdown || '');
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end < 0) return {};
  const frontmatter = text.slice(4, end).trim();
  const out: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^"|"$/g, '');
  }
  return out;
}

function stripFrontmatter(markdown: string): string {
  const text = String(markdown || '');
  if (!text.startsWith('---\n')) return text.trim();
  const end = text.indexOf('\n---', 4);
  return end < 0 ? text.trim() : text.slice(end + '\n---'.length).trim();
}

function stripLinkedNotesSection(markdown: string): string {
  return String(markdown || '').replace(/\n## 笔记\n[\s\S]*$/u, '').trimEnd();
}

function activeMeetingHubPath(path: string): string {
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
    stripLinkedNotesSection(hub.markdown),
    sections.length ? '## 笔记' : '',
    sections.join('\n\n---\n\n'),
  ].filter(Boolean).join('\n\n').trimEnd();
  return [{ path: activeMeetingHubPath(hub.path), markdown: `${markdown}\n` }];
}

async function resetManagedActiveMeetingArea(): Promise<void> {
  if (activeObsidianVaultRoot.split('/').at(-1) !== 'InkLoop-Obsidian-Test-Vault') return;
  await rm(join(activeObsidianVaultRoot, 'InkLoop/Meetings'), { recursive: true, force: true });
}

async function mirrorMeetingFilesToActiveVault(files: Array<{ path: string; markdown: string }>): Promise<{ vault_root: string; rendered_file_count: number; files: string[] } | null> {
  if (!mirrorActiveVault) return null;
  try {
    await access(activeObsidianVaultRoot);
  } catch {
    return null;
  }
  await resetManagedActiveMeetingArea();
  const meetingFiles = collapseMeetingProjectionFiles(files);
  const written = await writeRenderedFiles(activeObsidianVaultRoot, meetingFiles);
  return { vault_root: activeObsidianVaultRoot, rendered_file_count: written.length, files: written };
}

function aiTurnStatusFromPostProcess(status: PostProcessResult['status']): CloudAiTurnRecord['status'] {
  if (status === 'accepted' || status === 'edited' || status === 'dismissed') return status;
  return 'inbox';
}

function markIdsFromSourceRefs(refs: readonly PostProcessResult['source_refs'][number][]): string[] {
  return refs
    .filter((ref): ref is Extract<PostProcessResult['source_refs'][number], { ref_type: 'meeting_mark' }> => ref.ref_type === 'meeting_mark')
    .map((ref) => ref.meeting_mark_id);
}

const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: sdkRoot,
  env: {
    ...process.env,
    PORT: String(port),
    LARK_WS_EVENTS: '0',
    TIMELINE_DATA_DIR: tempDir,
    REAL_DEMO_AUTO_ARM: '0',
    REAL_DEMO_AUTO_ANNOTATION: '0',
    REAL_DEMO_DEVICE_SIMULATOR: '0',
    REAL_DEMO_DEVICE_STREAM: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

try {
  const sessionToken = await discoverLocalSessionToken();
  if (sessionToken && !process.env.INKLOOP_SESSION_TOKEN && !process.env.INKLOOP_DEVICE_SESSION_TOKEN) {
    process.env.INKLOOP_SESSION_TOKEN = sessionToken;
  }
  await waitForServer(baseUrl);
  const sdkSessionInput: LarkTimelineMeetingSessionStart = {
    platform: 'lark',
    meeting_id: meetingId,
    title: documentTitle,
    meeting_url: 'https://vc.feishu.cn/j/v1-sdk-e2e',
    start_time_ms: meetingStartMs,
    detector_source: 'inkloop_v1_e2e',
  };
  const session = await fetchJson(`${baseUrl}/api/meeting-session/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      ...sdkSessionInput,
      suppress_auto_annotations: true,
    }),
  });
  if ((session.meeting as { source?: string } | undefined)?.source !== 'open_meeting_session') fail('SDK session did not start an open meeting axis');

  const annotationInputs = [
    { id: 'ann_decision', offset: 8_000, label: '决策：MVP 演示闭环固定为 Web 导入、墨水屏标记、Obsidian 投影' },
    { id: 'ann_action', offset: 14_000, label: '任务：补齐 M103 低延迟手写验收数据' },
    { id: 'ann_risk', offset: 21_000, label: '风险：T10C Plus 手写延迟还没有形成通用方案' },
  ];
  const batchAnnotationInputs = [
    { id: 'ann_question_batch', offset: 28_000, label: '问题：Obsidian 回跳链接应该优先打开当前源文件还是最近设备' },
  ];
  const sdkAcks = [];
  for (const item of annotationInputs) {
    const postStarted = Date.now();
    const result = await fetchJson(`${baseUrl}/api/annotations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-hmp-device-id': 'm103-e2e',
        'x-hmp-device-type': 'hanwang_epaper',
      },
      body: JSON.stringify({
        id: item.id,
        source: 'hanwang_epaper',
        captured_at_ms: meetingStartMs + item.offset,
        kind: 'handwriting_trigger',
        label: item.label,
        text_candidates: [item.label],
        intent: 'meeting_mark',
        strokes: [[{ x: 0.1, y: 0.2, t: meetingStartMs + item.offset - 100 }, { x: 0.2, y: 0.22, t: meetingStartMs + item.offset }]],
      }),
    });
    const postLatencyMs = Date.now() - postStarted;
    if (postLatencyMs > 1_000) fail(`SDK annotation latency exceeded 1000ms: ${item.id} ${postLatencyMs}ms`);
    const ack = result.ack as { accepted?: boolean; on_real_axis?: boolean; normalized_time_ms?: number } | undefined;
    if (!ack?.accepted || !ack.on_real_axis) fail(`SDK annotation did not bind to real axis: ${item.id}`);
    sdkAcks.push({ id: item.id, normalized_time_ms: ack.normalized_time_ms, latency_ms: postLatencyMs, route: 'single' });
  }

  const questionId = batchAnnotationInputs[0].id;
  const sseWatcher = createSseStateWatcher(baseUrl, (state) => {
    const sequence = Array.isArray(state.sequence) ? state.sequence as Array<{ id?: string }> : [];
    return sequence.some((item) => item.id === questionId);
  });
  await sseWatcher.ready;
  const batchStarted = Date.now();
  const batchResult = await fetchJson(`${baseUrl}/api/annotations/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-hmp-device-id': 'm103-e2e',
      'x-hmp-device-type': 'hanwang_epaper',
    },
    body: JSON.stringify({
      annotations: batchAnnotationInputs.map((item) => ({
        id: item.id,
        source: 'hanwang_epaper',
        captured_at_ms: meetingStartMs + item.offset,
        kind: 'handwriting_trigger',
        label: item.label,
        text_candidates: [item.label],
        intent: 'meeting_mark',
        strokes: [[{ x: 0.15, y: 0.24, t: meetingStartMs + item.offset - 100 }, { x: 0.27, y: 0.25, t: meetingStartMs + item.offset }]],
      })),
    }),
  });
  const batchLatencyMs = Date.now() - batchStarted;
  if (batchLatencyMs > 1_000) fail(`SDK batch annotation latency exceeded 1000ms: ${batchLatencyMs}ms`);
  const batchAcks = batchResult.acks as Array<{ accepted?: boolean; on_real_axis?: boolean; normalized_time_ms?: number; id?: string }> | undefined;
  if (!Array.isArray(batchAcks) || batchAcks.length !== batchAnnotationInputs.length) fail('SDK batch annotation did not return one ack per mark');
  for (const ack of batchAcks) {
    if (!ack.accepted || !ack.on_real_axis) fail('SDK batch annotation did not bind to real axis');
  }
  const sseResult = await sseWatcher.done;

  const meeting: PersistedMeeting = {
    meeting_id: meetingId,
    workspace_id: 'ws_v1_e2e',
    title: documentTitle,
    scheduled_at: new Date(meetingStartMs).toISOString(),
    status: 'live',
    started_at: new Date(meetingStartMs).toISOString(),
    material_doc_ids: [],
    created_at: new Date(meetingStartMs).toISOString(),
    updated_at: new Date(meetingStartMs).toISOString(),
  };
  const input: MeetingExportInput = {
    meeting,
    cues: [],
    marks: [...annotationInputs, ...batchAnnotationInputs].map((item) => ({
      mark_id: item.id,
      entry_id: `ent_${item.id}`,
      abs_timestamp: meetingStartMs + item.offset,
      feature_type: 'handwriting',
      marked_text: item.label,
      page_index: 0,
      strokes: [{ tool: 'pen', color: '#1A1A1A', points: [{ x: 0.1, y: 0.2, t: 0, pressure: 0.5 }, { x: 0.2, y: 0.22, t: 1, pressure: 0.5 }] }],
      color: '#1A1A1A',
    })),
  };
  const exportResult = await assembleMeetingL1Export(input, { generatedAt: '2026-07-03T00:00:00.000Z' });
  const kinds = exportResult.knowledgeExport.objects.map((ko) => ko.kind);
  for (const expected of ['meeting_decision', 'meeting_action', 'meeting_risk', 'qa'] as const) {
    if (!kinds.includes(expected)) fail(`missing ${expected} KnowledgeObject`);
  }

  const projectMemoryRef: ProjectMemoryRef = {
    ref_type: 'project_memory',
    memory_id: 'mem_v1_mvp_loop',
    kind: 'milestone',
    title: 'V1 demo loop: Web import -> Paper mark -> Obsidian projection',
  };
  const allAnnotationInputs = [...annotationInputs, ...batchAnnotationInputs];
  const sdkAnnotationPayloads: LarkTimelineAnnotationIngest[] = allAnnotationInputs.map((item) => ({
    id: item.id,
    source: 'hanwang_epaper',
    captured_at_ms: meetingStartMs + item.offset,
    kind: 'handwriting_trigger',
    label: item.label,
    text: item.label,
    device_id: 'm103-e2e',
    mark: { action: 'freehand', target_text: item.label },
  }));
  const adapterBundle = postProcessContextFromLarkTimeline({
    session: sdkSessionInput,
    annotations: sdkAnnotationPayloads,
    documentRefForAnnotation: (annotation, mark): DocumentSchemaRef => ({
      ref_type: 'document',
      document_id: exportResult.documentId,
      page_id: `pg_${meetingId}_0`,
      page_index: 0,
      event_id: annotation.id,
      trace_id: mark.trace_id,
      bbox: [0.1, 0.2, 0.2, 0.08],
      object_refs: [String(annotation.id || mark.id)],
      quote: annotation.label,
      confidence: 0.91,
    }),
    projectMemoryRefs: [projectMemoryRef],
    userFeedback: 'accepted',
    createdAt: '2026-07-03T00:00:00.000Z',
  });
  if (adapterBundle.session.source !== 'open_meeting_session') fail(`SDK adapter produced unexpected meeting source: ${adapterBundle.session.source}`);
  const schemaAlignedEvents = adapterBundle.alignedEvents;
  if (schemaAlignedEvents.some((event) => event.alignment_status !== 'aligned' || event.schema_refs.length === 0)) {
    fail(`meeting schema alignment failed: ${JSON.stringify(schemaAlignedEvents)}`);
  }
  const postProcessContext = adapterBundle.context;
  if (postProcessContext.document_refs.length !== 4 || postProcessContext.meeting_marks.length !== 4 || postProcessContext.project_memory_refs.length !== 1) {
    fail(`post-process context did not preserve expected refs: ${JSON.stringify(postProcessContext)}`);
  }
  const postProcessResults: PostProcessResult[] = schemaAlignedEvents.map((event) => {
    const type = resultTypeFromLabel(String(event.payload.label || ''));
    return {
      schema_version: 'inkloop.post_process_result.v1',
      result_id: `result_${event.meeting_mark_id}`,
      trace_id: event.trace_id,
      result_type: type,
      title: String(event.payload.label || event.meeting_mark_id).replace(/^(决策|决定|任务|待办|风险|问题|疑问|action|todo|risk|question|q)\s*[:：-]\s*/i, ''),
      content_md: `会议后处理结果：${String(event.payload.label || event.meeting_mark_id)}`,
      source_refs: event.source_refs,
      confidence: 0.86,
      status: 'accepted',
      created_at: '2026-07-03T00:00:00.000Z',
    };
  });
  const invalidPostProcessResults = postProcessResults
    .map((result) => ({ result_id: result.result_id, issues: validateMeetingPostProcessSourceRefs(result.source_refs) }))
    .filter((item) => item.issues.length);
  if (invalidPostProcessResults.length) fail(`post-process source_refs invalid: ${JSON.stringify(invalidPostProcessResults)}`);
  const contractKnowledgeObjects = await Promise.all(postProcessResults.map((result) => buildKnowledgeObjectFromPostProcessResult({
    result,
    documentTitle,
  })));
  const contractKinds = contractKnowledgeObjects.map((ko) => ko.kind);
  for (const expected of ['meeting_decision', 'meeting_action', 'meeting_risk', 'qa'] as const) {
    if (!contractKinds.includes(expected)) fail(`meeting contract KO missing ${expected}`);
  }

  const projection = exportResult.documentProjections.document_projections[0];
  if (!projection) fail('meeting export did not produce a document projection');
  const meetingAiTurns: CloudAiTurnRecord[] = postProcessResults.map((result) => ({
    schema_version: 'inkloop.cloud_hub.ai_turn.v1',
    ai_turn_id: result.result_id,
    document_id: exportResult.documentId,
    mark_ids: markIdsFromSourceRefs(result.source_refs),
    prompt_md: [
      `Meeting: ${documentTitle}`,
      `Trace: ${result.trace_id}`,
      '',
      'Post-process source refs:',
      '```json',
      JSON.stringify(result.source_refs, null, 2),
      '```',
    ].join('\n'),
    response_md: result.content_md,
    status: aiTurnStatusFromPostProcess(result.status),
    created_at: result.created_at,
    updated_at: result.created_at,
    metadata: {
      source: 'meeting_v1_e2e',
      meeting_id: meetingId,
      result_type: result.result_type,
      trace_id: result.trace_id,
      ...(markAsTestRun ? { inkloop_test_run: true } : {}),
    },
  }));
  const markObjectAsTestRun = <T extends KnowledgeObject>(object: T): T & { metadata?: Record<string, unknown> } => markAsTestRun
    ? { ...object, metadata: { ...((object as T & { metadata?: Record<string, unknown> }).metadata || {}), inkloop_test_run: true } }
    : object;
  const markProjectionAsTestRun = <T extends DocumentProjection>(item: T): T & { metadata?: Record<string, unknown> } => markAsTestRun
    ? { ...item, metadata: { ...((item as T & { metadata?: Record<string, unknown> }).metadata || {}), inkloop_test_run: true } }
    : item;
  const cloudKnowledgeObjects: Array<KnowledgeObject & { metadata?: Record<string, unknown> }> = [...exportResult.knowledgeExport.objects, ...contractKnowledgeObjects].map(markObjectAsTestRun);
  const cloudProjection = markProjectionAsTestRun(projection);
  for (const aiTurn of meetingAiTurns) {
    await cloudFetchJson<{ ok: boolean; ai_turn: CloudAiTurnRecord }>('/v1/knowledge/ai-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ai_turn: aiTurn }),
    });
  }
  for (const object of cloudKnowledgeObjects) {
    await cloudFetchJson<{ ok: boolean; object: KnowledgeObject }>('/v1/knowledge/objects', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ object }),
    });
  }
  await cloudFetchJson<{ ok: boolean; document_projection: DocumentProjection }>('/v1/knowledge/document-projections', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ document_projection: cloudProjection }),
  });
  const [cloudAiTurns, cloudObjects, cloudProjections] = await Promise.all([
    cloudFetchJson<{ ai_turns: CloudAiTurnRecord[] }>(`/v1/knowledge/ai-turns?document_id=${encodeURIComponent(exportResult.documentId)}`),
    cloudFetchJson<{ objects: KnowledgeObject[] }>(`/v1/knowledge/objects?document_id=${encodeURIComponent(exportResult.documentId)}`),
    cloudFetchJson<{ document_projections: DocumentProjection[] }>(`/v1/knowledge/document-projections?document_id=${encodeURIComponent(exportResult.documentId)}`),
  ]);
  const expectedAiTurnIds = new Set(meetingAiTurns.map((turn) => turn.ai_turn_id));
  const expectedPostprocessKoIds = new Set(contractKnowledgeObjects.map((object) => object.ko_id));
  const expectedAnnotationKoIds = new Set(exportResult.knowledgeExport.objects.map((object) => object.ko_id));
  const persistedAiTurns = cloudAiTurns.ai_turns.filter((turn) => expectedAiTurnIds.has(turn.ai_turn_id));
  const persistedPostprocessObjects = cloudObjects.objects.filter((object) => expectedPostprocessKoIds.has(object.ko_id));
  const persistedAnnotationObjects = cloudObjects.objects.filter((object) => expectedAnnotationKoIds.has(object.ko_id));
  const persistedProjection = cloudProjections.document_projections.find((item) => item.projection_id === projection.projection_id);
  if (persistedAiTurns.length !== meetingAiTurns.length) fail(`Cloud Hub did not persist all meeting ai_turns: ${persistedAiTurns.length}/${meetingAiTurns.length}`);
  if (persistedPostprocessObjects.length !== contractKnowledgeObjects.length) {
    fail(`Cloud Hub did not persist all meeting post-process KnowledgeObjects: ${persistedPostprocessObjects.length}/${contractKnowledgeObjects.length}`);
  }
  if (persistedAnnotationObjects.length !== exportResult.knowledgeExport.objects.length) {
    fail(`Cloud Hub did not persist all meeting event KnowledgeObjects: ${persistedAnnotationObjects.length}/${exportResult.knowledgeExport.objects.length}`);
  }
  if (!persistedProjection) fail(`Cloud Hub did not persist meeting DocumentProjection: ${projection.projection_id}`);
  const persistedAiTurnIds = new Set(persistedAiTurns.map((turn) => turn.ai_turn_id));
  if (persistedPostprocessObjects.some((object) => !(object.provenance.ai_turn_ids || []).some((id) => persistedAiTurnIds.has(id)))) {
    fail('Cloud Hub meeting KnowledgeObject provenance does not link back to persisted ai_turns');
  }
  if (persistedPostprocessObjects.some((object) => !(object.source_refs || []).some((ref) => (ref as { ref_type?: string }).ref_type === 'meeting_mark'))) {
    fail('Cloud Hub meeting KnowledgeObject lost meeting_mark source_refs');
  }

  const runtime = await buildRuntimeSnapshotFromProjection({
    documentId: exportResult.documentId,
    documentTitle: exportResult.documentTitle,
    projectionBlocks: projection?.blocks ?? [],
    knowledgeObjects: exportResult.knowledgeExport.objects,
    sourceKind: 'inkloop_created',
    sourcePath: `Meetings/${documentTitle}.md`,
    contentHash: projection?.content_hash,
    updatedAt: '2026-07-03T00:00:00.000Z',
  });
  const runtimeAnnotations = runtime.blocks.flatMap((block) => block.annotations ?? []);
  const sections = [...new Set(runtimeAnnotations.map((annotation) => obsidianSection(annotation.kind as KnowledgeKind)))].sort();
  for (const expected of ['Decision', 'Reading Note', 'Risk', 'Task'] as const) {
    if (!sections.includes(expected)) fail(`runtime annotations missing Obsidian ${expected} projection`);
  }

  if (shouldResetVaultRoot) await rm(vaultRoot, { recursive: true, force: true });
  const renderedFiles = renderVaultMarkdown({
    entities: [{
      documentId: exportResult.documentId,
      documentTitle: exportResult.documentTitle,
      mode: 'meeting',
      dates: ['2026-07-03'],
      knowledgeObjects: [...persistedAnnotationObjects, ...persistedPostprocessObjects],
      documentProjections: [persistedProjection],
      visualModel: exportResult.visualModel,
    }],
  });
  await writeRenderedFiles(vaultRoot, renderedFiles);
  const activeVaultMirror = await mirrorMeetingFilesToActiveVault(renderedFiles);
  await writeFile(join(vaultRoot, 'manifest.json'), `${JSON.stringify({
    schema: 'inkloop.meeting_v1_e2e_vault.v1',
    status: 'ready',
    vault_root: vaultRoot,
    document_id: exportResult.documentId,
    document_title: exportResult.documentTitle,
    rendered_file_count: renderedFiles.length,
    required_projection_kinds: ['meeting_decision', 'meeting_action', 'meeting_risk', 'qa'],
    required_schema_aligned_event_count: 4,
    generated_at: '2026-07-03T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8');
  const hubFile = renderedFiles.find((file) => file.path.endsWith(`${documentTitle}.md`))?.path ?? renderedFiles[0]?.path ?? '';
  const questionFile = renderedFiles.find((file) => file.markdown.includes('inkloop_knowledge_kind: "qa"'))?.path ?? '';
  const sourceRefsFile = renderedFiles.find((file) => file.markdown.includes('"ref_type": "meeting_mark"') && file.markdown.includes('"ref_type": "document"'))?.path ?? '';
  if (!sourceRefsFile) fail('Obsidian meeting projection did not preserve structured document + meeting_mark source_refs');
  const activeVaultSourceRefsFile = activeVaultMirror?.files[0] ?? null;
  const activeVaultSourceRefsMarkdown = activeVaultSourceRefsFile ? await readFile(activeVaultSourceRefsFile, 'utf8') : '';
  const activeVaultContainsSourceRefs = Boolean(
    activeVaultSourceRefsMarkdown.includes('"ref_type": "meeting_mark"')
    && activeVaultSourceRefsMarkdown.includes('"ref_type": "document"')
    && activeVaultSourceRefsMarkdown.includes('inkloop:begin-ko')
    && activeVaultSourceRefsMarkdown.includes('kind="meeting_'),
  );
  if (activeVaultMirror && !activeVaultContainsSourceRefs) {
    fail('Active Obsidian meeting projection did not preserve visible KnowledgeObject and structured source_refs');
  }

  console.log(JSON.stringify({
    ok: true,
    latency_ms: Date.now() - startedAt,
    sdk: {
      base_url: baseUrl,
      annotation_count: sdkAcks.length + batchAnnotationInputs.length,
      acks: sdkAcks,
      batch: {
        count: batchAnnotationInputs.length,
        latency_ms: batchLatencyMs,
        sse_latency_ms: sseResult.latency_ms,
        sse_sequence_count: sseResult.sequence_count,
      },
    },
    inkloop: {
      document_id: exportResult.documentId,
      document_title: exportResult.documentTitle,
      knowledge_kinds: kinds,
      runtime_annotation_count: runtimeAnnotations.length,
      obsidian_sections: sections,
      schema_alignment: {
        aligned_event_count: schemaAlignedEvents.length,
        sdk_adapter_session_source: adapterBundle.session.source,
        sdk_adapter_mark_kinds: adapterBundle.meetingMarks.map((mark) => mark.kind),
        postprocess_document_ref_count: postProcessContext.document_refs.length,
        postprocess_meeting_mark_count: postProcessContext.meeting_marks.length,
        postprocess_project_memory_ref_count: postProcessContext.project_memory_refs.length,
        contract_knowledge_kinds: contractKinds,
      },
      cloud_hub: {
        base_url: cloudHubBase,
        tenant_id: tenantId,
        user_id: userId,
        session_authenticated: !!(process.env.INKLOOP_SESSION_TOKEN || process.env.INKLOOP_DEVICE_SESSION_TOKEN),
        persisted_ai_turn_count: persistedAiTurns.length,
        persisted_event_knowledge_object_count: persistedAnnotationObjects.length,
        persisted_postprocess_knowledge_object_count: persistedPostprocessObjects.length,
        persisted_document_projection_count: persistedProjection ? 1 : 0,
        persisted_ai_turn_ids: persistedAiTurns.map((turn) => turn.ai_turn_id),
        persisted_postprocess_knowledge_object_ids: persistedPostprocessObjects.map((object) => object.ko_id),
        rendered_from_persisted_cloud_hub_objects: true,
      },
      warnings: exportResult.warnings,
      vault_projection: {
        vault_root: vaultRoot,
        rendered_file_count: renderedFiles.length,
        hub_file: hubFile ? join(vaultRoot, hubFile) : null,
        question_file: questionFile ? join(vaultRoot, questionFile) : null,
        source_refs_file: sourceRefsFile ? join(vaultRoot, sourceRefsFile) : null,
        active_vault_mirror: activeVaultMirror,
        active_vault_hub_file: activeVaultMirror && hubFile ? join(activeObsidianVaultRoot, hubFile) : null,
        active_vault_question_file: activeVaultMirror && questionFile ? join(activeObsidianVaultRoot, questionFile) : null,
        active_vault_source_refs_file: activeVaultSourceRefsFile,
        active_vault_contains_source_refs: activeVaultContainsSourceRefs,
      },
    },
  }, null, 2));
} catch (error) {
  console.error(serverOutput);
  throw error;
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => undefined);
  await rm(tempDir, { recursive: true, force: true });
}
