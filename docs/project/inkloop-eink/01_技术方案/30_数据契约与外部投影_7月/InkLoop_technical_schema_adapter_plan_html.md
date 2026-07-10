# InkLoop_technical_schema_adapter_plan

InkLoop 下一步技术方案：Core Schema 与 Adapter 架构

InkLoop · Technical Plan v0.1 · Core Schema / Adapter / Notion / Obsidian

# 下一步技术方案：以 InkLoop Core Schema 为真相源，以 Adapter 做外部投影

核心判断：不要让 Notion、Obsidian、Web、桌面端、墨水屏端各自长出一套数据结构。InkLoop 的真相源应该是统一的事件账本和知识对象；Adapter 只负责把这些对象映射到外部工具。
Event-sourced LedgerCanonical Knowledge ObjectAdapter InterfaceNotionObsidianOne-way first

## 0. 一句话方案

InkLoop Core 是系统真相源；Notion/Obsidian 是用户工作流里的外部投影。 v1 先做单向、安全、可审计的 export / publish；v2 再做有限 pull-back，例如标签、状态、任务完成情况。

Input / Device / PDF
 → InkLoop Ledger: documents, strokes, marks, ai_turns
 → Knowledge Builder: quote / annotation / AI note / task / summary
 → Adapter Renderer: markdown / notion-blocks / json
 → Adapter Transport: local fs / Obsidian plugin / Notion API / cloud sync

## 1. 系统分层

层职责不应该做什么

InkLoop Capture采集笔迹、触控、PDF 对象、截图、扫描件、网页剪藏。不直接写 Notion/Obsidian。

InkLoop Evidence生成 HMP、MarkGraph、InferenceView，确定用户标注命中了什么。不关心外部 App 格式。

InkLoop Ledgerappend-only 账本，保存文档、marks、ai_turns、导出记录。不把外部 App 当真相源。

Knowledge Builder把 mark / ai_turn / excerpt 变成可导出的知识对象。不处理 OAuth、文件写入。

Adapter Layer将 KnowledgeObject 渲染并写入 Notion、Obsidian、Markdown、Zotero 等。不修改 Core Schema。

Sync Engine队列、重试、冲突、速率限制、审计、权限。不参与阅读交互主链路。

## 2. Core Schema：先统一“思考对象”

当前项目已经有 Stroke、AnnotationEvent、Mark、HMP、MarkGraph、InferenceView、ScreenOverlay 和 IndexedDB 账本。下一步应该把这些本地类型升级成跨端稳定 schema。

### 2.1 Ledger Envelope：所有写入都套一层事件信封
type LedgerEventKind =
 | 'document.created'
 | 'document.updated'
 | 'mark.created'
 | 'mark.tombstoned'
 | 'ai_turn.created'
 | 'ai_turn.superseded'
 | 'knowledge_object.created'
 | 'knowledge_object.updated'
 | 'external_binding.upserted'
 | 'sync_job.created'
 | 'sync_job.completed'
 | 'sync_job.failed';

interface LedgerEvent<T> {
 event_id: string; // ulid
 kind: LedgerEventKind;
 schema_version: 'inkloop.ledger.v1';
 actor: { user_id: string; device_id: string; app: 'paper'|'desktop'|'mobile'|'web'|'server' };
 workspace_id: string;
 entity_id: string;
 entity_type: string;
 parent_event_id?: string;
 created_at: string; // ISO timestamp
 idempotency_key: string; // 防止重复同步
 payload_hash: string;
 payload: T;
}
### 2.2 Document / Page / SurfaceObject
interface InkDocument {
 document_id: string; // doc_ + content hash prefix
 workspace_id: string;
 title: string;
 source_type: 'pdf'|'web'|'image'|'scan'|'epub'|'markdown'|'external';
 source_uri?: string;
 file_asset_id?: string;
 content_hash: string;
 lang?: string;
 page_count?: number;
 created_at: string;
 updated_at: string;
}

interface DocumentPage {
 page_id: string; // `${document_id}:p${page_index}`
 document_id: string;
 page_index: number;
 width_pt?: number;
 height_pt?: number;
 text_layer_version: string;
 object_index_hash: string;
}

