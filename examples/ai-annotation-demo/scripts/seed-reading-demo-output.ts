import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { RUNTIME_SYNC_EVENT_SCHEMA_VERSION, type RuntimeSyncEvent } from '../../../packages/runtime-schema/src/index';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const CLOUD_HUB = process.env.INKLOOP_CLOUD_HUB_URL || 'http://127.0.0.1:8731';
const TENANT_ID = process.env.INKLOOP_TENANT_ID || 'local';
const USER_ID = process.env.INKLOOP_USER_ID || 'local_demo';
const DOC_ID = process.env.INKLOOP_READING_DEMO_DOC_ID || 'doc_3cfa06ac81d6';
const DOC_TITLE = process.env.INKLOOP_READING_DEMO_TITLE || 'AI时代的UX范式';
const KNOWLEDGE_INDEX = process.env.INKLOOP_KNOWLEDGE_INDEX || resolve(ROOT, '.inkloop/knowledge/local/local_demo/index.json');

interface LocalAuthFlow {
  flow_id?: string;
  poll_token?: string;
  qr_payload?: string;
  error?: string;
}

interface DeviceSession {
  session_token: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function eventId(): string {
  return `evt_reading_demo_${Date.now().toString(36)}`;
}

async function cleanExistingDemoDocument(): Promise<void> {
  let parsed: {
    ai_turns?: Array<{ document_id?: string }>;
    knowledge_objects?: Array<{ source?: { document_id?: string }; document_id?: string }>;
    document_projections?: Array<{ document_id?: string }>;
    [key: string]: unknown;
  };
  try {
    parsed = JSON.parse(await readFile(KNOWLEDGE_INDEX, 'utf8'));
  } catch {
    return;
  }
  await mkdir(dirname(KNOWLEDGE_INDEX), { recursive: true });
  const backup = `${KNOWLEDGE_INDEX}.backup-reading-demo-${nowIso().replace(/[:.]/g, '-')}`;
  await writeFile(backup, JSON.stringify(parsed, null, 2), 'utf8');
  const isDemoDoc = (docId?: string): boolean => docId === DOC_ID;
  const next = {
    ...parsed,
    updated_at: nowIso(),
    ai_turns: (parsed.ai_turns || []).filter((turn) => !isDemoDoc(turn.document_id)),
    knowledge_objects: (parsed.knowledge_objects || []).filter((ko) => !isDemoDoc(ko.source?.document_id || ko.document_id)),
    document_projections: (parsed.document_projections || []).filter((projection) => !isDemoDoc(projection.document_id)),
  };
  await writeFile(KNOWLEDGE_INDEX, JSON.stringify(next, null, 2), 'utf8');
  console.log(`cleaned existing demo knowledge for ${DOC_ID}`);
  console.log(`backup: ${backup}`);
}

function stroke(points: Array<[number, number]>, tool: 'pen' | 'highlighter' = 'pen', color?: string) {
  return {
    tool,
    color: color || (tool === 'highlighter' ? '#f2d94e' : '#111111'),
    opacity: tool === 'highlighter' ? 0.55 : 0.9,
    coord_space: 'block_norm',
    capture_surface: 'reader',
    points: points.map(([x, y], index) => ({ x, y, t: index * 18, pressure: tool === 'highlighter' ? 0.42 : 0.72 })),
  };
}

function demoEvent(): RuntimeSyncEvent {
  const at = nowIso();
  const id = eventId();
  return {
    schema_version: RUNTIME_SYNC_EVENT_SCHEMA_VERSION,
    event_id: id,
    source: 'inkloop_device',
    doc_id: DOC_ID,
    operation: 'runtime.bootstrap',
    target: { type: 'document', id: DOC_ID },
    payload: {
      snapshot: {
        doc_id: DOC_ID,
        doc_dir: `inkloop-demo/${DOC_ID}`,
        document: { doc_id: DOC_ID, title: DOC_TITLE, source_type: 'imported_pdf', updated_at: at },
        source: { doc_id: DOC_ID, kind: 'imported_pdf', identity: { title: DOC_TITLE } },
        identity: {
          schema_version: 'inkloop.runtime_document_identity.v1',
          doc_id: DOC_ID,
          source_kind: 'imported_pdf',
          stable_key: DOC_ID,
          created_at: at,
          updated_at: at,
        },
        blocks: [
          {
            object_id: 'blk_ux_summary',
            text: '文章梳理了 UX 从个人电脑/互联网时代、移动互联网时代到智能时代的范式变化，并提出 UX 3.0 需要同时覆盖体验生态、AI 赋能、人智交互和人智协同。',
            source_anchor: {
              quote: '智能时代 UX 应从界面可用性扩展到系统理解、信任建立、用户自主权和人机协同。',
              object_refs: ['tl_ux_summary_1', 'tl_ux_summary_2'],
            },
            projection: {
              block_id: 'blk_ux_summary',
              kind: 'paragraph',
              region: 'generated',
              page_index: 0,
              page_id: `pg_${DOC_ID}_1`,
              knowledge_object_ids: ['ko_reading_summary_ux30'],
            },
            annotations: [{
              ko_id: 'ko_reading_summary_ux30',
              kind: 'summary',
              title: '阅读摘要：UX 3.0 的核心迁移',
              body_md: '这篇文章的核心不是新增一套界面方法，而是把 UX 从“可用性优化”推进到“智能系统中的理解、信任、自主权和协同体验”。对 InkLoop 来说，阅读标记要保留原文证据，并把手写判断整理成可回跳的设计洞察。',
              status: 'accepted',
              render_mode: 'margin_note',
              visual_bbox: [0.08, 0.1, 0.78, 0.12],
              created_at: at,
              updated_at: at,
            }],
          },
          {
            object_id: 'blk_ux_trust_autonomy',
            text: '智能产品体验不只看界面是否好用，还要看用户是否理解、信任并保有用户自主权。',
            source_anchor: {
              quote: '智能产品体验不只看界面是否好用，还要看用户是否理解、信任并保有用户自主权。',
              object_refs: ['tl_ux_1', 'tl_ux_2', 'tl_ux_3'],
            },
            projection: {
              block_id: 'blk_ux_trust_autonomy',
              kind: 'paragraph',
              region: 'editable',
              page_index: 1,
              page_id: `pg_${DOC_ID}_2`,
              knowledge_object_ids: ['ko_reading_highlight_trust'],
            },
            annotations: [{
              ko_id: 'ko_reading_highlight_trust',
              kind: 'highlight',
              title: '信任与自主权是 AI 体验的核心指标',
              body_md: '这条高亮保留原文证据，用来提醒后续产品设计不能只优化效率和可用性，还要呈现 AI 的依据、边界和用户接管入口。',
              status: 'accepted',
              render_mode: 'stroke_only',
              visual_bbox: [0.1, 0.18, 0.78, 0.1],
              visual_strokes: [stroke([[0.02, 0.62], [0.3, 0.6], [0.62, 0.61], [0.95, 0.59]], 'highlighter')],
              created_at: at,
              updated_at: at,
            }],
          },
          {
            object_id: 'blk_ux_requirement_shift',
            text: '智能时代对 UX 范式和方法提出了一系列新要求，包括提供更丰富的 UX、端到端整体体验、自然有效的人机交互、提升 UX 方法效率，以及人机智能互补和协同。',
            source_anchor: {
              quote: '智能时代对 UX 范式和方法提出了一系列新要求，包括提供更丰富的 UX、端到端整体体验、自然有效的人机交互、提升 UX 方法效率，以及人机智能互补和协同。',
              object_refs: ['tl_ux_11', 'tl_ux_12', 'tl_ux_13'],
            },
            projection: {
              block_id: 'blk_ux_requirement_shift',
              kind: 'paragraph',
              region: 'editable',
              page_index: 1,
              page_id: `pg_${DOC_ID}_2`,
              knowledge_object_ids: ['ko_reading_handwritten_thought'],
            },
            annotations: [{
              ko_id: 'ko_reading_handwritten_thought',
              kind: 'reading_note',
              title: '手写想法：从界面可用性转向协同体验',
              body_md: '这段适合作为 InkLoop 阅读场景的产品论据：用户在论文里标记概念迁移，系统要把它沉淀成可复盘的产品启发，而不是简单保存一条划线。',
              status: 'accepted',
              render_mode: 'stroke_only',
              visual_bbox: [0.08, 0.32, 0.7, 0.12],
              visual_strokes: [stroke([[0.05, 0.18], [0.17, 0.12], [0.31, 0.18], [0.45, 0.13], [0.6, 0.2]])],
              created_at: at,
              updated_at: at,
            }],
          },
          {
            object_id: 'blk_ux_30_framework',
            text: 'UX 3.0 范式框架包括五大类 UX 方法：生态化体验、创新赋能体验、AI 赋能体验、人智交互体验、人智协同体验。',
            source_anchor: {
              quote: 'UX 3.0 范式框架包括五大类 UX 方法：生态化体验、创新赋能体验、AI 赋能体验、人智交互体验、人智协同体验。',
              object_refs: ['tl_ux_21', 'tl_ux_22'],
            },
            projection: {
              block_id: 'blk_ux_30_framework',
              kind: 'paragraph',
              region: 'editable',
              page_index: 2,
              page_id: `pg_${DOC_ID}_3`,
              knowledge_object_ids: ['ko_reading_ai_brush_ux30'],
            },
            annotations: [{
              ko_id: 'ko_reading_ai_brush_ux30',
              kind: 'ai_note',
              title: 'AI 笔刷回应：把 UX 3.0 转成产品检查表',
              prompt_md: '解释这段，并转成 InkLoop 产品设计检查项。',
              body_md: '可以把 UX 3.0 转成三个阅读后动作：识别 AI 介入点，判断用户是否仍能理解与接管，把证据沉淀成可回跳的设计检查项。对 InkLoop 来说，这正好对应“高亮证据 -> 手写判断 -> AI 笔刷归纳 -> Obsidian 输出”的闭环。',
              status: 'accepted',
              render_mode: 'margin_note',
              visual_bbox: [0.14, 0.26, 0.62, 0.1],
              visual_strokes: [stroke([[0.1, 0.82], [0.3, 0.76], [0.5, 0.8], [0.72, 0.74]])],
              created_at: at,
              updated_at: at,
            }],
          },
          {
            object_id: 'blk_ux_design_check',
            text: '智能时代的 UX 方法需要把用户的理解、信任、接管能力和协同边界作为设计评估对象。',
            source_anchor: {
              quote: '智能时代 UX 方法需要把用户的理解、信任、接管能力和协同边界作为设计评估对象。',
              object_refs: ['tl_ux_31', 'tl_ux_32', 'tl_ux_33'],
            },
            projection: {
              block_id: 'blk_ux_design_check',
              kind: 'paragraph',
              region: 'editable',
              page_index: 3,
              page_id: `pg_${DOC_ID}_4`,
              knowledge_object_ids: ['ko_reading_freehand_margin_note'],
            },
            annotations: [{
              ko_id: 'ko_reading_freehand_margin_note',
              kind: 'annotation',
              title: '手写边注：这里可以转成产品验收项',
              body_md: '用户在页边写下“验收项”：这类普通笔刷不需要被转成会议对象，而是沉淀成阅读中的判断。Obsidian 里应该保留原文、手写意图、回跳链接和笔迹预览。',
              status: 'accepted',
              render_mode: 'stroke_only',
              visual_bbox: [0.12, 0.42, 0.66, 0.16],
              visual_strokes: [
                stroke([[0.08, 0.24], [0.18, 0.18], [0.29, 0.25], [0.41, 0.17], [0.54, 0.24]]),
                stroke([[0.1, 0.54], [0.28, 0.5], [0.47, 0.52], [0.67, 0.48], [0.86, 0.52]]),
              ],
              created_at: at,
              updated_at: at,
            }],
          },
          {
            object_id: 'blk_ux_pen_underline',
            text: '智能时代 UX 不能只评价界面是否顺手，还要评价用户能否理解系统判断、知道边界并在必要时接管。',
            source_anchor: {
              quote: '用户能否理解系统判断、知道边界并在必要时接管，是智能产品体验是否可靠的关键。',
              object_refs: ['tl_ux_41', 'tl_ux_42', 'tl_ux_43'],
            },
            projection: {
              block_id: 'blk_ux_pen_underline',
              kind: 'paragraph',
              region: 'editable',
              page_index: 4,
              page_id: `pg_${DOC_ID}_5`,
              knowledge_object_ids: ['ko_reading_pen_underline_takeover'],
            },
            annotations: [{
              ko_id: 'ko_reading_pen_underline_takeover',
              kind: 'annotation',
              title: '红笔下划线：接管能力要变成设计检查项',
              body_md: '这条普通笔刷下划线对应用户的真实阅读意图：这里不是要生成会议任务，而是提醒后续产品设计必须检查“解释、边界、接管”三个入口是否存在。',
              status: 'accepted',
              render_mode: 'stroke_only',
              visual_bbox: [0.1, 0.5, 0.76, 0.08],
              visual_strokes: [stroke([[0.04, 0.76], [0.28, 0.74], [0.53, 0.77], [0.9, 0.73]], 'pen', '#d71920')],
              created_at: at,
              updated_at: at,
            }],
          },
          {
            object_id: 'blk_ux_collaboration_note',
            text: 'UX 3.0 强调人智协同体验，重点不是让 AI 替人完成全部判断，而是让人和系统形成互补的工作关系。',
            source_anchor: {
              quote: '人智协同体验强调人的判断和系统能力互补，而不是把用户排除在决策链路之外。',
              object_refs: ['tl_ux_51', 'tl_ux_52'],
            },
            projection: {
              block_id: 'blk_ux_collaboration_note',
              kind: 'paragraph',
              region: 'editable',
              page_index: 5,
              page_id: `pg_${DOC_ID}_6`,
              knowledge_object_ids: ['ko_reading_note_collaboration'],
            },
            annotations: [{
              ko_id: 'ko_reading_note_collaboration',
              kind: 'reading_note',
              title: '阅读笔记：人机协同不是自动化替代',
              body_md: '读到这里时可以沉淀一个产品原则：InkLoop 的 AI 笔刷应该帮用户整理标记后的思路，但不能替用户改写原文或替用户决定结论。输出到 Obsidian 时要明确保留原文证据、手写判断和 AI 归纳三层。',
              status: 'accepted',
              render_mode: 'margin_note',
              visual_bbox: [0.14, 0.28, 0.64, 0.13],
              created_at: at,
              updated_at: at,
            }],
          },
          {
            object_id: 'blk_ux_review_later',
            text: '表格中的 UX 方法分类可以作为后续产品评估框架，但需要回看原文上下文，确认每一类方法的适用边界。',
            source_anchor: {
              quote: '五大类 UX 方法需要结合具体场景选择，不能把方法分类直接当成产品功能清单。',
              object_refs: ['tl_ux_61', 'tl_ux_62', 'tl_ux_63'],
            },
            projection: {
              block_id: 'blk_ux_review_later',
              kind: 'paragraph',
              region: 'editable',
              page_index: 6,
              page_id: `pg_${DOC_ID}_7`,
              knowledge_object_ids: ['ko_reading_review_later_method_table'],
            },
            annotations: [{
              ko_id: 'ko_reading_review_later_method_table',
              kind: 'review_later',
              title: '待回看：核对 UX 方法分类和适用边界',
              body_md: '这个标记适合进入“待回看”：下次需要回到原文表格，确认哪些 UX 方法能直接变成 InkLoop 的阅读验收项，哪些只是研究分类，不能直接产品化。',
              status: 'inbox',
              render_mode: 'stroke_only',
              visual_bbox: [0.12, 0.36, 0.72, 0.12],
              visual_strokes: [stroke([[0.08, 0.18], [0.18, 0.12], [0.32, 0.18], [0.42, 0.13], [0.58, 0.2], [0.72, 0.14], [0.88, 0.2]])],
              created_at: at,
              updated_at: at,
            }],
          },
        ],
        nodes: [],
      },
    },
    origin: { device_id: 'm103-demo-sim', client_id: 'codex-seed', session_id: 'reading-demo' },
    status: 'pending',
    dedupe_key: `${DOC_ID}:runtime.bootstrap:reading-demo:${id}`,
    created_at: at,
    updated_at: at,
  };
}

async function pushRuntimeEvent(event: RuntimeSyncEvent): Promise<void> {
  const session = await authorizeLocalDevice();
  const response = await fetch(`${CLOUD_HUB.replace(/\/+$/, '')}/v1/runtime/events:push`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.session_token}`,
      'x-inkloop-tenant-id': session.tenant_id,
      'x-inkloop-user-id': session.user_id,
      'x-inkloop-device-id': session.device_id,
    },
    body: JSON.stringify({
      schema_version: 'inkloop.runtime_sync_batch.v1',
      device_id: 'm103-demo-sim',
      events: [event],
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`runtime push HTTP ${response.status}: ${text}`);
  console.log(text);
}

async function authorizeLocalDevice(): Promise<DeviceSession> {
  const base = CLOUD_HUB.replace(/\/+$/, '');
  const create = await fetch(`${base}/api/inkloop/auth/device-authorizations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      install_id: 'm103-demo-sim',
      device_label: 'M103 reading demo simulator',
      platform: 'codex-e2e',
      requested_scopes: ['device_session'],
    }),
  });
  const flow = await create.json() as LocalAuthFlow;
  if (!create.ok || !flow.flow_id || !flow.poll_token || !flow.qr_payload) {
    throw new Error(`local auth create failed HTTP ${create.status}: ${JSON.stringify(flow)}`);
  }
  const scan = await fetch(flow.qr_payload);
  if (!scan.ok) throw new Error(`local auth scan failed HTTP ${scan.status}: ${await scan.text()}`);
  const status = await fetch(`${base}/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.flow_id)}/status?poll_token=${encodeURIComponent(flow.poll_token)}`);
  const payload = await status.json() as { status?: string; session?: DeviceSession; error?: string };
  if (!status.ok || payload.status !== 'authorized' || !payload.session?.session_token) {
    throw new Error(`local auth status failed HTTP ${status.status}: ${JSON.stringify(payload)}`);
  }
  await fetch(`${base}/api/inkloop/auth/device-authorizations/${encodeURIComponent(flow.flow_id)}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poll_token: flow.poll_token }),
  });
  if (payload.session.tenant_id !== TENANT_ID || payload.session.user_id !== USER_ID) {
    console.log(`session namespace: ${payload.session.tenant_id}/${payload.session.user_id}`);
  }
  return payload.session;
}

async function main(): Promise<void> {
  await cleanExistingDemoDocument();
  await pushRuntimeEvent(demoEvent());
  console.log(`seeded reading demo output for ${DOC_ID}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