interface SurfaceObject {
 object_id: string; // char/run/image/stable id
 page_id: string;
 kind: 'char'|'text_run'|'line'|'image_region'|'table'|'ui_region';
 bbox: [number, number, number, number]; // normalized [x,y,w,h]
 text?: string;
 reading_order?: number;
 parent_object_id?: string;
}
### 2.3 Mark / HMP / AI Turn
interface InkMark {
 mark_id: string;
 document_id: string;
 page_id: string;
 event_ids: string[];
 strokes: Stroke[];
 bbox: [number, number, number, number];
 feature_type: 'markup'|'handwriting'|'drawing'|'mixed'|'unknown';
 gesture_type?: 'circle'|'underline'|'arrow'|'tap_region'|'freehand';
 hmp: HmpEvidence;
 marked_text?: string;
 created_at: string;
 is_tombstone?: boolean;
}

interface HmpEvidence {
 hmp_id: string;
 mode: 'anchored'|'self_content'|'mixed'|'unknown';
 object_hint: 'text'|'image_region'|'blank'|'diagram'|'unknown';
 object_refs: string[];
 anchor_bbox: [number, number, number, number];
 text_hint?: string;
 handwriting?: { text?: string; confidence?: number };
 crop_asset_id?: string;
 evidence_version: string;
}

interface AiTurn {
 ai_turn_id: string;
 document_id: string;
 session_id: string;
 input_mark_ids: string[];
 inference_view: InferenceView;
 reply_markdown: string;
 overlay: ScreenOverlay;
 model: string;
 prompt_hash: string;
 created_at: string;
 supersedes?: string;
}
### 2.4 KnowledgeObject：Adapter 的唯一输入

外部集成不要直接拿 Mark 或 AiTurn。它们应该拿更稳定的 KnowledgeObject。
type KnowledgeKind =
 | 'source_document'
 | 'excerpt'
 | 'annotation'
 | 'ai_note'
 | 'qa'
 | 'summary'
 | 'task'
 | 'decision'
 | 'risk'
 | 'question'
 | 'concept'
 | 'collection';

interface KnowledgeObject {
 ko_id: string;
 kind: KnowledgeKind;
 title: string;
 body_md: string; // canonical body for Markdown-like sinks
 source: {
 document_id: string;
 document_title: string;
 page_id?: string;
 page_index?: number;
 object_refs?: string[];
 anchor_bbox?: [number, number, number, number];
 quote?: string;
	 inkloop_uri: string; // inkloop://doc/.../page/.../anchor/...
	 };
 source_refs?: Array<{ ref_type: 'document' | 'meeting_mark' | 'project_memory'; [key: string]: unknown }>;
	 relations: Array<{
 type: 'generated_from'|'answers'|'cites'|'near'|'same_topic'|'supersedes';
 target_id: string;
 }>;
 tags: string[];
 status: 'inbox'|'accepted'|'edited'|'dismissed'|'exported'|'archived';
 privacy: 'local_only'|'private_cloud'|'export_allowed'|'team_shared';
 created_at: string;
 updated_at: string;
 content_hash: string;
}

## 3. Adapter 架构

Adapter = Renderer + Transport + Binding + Sync Policy。 Notion 和 Obsidian 的核心差异不应该污染 Core Schema。
interface AdapterManifest {
 provider: 'notion'|'obsidian'|'markdown'|'zotero'|'readwise'|'google_drive';
 display_name: string;
 direction: 'push'|'pull'|'bidirectional';
 auth: 'oauth'|'api_key'|'local_fs'|'plugin_token'|'none';
 capabilities: {
 create: boolean;
 update: boolean;
 append: boolean;
 delete: boolean;
 read: boolean;
 deep_link: boolean;
 rich_blocks: boolean;
 backlinks: boolean;
 attachments: boolean;
 };
}

interface ExportAdapter<Config, RemotePayload> {
 manifest: AdapterManifest;
 validateConfig(config: Config): Promise<ValidationResult>;
 ensureTarget(config: Config): Promise<AdapterTarget>;
 render(object: KnowledgeObject, ctx: RenderContext): Promise<RemotePayload>;
 upsert(object: KnowledgeObject, payload: RemotePayload, binding?: ExternalBinding): Promise<ExternalBinding>;
 delete?(binding: ExternalBinding): Promise<void>;
 pullChanges?(cursor?: string): Promise<PullResult>;
}

interface ExternalBinding {
 binding_id: string;
 provider: string;
 ko_id: string;
 remote_id: string;
 remote_url?: string;
 remote_rev?: string;
 remote_path?: string;
 mapping_version: string;
 content_hash: string;
 last_synced_at: string;
 sync_state: 'active'|'remote_changed'|'conflict'|'deleted'|'error';
}
### 3.1 Adapter 类型

类型例子优先级说明

Export AdapterNotion、Obsidian、Markdown、ReadwiseP0把 InkLoop 知识对象投影到外部工作流。

Import Adapter手机分享、Web Clipper、Google Drive、Obsidian 文件夹 watchP1把外部资料带回 InkLoop。

Device AdapterEPD、笔输入、OCR、本地向量库P0/P1面向硬件端，不和 Notion/Obsidian 混在一起。

AI Adapter云端 LLM、本地 OCR、Embedding、RerankP0统一模型调用、审计和成本。

## 4. Notion Adapter v1

定位：团队/项目工作流里的“结构化知识卡片”。Notion 适合给每条 excerpt / annotation / ai_note 建 page，并用属性管理状态、标签、来源、文档、页码。

### 4.1 选定映射

InkLoopNotion说明

KnowledgeObjectData source row / Page每个 KO 一页，便于属性过滤和团队协作。

titleTitle property例如：AI Note · Paper Title p.12。

kindSelectexcerpt / annotation / ai_note / qa / task。

tagsMulti-select同步 InkLoop 标签。

statusStatusinbox / accepted / edited / exported / archived。

source.quoteQuote block原文引用。

body_mdParagraph / Heading / Bulleted blocksAI 旁注和用户笔记。

inkloop_uriURL property + link block回跳 InkLoop 原文现场。

object_refs / anchor_bboxHidden metadata block or rich_text property不让 Notion 理解坐标，只保留回链。

### 4.2 Notion 页面模板
# {{title}}

Callout: Open in InkLoop → {{inkloop_uri}}

## Source quote
> {{source.quote}}

## InkLoop note
{{body_md}}

## Context
- Document: {{document_title}}
- Page: {{page_index}}
- Object refs: {{object_refs}}
- Exported at: {{last_synced_at}}

## Related
- Generated from: {{mark_ids}}
- Answers: {{question}}
### 4.3 Notion v1 同步策略

- v1 只做 push / upsert，不做全文双向同步。

- InkLoop 为内容真相源；Notion 允许用户改 status、tags、assignee 这类外部工作流字段。

- 每个 Notion page 存 `InkLoop ID` 和 `content_hash`，用于幂等更新。

- 更新时优先 append 一个 “Updated from InkLoop at …” 受控 section；后续再做精细 block patch。

- 如果远端页面内容被用户改过，标记 `remote_changed`，不直接覆盖。

## 5. Obsidian Adapter v1

定位：个人知识库里的“本地 Markdown 归档”。Obsidian 适合本地-first、Markdown-first、长期可迁移。

### 5.1 三种 Transport

Transport适合阶段说明

Local File SystemP0 桌面端用户选择 Vault 文件夹，InkLoop 直接写 Markdown 文件。最快落地。

Obsidian PluginP1提供更可靠的 vault API、设置页、命令、回链、增量更新。

Obsidian URIP0 辅助适合打开/创建/追加和 deep link，不适合可靠后台同步。

### 5.2 Markdown 文件结构
---
inkloop_id: ko_01J...
inkloop_kind: ai_note
document_id: doc_abcd1234
document_title: "Attention Is All You Need"
page: 12
object_refs:
 - obj_p12_0345
anchor_bbox: [0.12, 0.34, 0.18, 0.04]
inkloop_uri: "inkloop://doc/doc_abcd1234/page/12?anchor=..."
source_hash: "sha256:..."
status: exported
tags: [inkloop, reading, transformer]
created: 2026-06-25T12:00:00Z
updated: 2026-06-25T12:00:00Z
---

# AI Note · Attention Is All You Need · p12

> [!quote] Source quote
> Scaled dot-product attention ...

> [!note] InkLoop
> 这里的关键点是 Q/K/V 的角色分离：K 用来匹配，V 才是被聚合的信息。

## Context
- Source: [[Attention Is All You Need]]
- Page: 12
- Open in InkLoop: [link](inkloop://doc/doc_abcd1234/page/12?anchor=...)

## Related
- Generated from: mark_...
- AI turn: ai_...
### 5.3 文件命名
InkLoop/
 Sources/
 Attention Is All You Need.md
 Notes/
 2026-06-25 AI Note - Attention Is All You Need p12.md
 Excerpts/
 Attention Is All You Need p12 - scaled dot-product attention.md
 Tasks/
 2026-06-25 Review transformer positional encoding.md
 _assets/
 doc_abcd_p12_anchor.png
### 5.4 Obsidian v1 同步策略

- v1 默认 append-only：InkLoop 生成新 Markdown 或更新受控区块。

- 前后用 HTML comment 包裹受控区块，避免覆盖用户在文件里自由写的内容。

- 如果用户修改受控区块，生成 conflict note，不强行覆盖。

- 利用 frontmatter 存 `inkloop_id`、`source_hash`、`status`、`tags`，方便 Dataview/搜索。
<!-- inkloop:begin ko_01J... hash=sha256:... -->
... InkLoop controlled section ...
<!-- inkloop:end ko_01J... -->

## 6. Sync Engine：先单向，再有限双向

阶段能力风险控制

v0.1手动导出单条 / 当前文档 / 当前 session。用户可预览 payload。

v0.2自动导出 accepted AI notes / tasks。只导出 `privacy=export_allowed`。

v0.3Notion/Obsidian bindings、hash、幂等重试。不覆盖远端用户改动。

v1.0状态和标签 pull-back。只允许外部更新 metadata，不允许重写 mark/anchor。

v2.0外部内容导入为 InkLoop docs/clips。导入内容作为新资料，不作为原始标注真相源。

interface SyncJob {
 job_id: string;
 provider: string;
 direction: 'push'|'pull';
 ko_ids: string[];
 priority: 'interactive'|'background';
 status: 'queued'|'running'|'succeeded'|'failed'|'blocked';
 attempts: number;
 last_error?: string;
 created_at: string;
 updated_at: string;
}

interface SyncPolicy {
 content_authority: 'inkloop'|'remote'|'manual';
 metadata_authority: 'inkloop'|'remote'|'merge';
 conflict_strategy: 'skip'|'append_new_version'|'ask_user'|'inkloop_wins';
 privacy_filter: Array<'export_allowed'|'team_shared'>;
}

## 7. API 正式版
POST /api/v1/knowledge/build
 input: { document_id, mark_ids?, ai_turn_ids?, mode }
 output: { knowledge_objects: KnowledgeObject[] }

GET /api/v1/adapters
 output: AdapterManifest[]

POST /api/v1/adapters/:provider/connect
 input: oauth_code | local_path | plugin_token
 output: ExternalAccount

POST /api/v1/adapters/:provider/preview
 input: { ko_ids, target }
 output: { rendered_preview, warnings }

POST /api/v1/adapters/:provider/export
 input: { ko_ids, target, policy }
 output: { sync_job_id }

GET /api/v1/sync/jobs/:job_id
 output: SyncJob + logs

POST /api/v1/adapters/:provider/pull
 input: { account_id, cursor? }
 output: { changes, next_cursor }

## 8. 隐私与审计

默认不要把原始笔迹、裁图、完整 PDF 上传到外部 App。 Adapter 出口必须有 preview、最小化和审计。

- KnowledgeObject 默认只含 quote、AI note、page、document title、InkLoop deep link。

- 原始 strokes / crop / full page image 默认不导出，除非用户显式打开。

- 每次 export 存 `payload_hash`、`payload_preview`、`provider`、`remote_id`。

- 外部 OAuth token 存系统 Keychain / Android Keystore / server secrets，不进入普通业务表。

- 每个 Adapter 有 capability scope：Notion 只拿选定 workspace/page/data source，Obsidian 只拿用户指定 vault。

## 9. 研发路线图

里程碑交付物验收线

Sprint 1Zod/TypeScript Core Schema；Ledger Envelope；本地 store migration。现有 Web demo 可用；marks/ai_turns 可按新 schema 折叠恢复。

Sprint 2Knowledge Builder；Markdown renderer；本地 Markdown export。从一次 AI 旁注生成 KO，并导出为 Markdown。

Sprint 3Obsidian FS Adapter；frontmatter；controlled section；deep link。可把 accepted note 同步到指定 vault，重复同步不重复写。

Sprint 4Notion OAuth；target 选择；Notion page/data source mapping。可将 KO 创建为 Notion page，保留 InkLoop ID 与 source URL。

Sprint 5Sync jobs、bindings、retry、conflict 状态。断网/重试/远端修改均可审计，不丢账本。

Sprint 6metadata pull-back：status/tags/tasks。Notion/Obsidian 里改状态，InkLoop 能显示外部状态。

## 10. 现在要拍板的 7 个技术决策

- Source of truth：InkLoop Ledger，而不是 Notion / Obsidian。

- Adapter 输入：只吃 KnowledgeObject，不直接吃 Mark/AiTurn。

- 同步方向：v1 单向 push，v2 有限 pull-back。

- Obsidian 优先实现：桌面端 Local FS Adapter，比插件更快；插件作为 P1。

- Notion 优先实现：Page/Data source projection，不做块级复杂双向编辑。

- 隐私默认：不导出 strokes/crops/full page image，导出前 preview。

- 冲突策略：外部内容改动不覆盖，生成 `remote_changed` 或 versioned append。

Prepared for InkLoop technical planning · 2026-06-25
