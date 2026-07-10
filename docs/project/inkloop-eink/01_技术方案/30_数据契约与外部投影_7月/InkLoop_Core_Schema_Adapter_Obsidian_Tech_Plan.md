# InkLoop Core Schema & Adapter 技术方案 v1.0

> 版本：v1.0  
> 日期：2026-06-26  
> 目标读者：前端、客户端、后端、AI pipeline、同步系统、插件/集成工程师  
> 方案重心：**Core Schema 如何成为真相源，Adapter 如何只做外部投影，Obsidian 如何形成自洽、可恢复、可冲突处理的同步闭环。**

---

## 0. 一句话结论

InkLoop 下一阶段不要先做“导出到 Obsidian”的按钮，而要先固化四层架构：

```text
InkLoop Ledger / Core Schema  = 运行时事实和事件真相源
Cloud Hub Source Library      = 源文件身份、对象存储和设备 manifest
KnowledgeObject               = 可导出的语义对象
Adapter                       = 外部 App 的投影与同步层
```

Obsidian Adapter 的 v1 落地方式要求是：

```text
桌面端 InkLoop App 直接写入 Obsidian Vault 文件夹
+ Markdown frontmatter 记录 inkloop_id / content_hash / status / source anchor
+ 受控区块 controlled section 只更新 InkLoop 自己生成的内容
+ ExternalBinding 记录 InkLoop 对应到哪个 Markdown 文件
+ Obsidian URI 只负责打开文件，不负责可靠写入
```

v1.5 再做 Obsidian 插件：

```text
插件运行在 Obsidian 内部
使用 Obsidian Vault API / FileManager API 操作文件
监听 rename / modify / delete
回传有限状态：status、tags、task done、remote path
不回传正文、不回传笔迹、不回传坐标、不做全量双向同步
```

---

## 1. 当前系统事实与设计约束

### 1.1 已有链路

当前 InkLoop 前端 demo 已经形成非常清晰的数据流：

```text
PointerEvent
→ Stroke
→ AnnotationEvent
→ Mark
→ HMP
→ Session
→ MarkGraph
→ InferenceView
→ /api/chat
→ ScreenOverlay
→ whisper / reader note
→ IndexedDB
```

这个链路背后的核心判断是：用户不是在“问聊天机器人”，而是在“用笔在原文上表达注意力”。所以系统必须保存：

1. 用户画了什么。
2. 用户画在哪里。
3. 用户画到哪些原文对象。
4. AI 依据哪些对象回答。
5. AI 回答如何贴回原文现场。
6. 用户后来接受、编辑、忽略了什么。

### 1.2 对 Schema 和 Adapter 的约束

现有系统有几个不能破坏的原则：

1. **模型不负责生成坐标。** 坐标、对象引用、锚点由前端确定，模型只读上下文并生成文字。
2. **全程归一化坐标。** 页面放大、缩小、换设备，不能破坏原文锚点。
3. **HMP 只放事实。** 它回答“命中了什么、是什么手势、有没有 OCR/手写结果”，不放 AI 主观判断。
4. **账本是真相源。** `marks` 和 `ai_turns` 是 append-only 账本；删除用 tombstone，编辑/忽略用 supersedes。
5. **跨端同步不能只同步文件，也不能把所有同步都塞进 Runtime sync。** 源文件字节进入 Cloud Hub Source Library；Runtime sync 同步的是文档对象、笔迹、AI 旁注、锚点、用户决策和知识对象增量。
6. **外部 App 不是 InkLoop 真相源。** Obsidian / Notion / Readwise / Zotero 都是 projection，不是原始标注和 AI 回屏的源头。

---

## 2. 总体架构

### 2.1 逻辑分层

```text
┌────────────────────────────────────────────────────────────┐
│                        InkLoop Apps                         │
│   Paper / Desktop / Mobile / Web / Browser Extension         │
└───────────────────────┬────────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────┐
│                 Cloud Hub Source Library                    │
│ SourceBlob / LibraryItem / DocumentRecord / DeviceManifest   │
└───────────────────────┬────────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────┐
│                    Capture & Evidence                       │
│ Stroke / AnnotationEvent / HMP / SurfaceObject / OCR / HWR   │
└───────────────────────┬────────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────┐
│                      InkLoop Ledger                         │
│ Append-only events / Folded materialized views / Audit       │
└───────────────────────┬────────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────┐
│                    Knowledge Builder                        │
│ Mark + AiTurn + Source Anchor → KnowledgeObject              │
└───────────────────────┬────────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────────┐
│                    Adapter Framework                        │
│ Manifest / Renderer / Transport / Binding / SyncJob          │
└───────────────┬───────────────┬───────────────┬────────────┘
                │               │               │
                ▼               ▼               ▼
          Obsidian          Notion          Markdown / Zotero
          Adapter           Adapter         / Readwise / Drive
```

### 2.2 运行时部署

| 模块 | Paper 墨水屏 | Desktop | Mobile | Web | Cloud |
|---|---:|---:|---:|---:|---:|
| Stroke capture | 强 | 中 | 弱 | 中 | 无 |
| HMP / 几何取证 | 强 | 强 | 中 | 强 | 可补算 |
| OCR / 手写识别 | 本地优先 | 本地/云 | 云优先 | 云优先 | 强 |
| Source Library cache | 必须 | 必须 | 必须 | IndexedDB / Cache | 主存储 |
| Source object storage | 上传/下载 | 上传/下载 | 上传/下载 | 上传/下载 | 必须 |
| Ledger local cache | 必须 | 必须 | 必须 | IndexedDB | 主存储 |
| Knowledge Builder | 本地可做 | 本地可做 | 云端可做 | 云端可做 | 必须 |
| Adapter renderer | 可做 | 必须 | 部分 | 部分 | 必须 |
| Obsidian FS Adapter | 不做 | P0 | 不做 | 不做 | 不做 |
| Obsidian Plugin Bridge | 不直接 | P1 | P1 | 不做 | P1 服务端配合 |

### 2.3 包结构

```text
packages/
  schema/
    common.ts
    document.ts
    source-library.ts
    surface-object.ts
    stroke.ts
    annotation-event.ts
    hmp.ts
    mark.ts
    mark-graph.ts
    inference-view.ts
    ai-turn.ts
    screen-overlay.ts
    knowledge-object.ts
    ledger-event.ts
    external-binding.ts
    sync.ts
    audit.ts
    validators.ts

  ledger/
    event-store.ts
    fold-document.ts
    fold-mark.ts
    fold-ai-turn.ts
    fold-knowledge-object.ts
    fold-binding.ts
    migrations.ts
    hash.ts

  knowledge-builder/
    build-from-mark.ts
    build-from-ai-turn.ts
    build-from-session.ts
    build-source-document.ts
    normalize-quote.ts
    relation-builder.ts

  adapter-core/
    manifest.ts
    adapter.ts
    render-context.ts
    render-plan.ts
    binding.ts
    sync-policy.ts
    errors.ts
    preview.ts
    diff.ts

  adapters/
    markdown/
      markdown-renderer.ts
      frontmatter.ts
      controlled-section.ts
      slug.ts

    obsidian-fs/
      adapter.ts
      vault-target.ts
      file-resolver.ts
      obsidian-uri.ts
      pull-frontmatter.ts

    obsidian-plugin-shared/
      protocol.ts
      plugin-message.ts
      plugin-renderer.ts

    notion/
      adapter.ts
      notion-renderer.ts
      notion-binding.ts

  sync-engine/
    queue.ts
    worker.ts
    reconciler.ts
    retry.ts
    rate-limit.ts
    conflict.ts
    audit.ts
```

---

## 3. 关键技术决策

| 编号 | 决策 | 原因 |
|---|---|---|
| D1 | `LedgerEvent` 是跨端同步的最低层真相源 | 任何端写入都可审计、可重放、可合并 |
| D2 | `KnowledgeObject` 是 Adapter 唯一输入 | 避免每个外部系统理解 Stroke/HMP/MarkGraph |
| D3 | Adapter 不改 Core 对象，只追加 Sync / Binding 事件 | 防止外部 App 反向污染真相源 |
| D4 | v1 Adapter 只做单向 push + 有限 pullback | 先保证不丢、不重、不覆盖，再谈双向 |
| D5 | Obsidian v1 使用本地文件系统写 Markdown | 最快落地，不要求用户先安装插件 |
| D6 | Obsidian Plugin 是 v1.5 | 用于可靠 rename/modify/delete 监听和移动端支持 |
| D7 | Obsidian URI 只做打开，不做写入 | URI 无法返回稳定 receipt / content_hash / conflict 状态 |
| D8 | Markdown 内使用 frontmatter + controlled section | 可读、可迁移、可恢复、可避免覆盖用户内容 |
| D9 | 不导出 raw strokes / 完整 PDF / 完整页面截图 | 隐私最小化，外部 App 只需要知识投影 |
| D10 | 路径不是远端身份，`inkloop_id` 才是远端身份 | Obsidian 用户经常移动/重命名文件 |

---

## 4. 命名、ID、时间、坐标、版本

### 4.1 ID 规范

使用 UUIDv7 或 ULID，并加业务前缀。前缀不是安全边界，只是提高可读性。

```ts
type InkId = `${string}_${string}`;

// examples
doc_01JZ7D4BPC9M9G3NVXFX5F6EJH
page_01JZ7D4C1QMYPS7YH4D6V6R1BA
obj_01JZ7D4K8A0K6E7TKK2MSB6Z5Z
stroke_01JZ7D4RFS4WM8TY1T81XEF4CF
mark_01JZ7D4V7TDQR2C0DB4D9N20TC
aiturn_01JZ7D52KKF1N9NR86RDP77E2D
ko_01JZ7D5E7WJK4F5NTAT9QCJBW2
bind_01JZ7D5KHZ0P70ZD8CD2EJ7VHY
syncjob_01JZ7D5QG86D0QHXFVX11WJY2T
```

### 4.2 时间

所有持久化时间使用 ISO 8601 UTC：

```ts
type ISODateTime = string; // new Date().toISOString()
```

客户端展示时再转换本地时区。

### 4.3 坐标

```ts
type NormBBox = [x: number, y: number, w: number, h: number];
type NormPoint = { x: number; y: number };
```

规则：

1. 坐标范围默认 `[0, 1]`。
2. `x/y` 相对于 page content box，不包含右侧 AI gutter。
3. `w/h` 不能为负。
4. 允许少量越界容差，例如局部裁图外扩后 `-0.02 ~ 1.04`，但持久化前要 clamp 或记录 `crop_margin`。
5. 外部 Adapter 不理解坐标，只保存原值和回链。

### 4.4 Schema 版本

每类对象带独立版本，不要只用全局版本。

```ts
const SCHEMA = {
  ledger: 'inkloop.ledger.v1',
  document: 'inkloop.document.v1',
  surfaceObject: 'inkloop.surface_object.v1',
  hmp: 'inkloop.hmp.v1',
  mark: 'inkloop.mark.v1',
  aiTurn: 'inkloop.ai_turn.v1',
  knowledgeObject: 'inkloop.knowledge_object.v1',
  adapter: 'inkloop.adapter.v1',
  binding: 'inkloop.external_binding.v1',
};
```

### 4.5 Hash 规范

所有 hash 统一：

```ts
type Sha256 = `sha256:${string}`;
```

三类 hash 必须区分：

| 字段 | 对象 | 用途 |
|---|---|---|
| `payload_hash` | LedgerEvent payload | 幂等与审计 |
| `content_hash` | KnowledgeObject 正文 + 来源 + 关系 | 判断是否需要重新导出 |
| `render_hash` | Provider-specific rendered payload | 判断远端受控区块是否被改 |
| `remote_hash` | 远端读取到的受控区块内容 | 冲突检测 |
| `asset_hash` | 文件/图片/PDF/crop | 资产去重 |

Hash 输入必须 canonicalize：

```ts
function canonicalJson(value: unknown): string {
  // 递归按 key 排序；移除 undefined；时间字段保留 ISO 字符串。
}
```

---

## 5. Core Schema

本节给出 TypeScript 形态。真实工程里使用 Zod / TypeBox 生成 runtime validator，并导出 JSON Schema 给服务端和客户端共用。

### 5.1 Common Types

```ts
export type ISODateTime = string;
export type Sha256 = `sha256:${string}`;
export type NormBBox = [number, number, number, number];

export type AppSurface = 'paper' | 'desktop' | 'mobile' | 'web' | 'server' | 'obsidian_plugin';

export interface ActorRef {
  user_id: string;
  workspace_id: string;
  device_id?: string;
  app: AppSurface;
}

export interface EntityRef {
  entity_type:
 | 'document'
 | 'source_blob'
 | 'library_item'
 | 'document_page'
 | 'surface_object'
 | 'stroke'
 | 'annotation_event'
 | 'mark'
 | 'ai_turn'
 | 'knowledge_object'
 | 'external_binding'
 | 'sync_job';
  entity_id: string;
}

export interface AssetRef {
  asset_id: string;
  asset_kind: 'source_blob' | 'pdf' | 'image' | 'crop' | 'thumbnail' | 'audio' | 'json';
  mime_type: string;
  byte_size?: number;
  content_hash: Sha256;
  uri?: string;
}
```

---

### 5.2 Document Schema

```ts
export type DocumentSourceType =
 | 'pdf'
 | 'epub'
 | 'web'
 | 'image'
 | 'scan'
 | 'markdown'
 | 'external';

export interface InkDocument {
  schema_version: 'inkloop.document.v1';

  document_id: string;
  workspace_id: string;
  owner_user_id: string;

  title: string;
  subtitle?: string;
  authors?: string[];
  lang?: string;

  source_type: DocumentSourceType;
  source_uri?: string;
  imported_from?: {
    provider?: 'local_file' | 'mobile_share' | 'web_clip' | 'google_drive' | 'onedrive' | 'dropbox' | 'zotero' | 'obsidian' | 'notion';
    external_id?: string;
    external_url?: string;
    captured_at: ISODateTime;
  };

  file_asset_id?: string;
  content_hash: Sha256;

  page_count?: number;
  word_count?: number;
  text_layer_status: 'none' | 'partial' | 'ready' | 'ocr_required' | 'failed';

  privacy: 'local_only' | 'private_cloud' | 'team_shared';

  created_at: ISODateTime;
  updated_at: ISODateTime;
  deleted_at?: ISODateTime;
}
```

### 5.2.1 Cloud Hub Source Library Schema

Cloud Hub Source Library 只管理源文件身份、云端对象存储和设备副本状态，不承接运行时标注事件的合并。它的目标是让 Web/桌面端导入一次，墨水屏和其他端能在 Library 里看到同一个源文件，并按需下载到本地。

```ts
export interface SourceBlob {
  schema_version: 'inkloop.source_blob.v1';

  source_blob_id: string;
  workspace_id: string;
  owner_user_id: string;

  mime_type: string;
  byte_size: number;
  content_hash: Sha256;
  storage_uri: string;
  encryption_key_ref?: string;

  created_at: ISODateTime;
  deleted_at?: ISODateTime;
}

export type LibraryAvailability =
 | 'cloud_only'
 | 'downloading'
 | 'downloaded'
 | 'pinned'
 | 'uploading'
 | 'conflict'
 | 'failed';

export interface LibraryItem {
  schema_version: 'inkloop.library_item.v1';

  library_item_id: string;
  document_id: string;
  source_blob_id: string;
  workspace_id: string;
  owner_user_id: string;

  title: string;
  availability: LibraryAvailability;
  last_opened_at?: ISODateTime;
  pinned: boolean;
  sync_error?: {
    code: string;
    message: string;
    happened_at: ISODateTime;
  };

  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface DeviceManifest {
  schema_version: 'inkloop.device_manifest.v1';

  device_id: string;
  user_id: string;
  workspace_id: string;

  local_documents: Array<{
    document_id: string;
    source_blob_id: string;
    availability: Exclude<LibraryAvailability, 'cloud_only'>;
    local_path?: string;
    content_hash: Sha256;
    last_verified_at: ISODateTime;
  }>;

  event_cursor?: string;
  library_cursor?: string;
  updated_at: ISODateTime;
}
```

### 5.3 Page Schema

```ts
export interface DocumentPage {
  schema_version: 'inkloop.document_page.v1';

  page_id: string;
  document_id: string;
  page_index: number; // 0-based

  width_pt?: number;
  height_pt?: number;
  rotation?: 0 | 90 | 180 | 270;

  text_layer_version?: string;
  object_index_hash?: Sha256;

  render_cache?: {
    thumbnail_asset_id?: string;
    page_image_asset_id?: string;
  };

  created_at: ISODateTime;
  updated_at: ISODateTime;
}
```

### 5.4 SurfaceObject Schema

`SurfaceObject` 是跨端锚定的基础。Adapter 不需要理解它，但会把 object refs 原样保存，用于回跳 InkLoop。

```ts
export type SurfaceObjectKind =
 | 'char'
 | 'text_run'
 | 'line'
 | 'paragraph'
 | 'image_region'
 | 'table_region'
 | 'formula_region'
 | 'diagram_region'
 | 'blank_region'
 | 'ui_region';

export interface SurfaceObject {
  schema_version: 'inkloop.surface_object.v1';

  object_id: string;
  document_id: string;
  page_id: string;
  page_index: number;

  kind: SurfaceObjectKind;
  bbox: NormBBox;

  text?: string;
  normalized_text?: string;
  reading_order?: number;

  parent_object_id?: string;
  children_count?: number;

  source: 'pdf_text_layer' | 'ocr' | 'vlm' | 'manual' | 'reflow';
  confidence?: number;
}
```

### 5.5 Stroke Schema

```ts
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'hand';

export interface StrokePoint {
  x: number;
  y: number;
  t: number;        // ms since stroke start
  pressure?: number; // 0..1
  tilt_x?: number;
  tilt_y?: number;
  twist?: number;
}

export interface Stroke {
  schema_version: 'inkloop.stroke.v1';

  stroke_id: string;
  document_id: string;
  page_id: string;
  page_index: number;

  tool: Tool;
  color?: string;
  width_norm?: number;
  points: StrokePoint[];
  bbox: NormBBox;

  pointer: {
    pointer_type: 'pen' | 'mouse' | 'touch' | 'reader';
    device_vendor?: string;
    device_model?: string;
  };

  created_at: ISODateTime;
}
```

### 5.6 AnnotationEvent Schema

`AnnotationEvent` 是“单笔级事件”。它的粒度比 `Mark` 更细。

```ts
export type AnnotationEventType =
 | 'stroke.created'
 | 'stroke.erased'
 | 'gesture.tap_region'
 | 'gesture.circle'
 | 'gesture.underline'
 | 'gesture.arrow'
 | 'gesture.freehand';

export interface AnnotationEvent {
  schema_version: 'inkloop.annotation_event.v1';

  event_id: string;
  trace_id: string;

  document_id: string;
  page_id: string;
  page_index: number;

  stroke_ids: string[];
  event_type: AnnotationEventType;

  geometry: {
    bbox: NormBBox;
    path_bbox?: NormBBox;
    center?: [number, number];
  };

  classification?: {
    gesture_type?: 'tap_region' | 'circle' | 'underline' | 'arrow' | 'freehand' | 'unknown';
    score?: number;
    raw?: Record<string, unknown>;
  };

  created_at: ISODateTime;
}
```

---

### 5.7 HMP Schema

HMP = Hand-Mark Protocol。它是“证据”，不是“解释”。

```ts
export type HmpMode = 'anchored' | 'self_content' | 'mixed' | 'unknown';

export type HmpObjectHint =
 | 'text'
 | 'image_region'
 | 'table_region'
 | 'formula_region'
 | 'diagram'
 | 'blank'
 | 'ui_region'
 | 'unknown';

export interface HmpEvidence {
  schema_version: 'inkloop.hmp.v1';

  hmp_id: string;
  document_id: string;
  page_id: string;
  page_index: number;

  mode: HmpMode;
  object_hint: HmpObjectHint;

  object_refs: string[];
  anchor_bbox: NormBBox;

  marked_text?: string;
  text_hint?: string;

  handwriting?: {
    kind: 'handwriting' | 'sketch' | 'mixed' | 'none';
    reading?: string;
    description?: string;
    confidence?: number;
    model?: string;
  };

  crop?: {
    crop_asset_id?: string;
    crop_bbox: NormBBox;
    includes_ink: boolean;
    includes_page_image: boolean;
  };

  target_resolution: {
    method: 'containment' | 'intersection' | 'nearest' | 'ocr' | 'manual' | 'none';
    confidence: number;
    notes?: string[];
  };

  created_at: ISODateTime;
}
```

HMP 禁止出现：

```text
用户意图、AI 判断、结论、总结、任务、外部链接、Notion/Obsidian 字段。
```

这些属于 `KnowledgeObject` 或 Adapter。

---

### 5.8 Mark Schema

`Mark` 是一个标注单元，通常由多笔组成。

```ts
export type MarkFeatureType = 'markup' | 'handwriting' | 'drawing' | 'mixed' | 'unknown';

export interface InkMark {
  schema_version: 'inkloop.mark.v1';

  mark_id: string;
  workspace_id: string;
  document_id: string;
  page_id: string;
  page_index: number;

  annotation_event_ids: string[];
  stroke_ids: string[];

  bbox: NormBBox;

  feature_type: MarkFeatureType;
  gesture_type?: 'circle' | 'underline' | 'arrow' | 'tap_region' | 'freehand' | 'unknown';

  hmp_id: string;
  hmp: HmpEvidence;

  marked_text?: string;
  user_text?: string; // handwriting reading if user wrote text

  session_id?: string;

  created_at: ISODateTime;
  tombstoned_at?: ISODateTime;
  tombstone_reason?: 'erased' | 'undo' | 'delete' | 'system_cleanup';
}
```

---

### 5.9 Session / MarkGraph / InferenceView

`MarkGraph` 和 `InferenceView` 可缓存，但真正可重建的输入仍是 marks + hmp + surface objects。

```ts
export interface MarkSession {
  schema_version: 'inkloop.mark_session.v1';

  session_id: string;
  workspace_id: string;
  document_id: string;

  mark_ids: string[];
  started_at: ISODateTime;
  committed_at?: ISODateTime;

  trigger:
 | 'idle'
 | 'handwriting_question'
 | 'manual_ask'
 | 'selection_action'
 | 'reflow_action';
}

export interface MarkGraphNode {
  node_id: string;
  mark_id: string;
}

export interface MarkGraphEdge {
  from_mark_id: string;
  to_mark_id: string;
  edge_type: 'time' | 'space' | 'same_target' | 'containment' | 'arrow' | 'semantic';
  label?: 'one_action' | 'sweep' | 'revisit' | 'separate' | 'points_to';
  weight?: number;
}

export interface MarkGraph {
  schema_version: 'inkloop.mark_graph.v1';

  graph_id: string;
  session_id: string;
  document_id: string;

  nodes: MarkGraphNode[];
  edges: MarkGraphEdge[];

  created_at: ISODateTime;
  graph_hash: Sha256;
}
```

```ts
export interface InferenceView {
  schema_version: 'inkloop.inference_view.v1';

  inference_view_id: string;
  session_id: string;
  document_id: string;

  narrative: string;
  marked: Array<{
    mark_id: string;
    text?: string;
    user_text?: string;
    object_refs: string[];
    anchor_bbox: NormBBox;
  }>;

  question?: string;

  page_context?: {
    page_id: string;
    page_index: number;
    text: string;
    source: 'pdf_text_layer' | 'ocr' | 'reflow';
    char_range?: [number, number];
  };

  anchor_refs: string[];
  anchor_bbox: NormBBox;

  referent_lines?: Array<{
    text: string;
    object_refs: string[];
    bbox: NormBBox;
  }>;

  recall?: Array<{
    mark_id: string;
    ai_turn_id?: string;
    text?: string;
    distance?: number;
    reason: 'nearby' | 'same_target' | 'row_band' | 'recent';
  }>;

  payload_hash: Sha256;
  created_at: ISODateTime;
}
```

---

### 5.10 AiTurn / ScreenOverlay Schema

```ts
export interface ScreenOverlay {
  schema_version: 'inkloop.screen_overlay.v1';

  overlay_id: string;
  document_id: string;
  page_id?: string;
  page_index?: number;

  display_text: string;
  display_markdown?: string;

  geometry: {
    anchor_bbox: NormBBox;
    placement: 'margin' | 'inline' | 'reader_side' | 'floating';
  };

  object_refs: string[];

  state: 'shown' | 'accepted' | 'edited' | 'dismissed';

  created_at: ISODateTime;
  updated_at?: ISODateTime;
}

export interface AiTurn {
  schema_version: 'inkloop.ai_turn.v1';

  ai_turn_id: string;
  workspace_id: string;
  document_id: string;
  session_id: string;

  input_mark_ids: string[];
  inference_view_id: string;
  inference_view: InferenceView;

  user_prompt?: string;
  reply_markdown: string;
  thinking_summary?: string;

  overlay_id: string;
  overlay: ScreenOverlay;

  model: string;
  model_provider?: string;
  prompt_hash: Sha256;
  system_prompt_hash?: Sha256;

  status: 'generated' | 'accepted' | 'edited' | 'dismissed';
  supersedes?: string;

  created_at: ISODateTime;
  updated_at?: ISODateTime;
}
```

---

### 5.11 KnowledgeObject Schema

`KnowledgeObject` 是 Adapter 的核心输入。它把低层证据转成外部知识系统可理解的“知识卡片”。

```ts
export type KnowledgeKind =
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

export type KnowledgeStatus =
 | 'inbox'
 | 'accepted'
 | 'edited'
 | 'dismissed'
 | 'export_ready'
 | 'exported'
 | 'archived';

export interface KnowledgeObject {
  schema_version: 'inkloop.knowledge_object.v1';

  ko_id: string;
  workspace_id: string;
  owner_user_id: string;

  kind: KnowledgeKind;
  title: string;
  body_md: string;

	  source: {
    document_id: string;
    document_title: string;
    document_source_type?: DocumentSourceType;

    page_id?: string;
    page_index?: number;

    object_refs?: string[];
    anchor_bbox?: NormBBox;
    quote?: string;

	    inkloop_uri: string; // inkloop://doc/<doc_id>/page/<n>?anchor=...
	  };

	  source_refs?: Array<
	    | {
	        ref_type: 'document';
	        document_id: string;
	        page_id: string;
	        page_index?: number;
	        event_id?: string;
	        trace_id?: string;
	        bbox?: NormBBox;
	        object_refs: string[];
	        quote?: string;
	      }
	    | {
	        ref_type: 'meeting_mark';
	        meeting_id: string;
	        meeting_mark_id: string;
	        time_ms: number;
	        captured_at_ms: number;
	        kind: 'question' | 'risk' | 'action' | 'decision' | 'attention' | 'note';
	        source: string;
	      }
	    | {
	        ref_type: 'project_memory';
	        memory_id: string;
	        kind: 'goal' | 'milestone' | 'decision' | 'risk' | 'task' | 'knowledge_object';
	        title: string;
	        source_uri?: string;
	      }
	  >;

  provenance: {
    created_from:
 | 'mark'
	 | 'ai_turn'
	 | 'session'
 | 'meeting_mark'
 | 'postprocess'
	 | 'manual'
	 | 'imported_external';
	    mark_ids?: string[];
	    ai_turn_ids?: string[];
	    meeting_id?: string;
	    meeting_mark_ids?: string[];
	    postprocess_result_id?: string;
	    session_id?: string;
    inference_view_id?: string;
    hmp_ids?: string[];
  };

  relations: Array<{
    type:
 | 'generated_from'
 | 'answers'
 | 'cites'
 | 'near'
 | 'same_topic'
 | 'supersedes'
 | 'part_of'
 | 'source_of';
    target_type: 'mark' | 'ai_turn' | 'knowledge_object' | 'document' | 'task';
    target_id: string;
  }>;

  tags: string[];

  status: KnowledgeStatus;

  privacy: 'local_only' | 'private_cloud' | 'export_allowed' | 'team_shared';

  export_hints?: {
    preferred_title?: string;
    preferred_tags?: string[];
    include_quote?: boolean;
    include_anchor_crop?: boolean;
    include_inkloop_link?: boolean;
    include_object_refs?: boolean;
  };

	  render_hints?: {
	    markdown_callout?: 'note' | 'quote' | 'question' | 'todo' | 'summary' | 'tip' | 'warning' | 'success';
	    priority?: 'low' | 'normal' | 'high';
	  };

  created_at: ISODateTime;
  updated_at: ISODateTime;

  content_hash: Sha256;
}
```

#### 5.11.1 KnowledgeObject 示例

```json
{
  "schema_version": "inkloop.knowledge_object.v1",
  "ko_id": "ko_01JZ7D5E7WJK4F5NTAT9QCJBW2",
  "workspace_id": "ws_default",
  "owner_user_id": "user_123",
  "kind": "ai_note",
  "title": "AI Note · Attention Is All You Need · p12",
  "body_md": "这里的关键点是 Q/K/V 的角色分离：K 用来匹配，V 才是被聚合的信息。",
  "source": {
    "document_id": "doc_abc",
    "document_title": "Attention Is All You Need",
    "page_index": 12,
    "object_refs": ["obj_p12_0345", "obj_p12_0346"],
    "anchor_bbox": [0.12, 0.34, 0.18, 0.04],
    "quote": "Scaled dot-product attention...",
    "inkloop_uri": "inkloop://doc/doc_abc/page/12?anchor=obj_p12_0345"
  },
  "provenance": {
    "created_from": "ai_turn",
    "mark_ids": ["mark_01JZ7D4V7TDQR2C0DB4D9N20TC"],
    "ai_turn_ids": ["aiturn_01JZ7D52KKF1N9NR86RDP77E2D"],
    "session_id": "sess_01JZ7D50..."
  },
  "relations": [
    {
      "type": "generated_from",
      "target_type": "mark",
      "target_id": "mark_01JZ7D4V7TDQR2C0DB4D9N20TC"
    }
  ],
  "tags": ["inkloop", "reading", "transformer"],
  "status": "export_ready",
  "privacy": "export_allowed",
  "created_at": "2026-06-26T02:10:00.000Z",
  "updated_at": "2026-06-26T02:10:00.000Z",
  "content_hash": "sha256:..."
}
```

---

### 5.12 LedgerEvent Schema

所有持久化对象都要求以事件进入账本，再折叠成 materialized views。

```ts
export type LedgerEventKind =
 | 'document.created'
 | 'document.updated'
 | 'document.deleted'
 | 'page.indexed'
 | 'surface_objects.indexed'
 | 'stroke.created'
 | 'annotation_event.created'
 | 'mark.created'
 | 'mark.tombstoned'
 | 'session.created'
 | 'session.committed'
 | 'ai_turn.created'
 | 'ai_turn.superseded'
 | 'overlay.state_changed'
 | 'knowledge_object.created'
 | 'knowledge_object.updated'
 | 'knowledge_object.status_changed'
 | 'external_binding.upserted'
 | 'external_binding.remote_changed'
 | 'external_binding.conflicted'
 | 'sync_job.created'
 | 'sync_job.updated'
 | 'audit.logged';

export interface LedgerEvent<TPayload = unknown> {
  schema_version: 'inkloop.ledger.v1';

  event_id: string;
  kind: LedgerEventKind;

  workspace_id: string;
  actor: ActorRef;

  entity: EntityRef;

  device_clock?: {
    device_seq: number;
    lamport?: number;
  };

  created_at: ISODateTime;

  idempotency_key: string;
  payload_hash: Sha256;

  payload: TPayload;
}
```

#### 5.12.1 Idempotency Key 规则

```text
<actor.device_id>:<kind>:<entity_id>:<semantic_version_or_hash>
```

例子：

```text
dev_mac_001:knowledge_object.created:ko_01JZ...:sha256_abcd
```

同一个 idempotency key 重复写入，必须返回同一个事件或被忽略，不能生成新对象。

---

### 5.13 ExternalBinding Schema

`ExternalBinding` 是 Adapter 的核心状态表。它回答：

```text
这个 KnowledgeObject 在某个外部系统里对应哪里？
远端当前是什么版本？
上次同步的内容 hash 是什么？
现在是否冲突？
```

```ts
export type ExternalProvider =
 | 'obsidian_fs'
 | 'obsidian_plugin'
 | 'notion'
 | 'markdown'
 | 'zotero'
 | 'readwise'
 | 'google_drive';

export interface ExternalBinding {
  schema_version: 'inkloop.external_binding.v1';

  binding_id: string;
  workspace_id: string;

  provider: ExternalProvider;
  target_id: string; // e.g. vault hash, Notion workspace/database id

  entity_type: 'knowledge_object' | 'document' | 'task';
  entity_id: string; // ko_id or doc_id

  remote: {
    remote_id: string;      // Obsidian: stable path or plugin id; Notion: page id
    remote_path?: string;   // Obsidian file path
    remote_url?: string;    // obsidian://open?... or https://notion.so/...
    remote_rev?: string;    // mtime/etag/revision
    remote_hash?: Sha256;   // hash of controlled section or remote block payload
  };

  mapping: {
    mapping_version: 'obsidian.markdown.v1' | 'notion.page.v1' | 'markdown.file.v1';
    content_hash: Sha256;   // KO content hash when last exported
    render_hash: Sha256;    // provider rendered payload hash when last exported
    controlled_region_id?: string;
  };

  sync_state:
 | 'active'
 | 'queued'
 | 'remote_changed'
 | 'conflict'
 | 'remote_deleted'
 | 'local_deleted'
 | 'error'
 | 'paused';

  last_synced_at?: ISODateTime;
  last_checked_at?: ISODateTime;
  last_error?: AdapterErrorInfo;

  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface AdapterErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  detail?: Record<string, unknown>;
}
```

---

### 5.14 SyncJob / SyncPolicy Schema

```ts
export interface SyncPolicy {
  schema_version: 'inkloop.sync_policy.v1';

  content_authority: 'inkloop' | 'remote' | 'manual';
  metadata_authority: 'inkloop' | 'remote' | 'merge';

  conflict_strategy:
 | 'skip'
 | 'append_new_version'
 | 'create_conflict_copy'
 | 'ask_user'
 | 'inkloop_wins';

  privacy_filter: Array<'export_allowed' | 'team_shared'>;

  remote_delete_behavior: 'mark_remote_deleted' | 'recreate' | 'forget_binding';
  local_delete_behavior: 'keep_remote' | 'trash_remote' | 'archive_remote';

  include_assets: 'none' | 'anchor_crop' | 'selected_assets';
}

export interface SyncJob {
  schema_version: 'inkloop.sync_job.v1';

  job_id: string;
  workspace_id: string;

  provider: ExternalProvider;
  target_id: string;

  direction: 'push' | 'pull' | 'check';

  entity_refs: EntityRef[];

  policy: SyncPolicy;

  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  priority: 'interactive' | 'background' | 'maintenance';

  attempts: number;
  max_attempts: number;
  next_run_at?: ISODateTime;

  result?: {
    created: number;
    updated: number;
    skipped: number;
    conflicted: number;
    remote_urls?: string[];
  };

  last_error?: AdapterErrorInfo;

  created_at: ISODateTime;
  updated_at: ISODateTime;
}
```

---

## 6. Schema 和 Adapter 怎么联动

这是本方案最关键的部分。

### 6.1 三层对象边界

```text
低层证据层：Stroke / AnnotationEvent / HMP / Mark / AiTurn
        ↓ KnowledgeBuilder
语义对象层：KnowledgeObject
        ↓ Adapter Renderer
外部投影层：Markdown / Obsidian Note / Notion Page / Zotero Note
```

**Adapter 不能直接吃 `Stroke`。** 直接吃 Stroke 会导致每个外部系统都要理解笔迹、bbox、HMP、页面对象、OCR，这会把 Adapter 写成灾难现场。

**Adapter 只吃 `KnowledgeObject`。** 如果外部系统需要更多上下文，Adapter 只能通过 `RenderContext` 读取有限资源，例如文档标题、页码、quote、anchor crop，而不是随意读取整本 PDF。

### 6.2 Adapter 输入输出合同

Adapter 输入：

```ts
interface AdapterInput {
  object: KnowledgeObject;
  target: AdapterTarget;
  binding?: ExternalBinding;
  policy: SyncPolicy;
  context: RenderContext;
}
```

Adapter 输出：

```ts
interface AdapterOutput {
  binding: ExternalBinding;
  audit_events: AuditLog[];
  remote_snapshot?: RemoteSnapshot;
}
```

Adapter 不允许：

```text
1. 直接修改 KnowledgeObject。
2. 直接修改 Mark / AiTurn / HMP。
3. 未经 policy 导出 local_only 内容。
4. 自动覆盖用户在外部 App 手写的正文。
5. 把外部 Markdown 正文反向写成 InkLoop 的 AI 回复。
```

Adapter 允许：

```text
1. 创建/更新 ExternalBinding。
2. 创建 SyncJob / SyncEvent / AuditLog。
3. 从远端回传 status / tags / task done 等有限 metadata。
4. 给 UI 返回 preview / diff / conflict 信息。
```

### 6.3 端到端流程

```text
用户圈画 / 提问
  ↓
Stroke / AnnotationEvent / Mark / HMP 落账本
  ↓
AI 生成 AiTurn / ScreenOverlay 落账本
  ↓
用户点击“收下”或“导出”
  ↓
KnowledgeBuilder 生成 KnowledgeObject
  ↓
用户选择目标：Obsidian Vault / Notion Database / Markdown folder
  ↓
AdapterCore 做 privacy filter + preview
  ↓
Renderer 将 KnowledgeObject 渲染成远端 payload
  ↓
Transport 执行 upsert
  ↓
Reconciler 检查远端是否冲突
  ↓
ExternalBinding 落账本
  ↓
UI 展示“已导出 / 打开外部链接”
```

### 6.4 KnowledgeBuilder 规则

| 输入 | 条件 | 输出 KO kind |
|---|---|---|
| Mark 命中文本，无 AI 回复 | 用户主动保存 | `excerpt` |
| Mark 命中文本 + 用户手写旁注 | 手写不是问题 | `annotation` |
| Mark + AiTurn | AI 回复为解释/评论 | `ai_note` |
| Handwriting question + AiTurn | 有明确问答结构 | `qa` |
| 多个 Mark + AiTurn | AI 生成综合 | `summary` |
| Handwriting 包含行动意图 | “todo / remind / follow up” | `task` |
| 文档首次导入 | 用户开启导出 source note | `source_document` |

### 6.5 KnowledgeObject 生成算法

```ts
async function buildKnowledgeObject(input: BuildInput): Promise<KnowledgeObject> {
  const source = await resolveSourceAnchor(input);
  const provenance = buildProvenance(input);
  const body_md = renderCanonicalBody(input);
  const title = buildTitle(input, source);
  const tags = inferDefaultTags(input, source);

  const ko: KnowledgeObject = {
    schema_version: 'inkloop.knowledge_object.v1',
    ko_id: newId('ko'),
    workspace_id: input.workspace_id,
    owner_user_id: input.user_id,
    kind: inferKind(input),
    title,
    body_md,
    source,
    provenance,
    relations: buildRelations(input),
    tags,
    status: 'export_ready',
    privacy: inferPrivacy(input.document),
    export_hints: defaultExportHints(input),
    render_hints: defaultRenderHints(input),
    created_at: now(),
    updated_at: now(),
    content_hash: 'sha256:pending',
  };

  ko.content_hash = hashKnowledgeObject(ko);
  return ko;
}
```

### 6.6 Adapter 渲染流程

```ts
async function exportKnowledgeObject(input: AdapterInput): Promise<AdapterOutput> {
  assertExportAllowed(input.object, input.policy);

  const adapter = registry.get(input.target.provider);
  await adapter.validateTarget(input.target);

  const renderPlan = await adapter.render(input.object, {
    target: input.target,
    binding: input.binding,
    policy: input.policy,
    context: input.context,
  });

  const preview = await adapter.preview?.(renderPlan);

  if (input.binding) {
    const remote = await adapter.readRemoteSnapshot(input.binding);
    const decision = adapter.diff(input.binding, remote, renderPlan, input.policy);
    if (decision.kind === 'conflict') {
      return adapter.handleConflict(decision);
    }
  }

  const receipt = await adapter.upsert(renderPlan, input.binding);
  const binding = buildExternalBinding(input, renderPlan, receipt);

  await ledger.append({
    kind: 'external_binding.upserted',
    entity: { entity_type: 'external_binding', entity_id: binding.binding_id },
    payload: binding,
  });

  return { binding, audit_events: [] };
}
```

---

## 7. Adapter Framework 详细设计

### 7.1 Adapter Manifest

```ts
export interface AdapterManifest {
  schema_version: 'inkloop.adapter_manifest.v1';

  provider: ExternalProvider;
  display_name: string;
  description?: string;

  direction: 'push' | 'pull' | 'bidirectional_limited';

  auth: 'none' | 'local_fs' | 'oauth' | 'api_key' | 'plugin_token';

  runtime: Array<'desktop' | 'paper' | 'mobile' | 'web' | 'server' | 'obsidian_plugin'>;

  capabilities: {
    create: boolean;
    update: boolean;
    append: boolean;
    delete: boolean;
    read: boolean;
    list: boolean;
    deep_link: boolean;
    rich_blocks: boolean;
    markdown: boolean;
    backlinks: boolean;
    attachments: boolean;
    frontmatter: boolean;
    conflict_check: boolean;
    pull_metadata: boolean;
  };

  supported_kinds: KnowledgeKind[];
}
```

### 7.2 Adapter Target

```ts
export interface AdapterTarget {
  target_id: string;
  provider: ExternalProvider;
  workspace_id: string;

  display_name: string;

  config: Record<string, unknown>;

  created_at: ISODateTime;
  updated_at: ISODateTime;
}
```

Obsidian FS target 示例：

```json
{
  "target_id": "target_obsidian_vault_sha256_abcd",
  "provider": "obsidian_fs",
  "workspace_id": "ws_default",
  "display_name": "My Obsidian Vault",
  "config": {
    "vault_name": "Second Brain",
    "vault_root_path": "/Users/me/Obsidian/Second Brain",
    "base_folder": "InkLoop",
    "assets_folder": "InkLoop/_assets",
    "source_folder": "InkLoop/Sources",
    "notes_folder": "InkLoop/Notes",
    "tasks_folder": "InkLoop/Tasks",
    "path_strategy": "stable_ko_id",
    "link_style": "wikilink",
    "write_mode": "controlled_section"
  },
  "created_at": "2026-06-26T02:10:00.000Z",
  "updated_at": "2026-06-26T02:10:00.000Z"
}
```

### 7.3 Adapter Interface

```ts
export interface ExportAdapter<TConfig, TRenderPlan, TReceipt> {
  manifest: AdapterManifest;

  validateConfig(config: TConfig): Promise<ValidationResult>;
  ensureTarget(target: AdapterTarget): Promise<AdapterTarget>;

  render(
    object: KnowledgeObject,
    ctx: RenderContext
  ): Promise<TRenderPlan>;

  preview(plan: TRenderPlan): Promise<AdapterPreview>;

  readRemoteSnapshot?(binding: ExternalBinding): Promise<RemoteSnapshot | null>;

  diff?(
    binding: ExternalBinding | undefined,
    remote: RemoteSnapshot | null,
    plan: TRenderPlan,
    policy: SyncPolicy
  ): Promise<AdapterDiffDecision>;

  upsert(plan: TRenderPlan, binding?: ExternalBinding): Promise<TReceipt>;

  pullChanges?(target: AdapterTarget, cursor?: string): Promise<PullResult>;

  open?(binding: ExternalBinding): Promise<void>;
}
```

### 7.4 RenderContext

```ts
export interface RenderContext {
  workspace_id: string;
  user_id: string;

  target: AdapterTarget;
  binding?: ExternalBinding;
  policy: SyncPolicy;

  getDocument(document_id: string): Promise<InkDocument>;
  getAsset(asset_id: string): Promise<AssetRef | Blob>;
  getRelatedObjects(ko_id: string): Promise<KnowledgeObject[]>;

  now(): ISODateTime;
  hash(value: unknown): Sha256;
}
```

Adapter 通过 `RenderContext` 获取额外资源，但必须受 `SyncPolicy` 和 `privacy` 控制。

### 7.5 Adapter Error 规范

```ts
export type AdapterErrorCode =
 | 'CONFIG_INVALID'
 | 'AUTH_REQUIRED'
 | 'TARGET_NOT_FOUND'
 | 'PERMISSION_DENIED'
 | 'NETWORK_ERROR'
 | 'RATE_LIMITED'
 | 'REMOTE_NOT_FOUND'
 | 'REMOTE_CHANGED'
 | 'REMOTE_DELETED'
 | 'CONFLICT'
 | 'PAYLOAD_TOO_LARGE'
 | 'PRIVACY_BLOCKED'
 | 'UNSUPPORTED_KIND'
 | 'UNKNOWN';
```

所有错误都要明确是否可重试：

```ts
interface AdapterErrorInfo {
  code: AdapterErrorCode;
  message: string;
  retryable: boolean;
  user_action?: 'reauthorize' | 'choose_target' | 'resolve_conflict' | 'reduce_payload' | 'none';
  detail?: Record<string, unknown>;
}
```

---

## 8. Obsidian Adapter 总设计

### 8.1 Obsidian 在 InkLoop 中的定位

Obsidian 是用户的长期个人知识库。它适合保存：

```text
摘录
AI 旁注
问答
任务
文档阅读总结
来源文档索引
```

它不适合保存：

```text
原始笔迹 stroke
完整 HMP 取证细节
完整 PDF 文本层对象表
完整页面坐标系统
高频 AI 回屏状态
实时跨端冲突合并
```

### 8.2 Obsidian Adapter 的目标

1. 把 `KnowledgeObject` 可靠写成 Markdown。
2. 每个 KO 对应一个稳定可追踪的 Markdown note。
3. 用户可在 Obsidian 里自由编辑非受控区域。
4. InkLoop 只更新自己的受控区域，不覆盖用户写的内容。
5. 用户移动/重命名文件后，InkLoop 能通过 frontmatter 找回。
6. 用户删除文件后，InkLoop 不删除 KO，只标记 remote_deleted。
7. 用户在 Obsidian 改 `status/tags/task_done`，InkLoop 可有限回收。
8. 双向同步只同步 metadata，不同步 AI 正文和原文锚点。

### 8.3 三种联动方式

| 模式 | 优先级 | 运行位置 | 写入方式 | 适用 |
|---|---:|---|---|---|
| `obsidian_fs` | P0 | InkLoop Desktop | 直接写 Vault 文件夹 | v1 最快落地 |
| `obsidian_plugin` | P1 | Obsidian 插件 | Vault API / FileManager API | v1.5 稳定同步、移动端 |
| `obsidian_uri` | 辅助 | 任意端 | 打开 note / 创建入口 | 深链跳转，不做可靠写入 |

#### 8.3.1 为什么 v1 先做 FS Adapter

```text
优点：
- 不要求用户安装 Obsidian 插件。
- Desktop App 可直接选择 Vault 文件夹。
- Markdown 文件天然可读、可 Git 管理、可同步。
- 实现成本低，适合快速验证导出价值。

限制：
- 只适合桌面端。
- 无法实时知道 Obsidian 内 rename/modify/delete。
- 只能通过扫描和 mtime 检查远端变化。
- Web 端不能可靠写入本地 Vault。
- 移动端受沙盒限制，不适合直接写。
```

#### 8.3.2 为什么 v1.5 再做 Plugin Adapter

```text
优点：
- 插件在 Obsidian 内部，可监听 vault 文件事件。
- 可用 Obsidian 官方 API 操作文件，减少与 Obsidian 索引冲突。
- 可支持移动端 Obsidian。
- 可做更好的状态回传、冲突提示、命令面板。

限制：
- 用户需要安装插件并授权。
- 插件要遵守 Obsidian 插件规范。
- 插件安全和隐私披露要求更高。
- 插件审核、版本兼容、移动端兼容会增加成本。
```

#### 8.3.3 为什么 URI 不能当同步通道

Obsidian URI 很适合打开 note 或触发轻量跨 App 工作流，但不适合做可靠同步，因为：

1. URI 调用没有稳定返回值。
2. 无法返回 remote revision / hash / receipt。
3. 无法知道写入是否成功。
4. 无法做原子 read-modify-write。
5. 无法安全处理受控区块冲突。
6. 无法处理大 payload、附件、重试、幂等。

所以本方案只使用 URI 做：

```text
Open in Obsidian
Open in InkLoop
```

---

## 9. Obsidian 文件模型

### 9.1 Vault 目录结构

默认创建在用户 Vault 内的 `InkLoop/` 目录，不使用隐藏目录，避免插件侧读取隐藏文件时绕过 Vault API。

```text
<Obsidian Vault>/
  InkLoop/
    Sources/
      Attention Is All You Need--doc_abc.md
      Product Strategy--doc_def.md

    Notes/
      2026/
        2026-06/
          ai-note--attention-is-all-you-need--p12--ko_01JZ7D5E.md
          qa--attention-is-all-you-need--p13--ko_01JZ7D8A.md

    Excerpts/
      2026/
        2026-06/
          excerpt--attention-is-all-you-need--p12--ko_01JZ7DA9.md

    Tasks/
      2026/
        2026-06/
          task--review-transformer-positional-encoding--ko_01JZ7DB1.md

    _assets/
      ko_01JZ7D5E-anchor.png

    _inkloop/
      target.json
      last-sync.json
```

说明：

1. `_inkloop` 不是隐藏目录，只是普通目录，Obsidian 能看到。
2. 所有 note 都在可见目录中，便于插件使用 Vault API。
3. `target.json` 和 `last-sync.json` 只是缓存，不是真相源。
4. 真相源仍在 InkLoop Ledger 和每个 Markdown 的 frontmatter / controlled section。

### 9.2 路径策略

默认使用 `stable_ko_id`：

```text
<kind>--<doc_slug>--p<page>--<ko_short>.md
```

示例：

```text
ai-note--attention-is-all-you-need--p12--ko_01JZ7D5E.md
```

为什么文件名要带 `ko_short`：

```text
1. 避免同标题冲突。
2. 用户改标题不影响唯一性。
3. InkLoop 可通过文件名快速初筛。
4. frontmatter 仍是最终身份。
```

### 9.3 Slug 规则

```ts
function slugify(input: string, max = 64): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
 || 'untitled';
}
```

保留中文也可，但为了跨平台文件系统稳定，要求默认转简洁 slug。若用户选择“保留中文标题”，也必须移除：

```text
/ \ : * ? " < > | # ^ [ ]
```

### 9.4 文件身份

Obsidian 文件路径不是身份。身份顺序：

```text
1. frontmatter.inkloop_id
2. controlled section marker: inkloop:begin <ko_id>
3. ExternalBinding.remote.remote_path
4. 文件名 ko_short
```

如果四者不一致，以 `frontmatter.inkloop_id` 为准；如果 frontmatter 缺失但 marker 存在，可尝试修复；如果两者冲突，进入 conflict。

---

## 10. Obsidian Markdown 渲染规范

### 10.1 Frontmatter

使用扁平字段，减少 Obsidian Properties 和 YAML 解析兼容问题。

```yaml
---
inkloop_schema: inkloop.obsidian_note.v1
inkloop_id: ko_01JZ7D5E7WJK4F5NTAT9QCJBW2
inkloop_kind: ai_note
inkloop_binding_id: bind_01JZ7D5KHZ0P70ZD8CD2EJ7VHY
inkloop_content_hash: sha256:abc...
inkloop_render_hash: sha256:def...
inkloop_source_doc_id: doc_abc
inkloop_source_doc_title: "Attention Is All You Need"
inkloop_source_page: 12
inkloop_source_object_refs:
  - obj_p12_0345
  - obj_p12_0346
inkloop_anchor_bbox: [0.12, 0.34, 0.18, 0.04]
inkloop_uri: "inkloop://doc/doc_abc/page/12?anchor=obj_p12_0345"
status: exported
tags:
  - inkloop
  - reading
  - transformer
created: 2026-06-26T02:10:00.000Z
updated: 2026-06-26T02:10:00.000Z
---
```

#### 10.1.1 字段所有权

| 字段 | 所有权 | InkLoop 是否覆盖 |
|---|---|---:|
| `inkloop_*` | InkLoop | 是 |
| `status` | 双方 | merge / pullback |
| `tags` | 双方 | merge |
| `created` | InkLoop 初次创建 | 否 |
| `updated` | 双方 | 是，但只代表文件更新时间 |
| 用户新增字段 | 用户 | 否 |

### 10.2 正文模板

```md
# AI Note · Attention Is All You Need · p12

> [!info] Source
> Document: [[Attention Is All You Need--doc_abc|Attention Is All You Need]]  
> Page: 12  
> Open in InkLoop: [link](inkloop://doc/doc_abc/page/12?anchor=obj_p12_0345)

> [!quote] Source quote
> Scaled dot-product attention...

<!-- inkloop:begin ko_01JZ7D5E7WJK4F5NTAT9QCJBW2 hash=sha256:def... -->
> [!note] InkLoop
> 这里的关键点是 Q/K/V 的角色分离：K 用来匹配，V 才是被聚合的信息。
<!-- inkloop:end ko_01JZ7D5E7WJK4F5NTAT9QCJBW2 -->

## Context

- Source object refs: `obj_p12_0345`, `obj_p12_0346`
- Anchor bbox: `[0.12, 0.34, 0.18, 0.04]`
- Generated from: `mark_01JZ7D4V7TDQR2C0DB4D9N20TC`
- AI turn: `aiturn_01JZ7D52KKF1N9NR86RDP77E2D`

## My notes

<!-- User-owned area. InkLoop must not overwrite this section. -->
```

### 10.3 Controlled Section 规则

受控区块格式：

```md
<!-- inkloop:begin <ko_id> hash=<render_hash> -->
... InkLoop generated content ...
<!-- inkloop:end <ko_id> -->
```

规则：

1. InkLoop 只允许替换 begin/end 之间的内容。
2. begin/end 外的内容永不自动覆盖。
3. begin/end marker 缺失时，不猜测正文位置。
4. hash 是上次 InkLoop 写入的 rendered block hash。
5. 更新前重新计算远端 controlled section hash。
6. 如果远端 hash 与 binding.render_hash 不一致，说明用户改了受控区块，进入 conflict。

### 10.4 Markdown Callout 映射

| KO kind | 默认 callout | 示例 |
|---|---|---|
| `excerpt` | `quote` | `> [!quote] Source quote` |
| `annotation` | `note` | `> [!note] My annotation` |
| `ai_note` | `note` | `> [!note] InkLoop` |
| `qa` | `question` | `> [!question] Q/A` |
| `summary` | `summary` | `> [!summary] Summary` |
| `task` | `todo` | `> [!todo] Task` |
| `concept` | `tip` | `> [!tip] Concept` |

### 10.5 Source Note

每个原始文档可创建一个 Source Note，作为 Obsidian 内的来源索引。

路径：

```text
InkLoop/Sources/<doc_slug>--<doc_id>.md
```

示例：

```md
---
inkloop_schema: inkloop.obsidian_source.v1
inkloop_doc_id: doc_abc
inkloop_doc_title: "Attention Is All You Need"
inkloop_source_type: pdf
inkloop_uri: "inkloop://doc/doc_abc"
tags: [inkloop, source]
created: 2026-06-26T02:00:00.000Z
updated: 2026-06-26T02:10:00.000Z
---

# Attention Is All You Need

Open in InkLoop: [link](inkloop://doc/doc_abc)

## Exported notes

<!-- inkloop:begin source-index doc_abc hash=sha256:... -->
- [[ai-note--attention-is-all-you-need--p12--ko_01JZ7D5E|AI Note · p12]]
- [[qa--attention-is-all-you-need--p13--ko_01JZ7D8A|Q/A · p13]]
<!-- inkloop:end source-index doc_abc -->
```

Source Note 同样使用 controlled section，只更新索引区域。

---

## 11. Obsidian FS Adapter 详细逻辑

### 11.1 Manifest

```ts
export const obsidianFsManifest: AdapterManifest = {
  schema_version: 'inkloop.adapter_manifest.v1',
  provider: 'obsidian_fs',
  display_name: 'Obsidian Vault',
  direction: 'bidirectional_limited',
  auth: 'local_fs',
  runtime: ['desktop'],
  capabilities: {
    create: true,
    update: true,
    append: true,
    delete: false,
    read: true,
    list: true,
    deep_link: true,
    rich_blocks: false,
    markdown: true,
    backlinks: true,
    attachments: true,
    frontmatter: true,
    conflict_check: true,
    pull_metadata: true,
  },
  supported_kinds: [
    'source_document',
    'excerpt',
    'annotation',
    'ai_note',
    'qa',
    'summary',
    'task',
    'concept',
  ],
};
```

### 11.2 Target 配置

```ts
export interface ObsidianFsTargetConfig {
  vault_name: string;
  vault_root_path: string;

  base_folder: string;     // default InkLoop
  source_folder: string;   // default InkLoop/Sources
  notes_folder: string;    // default InkLoop/Notes
  excerpts_folder: string; // default InkLoop/Excerpts
  tasks_folder: string;    // default InkLoop/Tasks
  assets_folder: string;   // default InkLoop/_assets
  meta_folder: string;     // default InkLoop/_inkloop

  path_strategy: 'stable_ko_id' | 'date_kind_doc';
  link_style: 'wikilink' | 'markdown';
  write_mode: 'controlled_section';

  include_anchor_crop_default: boolean;
  include_object_refs_default: boolean;
}
```

### 11.3 Render Plan

```ts
export interface ObsidianMarkdownRenderPlan {
  provider: 'obsidian_fs' | 'obsidian_plugin';

  ko_id: string;
  target_id: string;

  file: {
    relative_path: string;
    title: string;
    frontmatter: Record<string, unknown>;
    body: string;
    controlled_section: {
      id: string;
      begin_marker: string;
      end_marker: string;
      body: string;
      render_hash: Sha256;
    };
  };

  source_note?: {
    relative_path: string;
    body_patch: ControlledSectionPatch;
  };

  assets?: Array<{
    asset_id: string;
    relative_path: string;
    mime_type: string;
    content_hash: Sha256;
  }>;

  render_hash: Sha256;
  content_hash: Sha256;
}
```

### 11.4 Upsert 主算法

```ts
async function upsertObsidianNote(
  plan: ObsidianMarkdownRenderPlan,
  binding?: ExternalBinding,
  fs: FileSystem
): Promise<ObsidianReceipt> {
  const targetPath = await resolveRemotePath(plan, binding, fs);

  if (!targetPath.exists) {
    const fullText = composeNewMarkdown(plan);
    await fs.writeFile(targetPath.path, fullText, { createNew: true });
    return buildReceipt('created', targetPath.path, plan);
  }

  const current = await fs.readFile(targetPath.path);
  const parsed = parseInkLoopMarkdown(current);

  const identity = resolveIdentity(parsed, targetPath.path);
  if (identity.conflict) {
    throw adapterError('CONFLICT', 'Remote note identity does not match KnowledgeObject');
  }

  const remoteSection = parsed.controlledSections[plan.ko_id];

  if (!remoteSection) {
    return handleMissingControlledSection({ current, parsed, plan, targetPath, fs });
  }

  const remoteHash = hash(remoteSection.body);
  const lastRenderHash = binding?.mapping.render_hash;

  if (lastRenderHash && remoteHash !== lastRenderHash) {
    return handleControlledSectionConflict({ current, parsed, plan, remoteHash, binding, fs });
  }

  const next = replaceControlledSection(current, plan.file.controlled_section);
  const nextWithFm = mergeFrontmatter(next, plan.file.frontmatter, {
    preserveUserFields: true,
    inkloopFieldsWin: true,
    mergeTags: true,
  });

  await fs.writeFile(targetPath.path, nextWithFm, { overwrite: true });
  return buildReceipt('updated', targetPath.path, plan);
}
```

### 11.5 Path Resolver

```ts
async function resolveRemotePath(
  plan: ObsidianMarkdownRenderPlan,
  binding: ExternalBinding | undefined,
  fs: FileSystem
): Promise<{ path: string; exists: boolean; resolution: string }> {
  // 1. If binding.remote_path exists and file exists, use it.
  if (binding?.remote.remote_path && await fs.exists(binding.remote.remote_path)) {
    return { path: binding.remote.remote_path, exists: true, resolution: 'binding_path' };
  }

  // 2. Search under InkLoop folder for frontmatter inkloop_id.
  const found = await scanInkLoopFolderByInkloopId(plan.ko_id, fs);
  if (found.length === 1) {
    return { path: found[0], exists: true, resolution: 'frontmatter_scan' };
  }

  if (found.length > 1) {
    throw adapterError('CONFLICT', `Multiple Obsidian notes found for ${plan.ko_id}`);
  }

  // 3. Use deterministic path from render plan.
  return { path: plan.file.relative_path, exists: false, resolution: 'new_path' };
}
```

### 11.6 Missing Controlled Section 策略

如果 frontmatter 存在 `inkloop_id`，但正文里没有受控区块：

| 场景 | 判断 | 行为 |
|---|---|---|
| 新旧版本 note，从未写过 marker | `binding.mapping.controlled_region_id` 缺失 | append controlled section |
| 用户删除了 marker | binding 存在、上次有 marker | conflict |
| 用户把 InkLoop 内容完全改成自己的笔记 | remote hash 不可判断 | create conflict copy 或 append new version |

默认：

```text
v1：不覆盖，追加 “InkLoop update” 新区块，并把 binding 标记 remote_changed。
```

示例：

```md
## InkLoop update · 2026-06-26

<!-- inkloop:begin ko_... hash=sha256:new -->
> [!note] InkLoop
> 新版本内容……
<!-- inkloop:end ko_... -->
```

### 11.7 Controlled Section Conflict 策略

如果用户改了受控区块：

```text
binding.render_hash != hash(remote_controlled_section)
```

默认不覆盖。处理方式按 policy：

| policy | 行为 |
|---|---|
| `skip` | job blocked，UI 提示冲突 |
| `append_new_version` | 在下方追加新版本 controlled section |
| `create_conflict_copy` | 新建 `...--conflict-<date>.md` |
| `ask_user` | UI 展示 diff，用户选择 |
| `inkloop_wins` | 仅手动确认后覆盖，不作为默认 |

选定 v1 默认：

```text
append_new_version
```

原因：早期用户更怕“被覆盖”而不是“多一个区块”。

### 11.8 Deletion 策略

如果绑定文件不存在：

```text
1. 扫描 InkLoop 文件夹找 inkloop_id。
2. 找到则更新 binding.remote_path。
3. 找不到则标记 ExternalBinding.sync_state = remote_deleted。
4. 不删除 KnowledgeObject。
5. UI 提供：重新创建 / 忘记绑定 / 保持已删除。
```

### 11.9 Rename / Move 策略

FS Adapter 无事件，只能通过下一次 check 或 export 扫描找回。Plugin Adapter 可监听 rename。

```ts
if (!exists(binding.remote_path)) {
  const found = scanByFrontmatterInkloopId(ko_id);
  if (found.one) updateBindingPath(found.path);
  else markRemoteDeleted();
}
```

### 11.10 Pullback 策略

FS Adapter 每次 `check` 或 `pull` 只读取 frontmatter，不解析正文。

可回收字段：

```text
status
tags
task_done
remote_path
remote_url
remote_title
```

禁止回收字段：

```text
body_md
source.quote
source.anchor_bbox
object_refs
AI reply 正文
用户在 Obsidian 写的自由正文
```

原因：Obsidian 是 projection，不是 InkLoop 的原始标注系统。自由正文可未来作为“external note linked to KO”单独导入，但不能覆盖原 AI 旁注。

---

## 12. Obsidian Plugin Adapter 设计

### 12.1 插件定位

插件不是 v1 必需，但 v1.5 应该做。它解决四类问题：

1. 移动端无法直接写 Vault 文件夹。
2. 需要实时监听 rename / modify / delete。
3. 需要在 Obsidian 内提供命令面板与状态提示。
4. 需要用 Obsidian 官方 API 更安全地写文件和 frontmatter。

### 12.2 插件通信模式

选定两种通信模式，按安全性排序：

#### 模式 A：Plugin Pull from Cloud

```text
Obsidian Plugin
  ↓ request pending sync jobs
InkLoop Cloud
  ↓ returns KnowledgeObjects / render plans
Obsidian Plugin
  ↓ writes vault
Plugin reports receipt
```

优点：

```text
- 不需要本机开端口。
- 移动端也可用。
- 权限与 token 模型清晰。
```

缺点：

```text
- 需要 InkLoop Cloud。
- local_only 内容不能走 Cloud。
```

#### 模式 B：Desktop Local Bridge

```text
InkLoop Desktop local service
  ↔ localhost / secure token
Obsidian Plugin
```

优点：

```text
- local_only 可本地同步。
- 不必上云。
```

缺点：

```text
- 本地端口安全、跨平台、防火墙、启动顺序更复杂。
- 移动端不可用。
```

选定 v1.5：

```text
Cloud Pull 为主，本地 Bridge 作为高级隐私模式。
```

### 12.3 插件侧 Target

插件侧设置：

```ts
interface InkLoopObsidianPluginSettings {
  account_id?: string;
  workspace_id?: string;
  plugin_token?: string;

  base_folder: string;
  source_folder: string;
  notes_folder: string;
  excerpts_folder: string;
  tasks_folder: string;
  assets_folder: string;

  sync_enabled: boolean;
  pull_interval_seconds: number;

  allow_network: boolean;
  allow_anchor_crops: boolean;
  allow_status_pullback: boolean;
}
```

插件配置用 `Plugin.loadData()` / `Plugin.saveData()` 存储，不自己写配置文件。

### 12.4 插件文件操作原则

插件中：

```text
1. 优先使用 app.vault，而不是 app.vault.adapter。
2. 后台修改 Markdown 正文使用 Vault.process()。
3. 修改 frontmatter 使用 app.fileManager.processFrontMatter()。
4. 用户路径用 normalizePath()。
5. 不硬编码 .obsidian 路径，配置目录用 Vault.configDir。
6. 移动端不要在顶层 import fs/path/electron。
7. 网络请求使用 requestUrl，而不是 fetch/axios。
```

### 12.5 插件伪代码：写入 KO Note

```ts
import {
  Plugin,
  TFile,
  normalizePath,
  requestUrl,
  Notice,
} from 'obsidian';

export default class InkLoopPlugin extends Plugin {
  settings: InkLoopObsidianPluginSettings;

  async onload() {
    this.settings = await this.loadDataWithDefaults();

    this.addCommand({
      id: 'sync-inkloop-now',
      name: 'Sync now',
      callback: () => this.syncNow(),
    });

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.onVaultRename(file, oldPath);
      })
    );

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        this.onVaultModify(file);
      })
    );
  }

  async writeKnowledgeObject(plan: ObsidianMarkdownRenderPlan) {
    const path = normalizePath(plan.file.relative_path);
    const file = this.app.vault.getAbstractFileByPath(path);

    if (!file) {
      await this.ensureParentFolders(path);
      await this.app.vault.create(path, composeNewMarkdown(plan));
      return;
    }

    if (!(file instanceof TFile)) {
      throw new Error('Target path is not a file');
    }

    await this.app.vault.process(file, (current) => {
      const parsed = parseInkLoopMarkdown(current);
      const next = reconcileControlledSection(parsed, plan);
      return next;
    });

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      mergeInkLoopFrontmatter(fm, plan.file.frontmatter);
    });
  }
}
```

### 12.6 插件事件处理

```ts
async function onVaultRename(file: TAbstractFile, oldPath: string) {
  if (!(file instanceof TFile)) return;
  if (!file.path.startsWith(settings.base_folder)) return;

  const fm = await readFrontmatter(file);
  const koId = fm.inkloop_id;
  if (!koId) return;

  await reportToInkLoop({
    type: 'remote_renamed',
    ko_id: koId,
    old_path: oldPath,
    new_path: file.path,
  });
}

async function onVaultModify(file: TAbstractFile) {
  if (!(file instanceof TFile)) return;
  if (!file.path.startsWith(settings.base_folder)) return;

  debounce(file.path, async () => {
    const fm = await readFrontmatter(file);
    if (!fm.inkloop_id) return;

    await reportToInkLoop({
      type: 'remote_metadata_changed',
      ko_id: fm.inkloop_id,
      status: fm.status,
      tags: fm.tags,
      remote_path: file.path,
      remote_hash: hashControlledSection(await vault.cachedRead(file)),
    });
  });
}
```

### 12.7 插件安全策略

插件 README 必须清楚披露：

```text
1. 是否需要 InkLoop 账号。
2. 是否访问网络。
3. 发送哪些字段到 InkLoop。
4. 是否读取用户 Vault 中 InkLoop 文件夹以外的内容。
5. 是否上传笔记正文。
6. 是否包含遥测。
```

默认策略：

```text
- 只读取 InkLoop/ 文件夹。
- 只回传 frontmatter metadata 和 controlled section hash。
- 不上传用户在 Obsidian 写的自由正文。
- 不做客户端 telemetry。
```

---

## 13. Obsidian URI 设计

### 13.1 Open in Obsidian

从 InkLoop UI 打开 Obsidian 文件：

```text
obsidian://open?vault=<encoded_vault_name>&file=<encoded_relative_path>
```

示例：

```text
obsidian://open?vault=Second%20Brain&file=InkLoop%2FNotes%2F2026%2F2026-06%2Fai-note--attention--p12--ko_01JZ7D5E.md
```

### 13.2 Open in InkLoop

Obsidian Markdown 内写回链：

```md
Open in InkLoop: [link](inkloop://doc/doc_abc/page/12?anchor=obj_p12_0345)
```

InkLoop App 需要注册自定义协议：

```text
inkloop://doc/<document_id>
inkloop://doc/<document_id>/page/<page_index>?anchor=<object_id>
inkloop://ko/<ko_id>
inkloop://mark/<mark_id>
```

### 13.3 不用 URI 写入

禁止使用 URI 完成这些操作：

```text
append
prepend
overwrite
sync
conflict resolution
receipt reporting
```

原因：这些操作必须有 read-modify-write、hash、receipt、错误码和重试机制。

---

## 14. Obsidian Mapping：KO → Markdown

### 14.1 Kind 映射

| KnowledgeKind | 目录 | 文件前缀 | callout | status 默认 |
|---|---|---|---|---|
| `source_document` | `Sources/` | source | info | exported |
| `excerpt` | `Excerpts/YYYY/YYYY-MM/` | excerpt | quote | exported |
| `annotation` | `Notes/YYYY/YYYY-MM/` | annotation | note | exported |
| `ai_note` | `Notes/YYYY/YYYY-MM/` | ai-note | note | exported |
| `qa` | `Notes/YYYY/YYYY-MM/` | qa | question | exported |
| `summary` | `Notes/YYYY/YYYY-MM/` | summary | summary | exported |
| `task` | `Tasks/YYYY/YYYY-MM/` | task | todo | inbox |
| `concept` | `Notes/YYYY/YYYY-MM/` | concept | tip | exported |

### 14.2 Tag 映射

InkLoop tags → YAML tags：

```yaml
tags:
  - inkloop
  - inkloop/ai-note
  - reading
  - transformer
```

规则：

1. 默认附加 `inkloop`。
2. 默认附加 `inkloop/<kind-kebab>`。
3. 用户 tags 保留。
4. 从 Obsidian pullback tags 时，只 merge，不删除 InkLoop 内已有 tag。

### 14.3 Status 映射

| InkLoop status | Obsidian status | 回收策略 |
|---|---|---|
| `inbox` | `inbox` | 双向 |
| `accepted` | `accepted` | InkLoop 主导 |
| `export_ready` | 不写或 `ready` | InkLoop 主导 |
| `exported` | `exported` | 双向 |
| `archived` | `archived` | 双向 |
| `dismissed` | `dismissed` | InkLoop 主导 |

如果用户在 Obsidian 把 status 改成未知值：

```text
不覆盖 InkLoop status，记录 remote_metadata_changed，并在 UI 展示“未知远端状态”。
```

### 14.4 Task 映射

`KnowledgeKind = task` 的 Markdown：

```md
---
inkloop_id: ko_...
inkloop_kind: task
status: inbox
task_done: false
due: 2026-07-01
---

# Review transformer positional encoding

<!-- inkloop:begin ko_... hash=sha256:... -->
- [ ] Review transformer positional encoding
<!-- inkloop:end ko_... -->

Source: [InkLoop](inkloop://doc/doc_abc/page/12?anchor=obj_p12_0345)
```

Pullback：

```text
- frontmatter.task_done
- Markdown checkbox controlled section 中的 [x]
```

优先级：

```text
frontmatter.task_done > controlled checkbox
```

如果用户把 controlled checkbox 改了，视为 metadata change，不视为正文冲突。

---

## 15. Obsidian 冲突场景全集

### 15.1 场景 A：重复导出

输入：同一个 KO 重复导出。

判断：

```text
binding 存在 && remote file 存在 && content_hash 未变
```

行为：

```text
skip，更新 last_checked_at。
```

### 15.2 场景 B：KO 内容变化，远端未变

判断：

```text
KO.content_hash != binding.content_hash
remote controlled hash == binding.render_hash
```

行为：

```text
替换 controlled section，更新 frontmatter inkloop_content_hash / inkloop_render_hash。
```

### 15.3 场景 C：KO 内容未变，用户改了自由区域

判断：

```text
KO.content_hash == binding.content_hash
remote controlled hash == binding.render_hash
file mtime changed
```

行为：

```text
不处理正文；可 pullback status/tags；binding.remote_rev 更新。
```

### 15.4 场景 D：用户改了 controlled section

判断：

```text
remote controlled hash != binding.render_hash
```

行为：

```text
标记 remote_changed。
如果本次也要推新内容，按 policy 处理，默认 append_new_version。
```

### 15.5 场景 E：用户删除了 controlled section

判断：

```text
frontmatter.inkloop_id == ko_id
controlled section missing
binding.mapping.controlled_region_id exists
```

行为：

```text
标记 conflict；默认 append_new_version 或 create_conflict_copy。
```

### 15.6 场景 F：用户重命名/移动文件

判断：

```text
binding.remote_path 不存在
scan InkLoop folder 找到 frontmatter.inkloop_id == ko_id
```

行为：

```text
更新 binding.remote_path，不创建新文件。
```

### 15.7 场景 G：用户删除文件

判断：

```text
binding.remote_path 不存在
scan 找不到 ko_id
```

行为：

```text
binding.sync_state = remote_deleted。
不删除 KO。
UI 提供 recreate / forget binding。
```

### 15.8 场景 H：多个文件有同一个 inkloop_id

判断：

```text
scan 找到 2+ notes with same inkloop_id
```

行为：

```text
binding.sync_state = conflict。
不写任何文件。
UI 要求用户选择保留哪个。
```

### 15.9 场景 I：用户改 frontmatter inkloop_id

判断：

```text
binding path 的 note frontmatter.inkloop_id != binding.entity_id
```

行为：

```text
不要覆盖。
扫描旧 ko_id；找不到则 remote_deleted；找到多个则 conflict。
```

### 15.10 场景 J：用户把文件移出 InkLoop/ 文件夹

FS Adapter：

```text
默认扫描范围是 InkLoop/，找不到则 remote_deleted。
高级设置可允许扫描整个 vault，但默认关闭，避免性能和隐私问题。
```

Plugin Adapter：

```text
监听 rename；如果文件移出 base_folder，可提示用户是否继续跟踪。
默认停止自动更新，但保留 binding path。
```

---

## 16. Storage 设计

### 16.1 本地 IndexedDB / SQLite 逻辑表

```sql
-- Append-only event store
ledger_events(
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_device_id TEXT,
  actor_app TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  synced_at TEXT
);

-- Materialized views
ink_documents(
  document_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ink_marks(
  mark_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  tombstoned_at TEXT,
  updated_at TEXT NOT NULL
);

ai_turns(
  ai_turn_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  supersedes TEXT,
  updated_at TEXT NOT NULL
);

knowledge_objects(
  ko_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  privacy TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

external_bindings(
  binding_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  target_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  remote_path TEXT,
  remote_url TEXT,
  remote_rev TEXT,
  remote_hash TEXT,
  mapping_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  render_hash TEXT NOT NULL,
  sync_state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, target_id, entity_type, entity_id)
);

sync_jobs(
  job_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  target_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_run_at TEXT,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 16.2 索引

```sql
CREATE INDEX idx_ledger_entity ON ledger_events(entity_type, entity_id, created_at);
CREATE INDEX idx_ledger_workspace_time ON ledger_events(workspace_id, created_at);
CREATE INDEX idx_ko_workspace_status ON knowledge_objects(workspace_id, status, updated_at);
CREATE INDEX idx_binding_entity ON external_bindings(entity_type, entity_id);
CREATE INDEX idx_binding_provider_target ON external_bindings(provider, target_id, sync_state);
CREATE INDEX idx_sync_jobs_status ON sync_jobs(status, next_run_at, priority);
```

---

## 17. API 设计

### 17.1 Knowledge API

#### `POST /api/v1/knowledge/build`

把 mark / ai_turn / session 转成 KO。

请求：

```json
{
  "workspace_id": "ws_default",
  "document_id": "doc_abc",
  "mark_ids": ["mark_1", "mark_2"],
  "ai_turn_ids": ["aiturn_1"],
  "session_id": "sess_1",
  "mode": "ai_note"
}
```

响应：

```json
{
  "knowledge_objects": [
    {
      "ko_id": "ko_...",
      "kind": "ai_note",
      "title": "AI Note · ...",
      "status": "export_ready",
      "content_hash": "sha256:..."
    }
  ]
}
```

### 17.2 Adapter API

#### `GET /api/v1/adapters`

返回支持的 adapters。

```json
[
  {
    "provider": "obsidian_fs",
    "display_name": "Obsidian Vault",
    "direction": "bidirectional_limited",
    "auth": "local_fs"
  }
]
```

#### `POST /api/v1/adapter-targets`

创建目标。

```json
{
  "provider": "obsidian_fs",
  "display_name": "Second Brain",
  "config": {
    "vault_name": "Second Brain",
    "vault_root_path": "/Users/me/Obsidian/Second Brain",
    "base_folder": "InkLoop"
  }
}
```

#### `POST /api/v1/adapters/:provider/preview`

```json
{
  "target_id": "target_obsidian_abc",
  "ko_ids": ["ko_1"],
  "policy": {
    "content_authority": "inkloop",
    "metadata_authority": "merge",
    "conflict_strategy": "append_new_version",
    "privacy_filter": ["export_allowed"],
    "include_assets": "none"
  }
}
```

响应：

```json
{
  "previews": [
    {
      "ko_id": "ko_1",
      "provider": "obsidian_fs",
      "relative_path": "InkLoop/Notes/2026/2026-06/ai-note--doc--p12--ko_1.md",
      "markdown_preview": "---\ninkloop_id: ko_1\n---\n# ...",
      "will_create": true,
      "will_update": false,
      "warnings": []
    }
  ]
}
```

#### `POST /api/v1/adapters/:provider/export`

创建 sync job。

```json
{
  "target_id": "target_obsidian_abc",
  "ko_ids": ["ko_1"],
  "policy": {
    "content_authority": "inkloop",
    "metadata_authority": "merge",
    "conflict_strategy": "append_new_version",
    "privacy_filter": ["export_allowed"],
    "remote_delete_behavior": "mark_remote_deleted",
    "local_delete_behavior": "keep_remote",
    "include_assets": "none"
  }
}
```

响应：

```json
{
  "job_id": "syncjob_...",
  "status": "queued"
}
```

#### `GET /api/v1/sync/jobs/:job_id`

```json
{
  "job_id": "syncjob_...",
  "status": "succeeded",
  "result": {
    "created": 1,
    "updated": 0,
    "skipped": 0,
    "conflicted": 0,
    "remote_urls": ["obsidian://open?vault=Second%20Brain&file=InkLoop%2FNotes%2F..."]
  }
}
```

### 17.3 Obsidian Plugin API

#### `GET /api/v1/obsidian-plugin/pending-jobs`

插件拉取待处理任务。

```json
{
  "workspace_id": "ws_default",
  "target_id": "target_obsidian_plugin_abc",
  "cursor": "cursor_123"
}
```

响应：

```json
{
  "jobs": [
    {
      "job_id": "syncjob_1",
      "render_plans": []
    }
  ],
  "next_cursor": "cursor_124"
}
```

#### `POST /api/v1/obsidian-plugin/receipts`

插件回传写入结果。

```json
{
  "job_id": "syncjob_1",
  "receipts": [
    {
      "ko_id": "ko_1",
      "status": "updated",
      "remote_path": "InkLoop/Notes/...md",
      "remote_hash": "sha256:...",
      "remote_rev": "mtime:178...",
      "remote_url": "obsidian://open?..."
    }
  ]
}
```

#### `POST /api/v1/obsidian-plugin/events`

插件上报 rename / modify / delete。

```json
{
  "events": [
    {
      "type": "remote_metadata_changed",
      "ko_id": "ko_1",
      "remote_path": "InkLoop/Notes/...md",
      "status": "archived",
      "tags": ["inkloop", "done"],
      "remote_hash": "sha256:...",
      "occurred_at": "2026-06-26T02:20:00.000Z"
    }
  ]
}
```

---

## 18. Privacy / 安全 / 审计

### 18.1 默认导出最小化

默认导出到 Obsidian 的内容：

```text
- KO title
- KO body_md
- source document title
- page index
- selected quote
- inkloop URI
- object refs
- anchor bbox
- provenance ids
```

默认不导出：

```text
- 原始 PDF
- 原始 strokes 点序
- 完整页面截图
- 完整 OCR 文本层
- 完整 HMP 细节
- 用户未确认的 local_only 内容
```

### 18.2 导出前 Preview

所有外部导出必须有 preview：

```text
将导出到：Second Brain / InkLoop/Notes/...
将发送/写入：标题、AI 旁注、原文摘录、页码、InkLoop 回链
不会写入：原始 PDF、原始笔迹、完整页面截图
```

### 18.3 AuditLog

```ts
export interface AuditLog {
  schema_version: 'inkloop.audit.v1';

  audit_id: string;
  workspace_id: string;
  actor: ActorRef;

  action:
 | 'adapter.previewed'
 | 'adapter.exported'
 | 'adapter.conflict_detected'
 | 'adapter.pullback_applied'
 | 'adapter.permission_denied'
 | 'privacy.export_blocked';

  entity_refs: EntityRef[];

  provider?: ExternalProvider;
  target_id?: string;

  data_classes: Array<
 | 'title'
 | 'source_quote'
 | 'ai_note'
 | 'tags'
 | 'anchor_bbox'
 | 'object_refs'
 | 'asset_crop'
  >;

  created_at: ISODateTime;
}
```

---

## 19. Migration：从当前 Web Demo 迁移

### 19.1 当前 IndexedDB Store

当前已有：

```text
docs
pdf_blobs
marks
ai_turns
```

迁移目标：

```text
docs             → ink_documents materialized view
pdf_blobs        → assets store
marks            → ledger_events + ink_marks view
ai_turns         → ledger_events + ai_turns view + optional knowledge_objects
```

### 19.2 迁移步骤

#### Step 1：引入 schema validator

```text
packages/schema 增加 Zod validators。
现有写入 paths 先 validate，再存旧 store。
```

#### Step 2：LedgerEvent envelope

现有 marks 写入时同时写：

```text
ledger_events: mark.created
```

擦除写：

```text
ledger_events: mark.tombstoned
```

AI 回复写：

```text
ledger_events: ai_turn.created
```

旁注编辑/忽略写：

```text
ledger_events: ai_turn.superseded 或 overlay.state_changed
```

#### Step 3：KnowledgeObject builder

用户点击“收下”时：

```text
AiTurn + Mark + HMP → KnowledgeObject
ledger_events: knowledge_object.created
```

#### Step 4：Adapter preview only

先做 preview，不真正写 Obsidian。验证：

```text
同一个 KO 生成稳定 Markdown
hash 稳定
路径稳定
```

#### Step 5：Obsidian FS Adapter 写入

启用真正导出。

#### Step 6：Pullback status/tags

只做 metadata 回收。

---

## 20. Sync Engine

### 20.1 Job 状态机

```text
queued
  ↓
running
  ├── succeeded
  ├── failed retryable → queued
  ├── failed non-retryable → failed
  ├── conflict → blocked
  └── privacy blocked → blocked
```

### 20.2 Retry 策略

```ts
const retryDelays = [5_000, 30_000, 120_000, 600_000, 1800_000];
```

仅这些错误自动重试：

```text
NETWORK_ERROR
RATE_LIMITED
TEMPORARY_IO_ERROR
REMOTE_LOCKED
```

不重试：

```text
PRIVACY_BLOCKED
CONFLICT
PERMISSION_DENIED
CONFIG_INVALID
```

### 20.3 批量导出

批量导出时，每个 KO 独立处理，不能一个失败阻塞全部。

```json
{
  "result": {
    "created": 12,
    "updated": 3,
    "skipped": 40,
    "conflicted": 2,
    "failed": 1
  }
}
```

### 20.4 Rate Limit

Obsidian FS 无网络 rate limit，但要避免频繁写盘：

```text
interactive job：立即写
background job：合并 2 秒内的同 target 更新
source index：批量更新，一次写完
```

---

## 21. Testing Plan

### 21.1 Schema Tests

```text
- 每个 schema 有 valid fixture / invalid fixture。
- 所有对象必须有 schema_version。
- 所有 id 前缀必须正确。
- NormBBox 范围校验。
- content_hash canonicalization 稳定。
- LedgerEvent idempotency_key 重复写入不重复。
```

### 21.2 KnowledgeBuilder Tests

```text
- Mark only → excerpt。
- Mark + handwriting note → annotation。
- Handwriting question + AiTurn → qa。
- AiTurn explanation → ai_note。
- Multi-mark session → summary。
- Actionable handwriting → task。
- source.quote 为空时仍能导出，但提示无 quote。
```

### 21.3 Markdown Renderer Golden Tests

每个 KO kind 一份 golden Markdown：

```text
fixtures/obsidian-renderer/ai_note.input.json
fixtures/obsidian-renderer/ai_note.expected.md
```

校验：

```text
- frontmatter 完整。
- controlled markers 正确。
- render_hash 稳定。
- Obsidian wikilink escape 正确。
- 中文标题、emoji、斜杠、冒号、换行均正确。
```

### 21.4 Obsidian FS Integration Tests

创建临时 vault 目录：

```text
/tmp/inkloop-test-vault
```

用例：

```text
1. 初次导出，创建文件。
2. 重复导出，skip。
3. KO 内容变化，更新 controlled section。
4. 用户改自由区域，保留。
5. 用户改 controlled section，conflict。
6. 用户删除 controlled marker，conflict。
7. 用户重命名文件，scan 找回。
8. 用户删除文件，remote_deleted。
9. 同一个 ko_id 出现两个文件，conflict。
10. tags/status 被用户修改，pullback 成功。
```

### 21.5 Plugin Tests

```text
- Vault.process 更新正文。
- FileManager.processFrontMatter 更新 frontmatter。
- rename event 上报 path change。
- modify event debounce。
- 移动端不 import fs/path/electron。
- requestUrl token 错误时提示 reauthorize。
```

### 21.6 Privacy Tests

```text
- local_only KO 被导出时 blocked。
- include_anchor_crop=false 时不写 assets。
- raw strokes 永不出现在 Markdown。
- 完整 PDF asset 不被复制到 Vault。
- Preview 中列出将导出的字段。
```

---

## 22. 研发里程碑

### Sprint 1：Schema + Ledger Envelope

交付：

```text
@inkloop/schema
@inkloop/ledger
validators
hash canonicalization
```

验收：

```text
- 当前 Web demo 不坏。
- marks / ai_turns 仍能恢复。
- 新增 ledger_events。
- event 重复写入不重复。
```

### Sprint 2：KnowledgeBuilder

交付：

```text
@inkloop/knowledge-builder
buildKnowledgeObject()
KO materialized store
```

验收：

```text
- 用户收下 AI 旁注后生成 KO。
- KO 能稳定 hash。
- KO 能在 UI 中列表展示。
```

### Sprint 3：Adapter Core + Preview

交付：

```text
@inkloop/adapter-core
AdapterManifest
AdapterTarget
RenderPlan
Preview API
```

验收：

```text
- 选择 Obsidian target 后可预览 Markdown。
- 不写盘。
- privacy blocked 正常工作。
```

### Sprint 4：Markdown Renderer

交付：

```text
@inkloop/adapter-markdown
frontmatter renderer
controlled section renderer
slug / path strategy
golden tests
```

验收：

```text
- 8 种 KO kind 都能生成 Markdown。
- render_hash 稳定。
- 中文/特殊字符路径安全。
```

### Sprint 5：Obsidian FS Adapter

交付：

```text
@inkloop/adapter-obsidian-fs
vault folder picker
upsert
binding
conflict detection
open URI
```

验收：

```text
- 初次导出创建 note。
- 重复导出不重复。
- 修改 KO 后更新受控区块。
- 用户自由编辑不丢。
- 用户改受控区块不被覆盖。
- open in Obsidian 可用。
```

### Sprint 6：Pullback + Sync Engine

交付：

```text
sync queue
background check
frontmatter status/tags pullback
remote_deleted / remote_changed
```

验收：

```text
- Obsidian 改 status 为 archived，InkLoop 里同步。
- Obsidian 增加 tag，InkLoop merge。
- 删除文件后 InkLoop 显示 remote_deleted。
```

### Sprint 7：Obsidian Plugin Spike

交付：

```text
Obsidian plugin prototype
settings
sync command
Vault API write
rename/modify event reporting
```

验收：

```text
- 插件能从 InkLoop Cloud 拉一个 render plan 并写入 Vault。
- 能上报 rename。
- 能上报 status/tags 修改。
- 移动端兼容性初测。
```

---

## 23. 默认产品交互

### 23.1 导出入口

在 AI 旁注卡片上：

```text
[收下] [导出] [稍后] [忽略]
```

点击导出：

```text
选择目标：Obsidian / Notion / Markdown
选择 Vault：Second Brain
预览：将创建 1 个 note，更新 1 个 source index
确认导出
```

### 23.2 导出成功

```text
已导出到 Obsidian
[打开 Obsidian] [复制 Markdown] [查看同步详情]
```

### 23.3 冲突提示

```text
Obsidian 中这条 InkLoop 内容被编辑过。
为了避免覆盖你的笔记，InkLoop 没有自动替换。

选择：
[追加新版本] [查看差异] [跳过] [强制覆盖]
```

默认按钮：`追加新版本`。

### 23.4 删除提示

```text
Obsidian 文件似乎被删除或移走了。

选择：
[重新创建] [忘记这个外部链接] [稍后处理]
```

---

## 24. 工程注意事项

### 24.1 不要混淆两个 Adapter

本方案里的 `InkLoop Adapter`：

```text
InkLoop 内部用于对接外部 App 的抽象层。
```

Obsidian 官方的 `DataAdapter`：

```text
Obsidian 内部低层文件适配 API。
```

Obsidian 插件里应优先使用 Vault API；只有隐藏文件或特殊文件系统需求才考虑 DataAdapter。

### 24.2 Web 端不要承诺写 Obsidian Vault

Web 端可：

```text
- 生成 Markdown 下载。
- 复制 Markdown。
- 打开 Obsidian URI。
- 通过 Obsidian Plugin Cloud Pull 间接同步。
```

Web 端不应该默认：

```text
- 直接写本地 Vault。
- 长期保存本地文件夹权限。
- 扫描用户本地 Obsidian 文件。
```

### 24.3 Mobile 端不要直接写 Vault

移动端应该：

```text
- 发送到 InkLoop Cloud。
- 由 Obsidian Plugin 在 Obsidian 内 pull。
- 或导出 Markdown share sheet 给用户。
```

不要设计成移动端直接访问 Obsidian Vault 文件系统。

### 24.4 不要把完整 HMP 塞进 Markdown

Markdown frontmatter 只放必要回链信息：

```text
object_refs
anchor_bbox
source doc/page
provenance ids
```

完整 HMP 留在 InkLoop。

### 24.5 不要做全文双向同步

如果用户在 Obsidian 改了 AI note 的正文，v1 只能：

```text
记录 remote_changed
展示 diff
允许用户手动导入为“外部笔记”
```

不能自动覆盖 InkLoop 的 AI reply 或 KO body。

---

## 25. 验收标准总表

| 模块 | 必须通过 |
|---|---|
| Schema | 所有对象 runtime validate；hash 稳定 |
| Ledger | append-only；tombstone/supersedes 可 fold |
| KnowledgeBuilder | Mark/AiTurn 可生成 KO；source anchor 完整 |
| Adapter Core | preview/export/job/binding 全链路跑通 |
| Obsidian Renderer | Markdown 可读；frontmatter 完整；controlled section 稳定 |
| Obsidian FS | create/update/skip/conflict/delete/rename 全覆盖 |
| Pullback | status/tags/task done 可回收，正文不回收 |
| Privacy | local_only 阻止导出；raw strokes/PDF 不外泄 |
| UX | 导出前可预览；冲突不覆盖；成功可打开 Obsidian |
| Tests | golden tests + temp vault integration tests + conflict tests |

---

## 26. 最终要求

工程上请按这个顺序做：

```text
1. Schema 固化
2. LedgerEvent envelope
3. KnowledgeObject Builder
4. Adapter Core
5. Markdown Renderer
6. Obsidian FS Adapter
7. Sync Engine + Pullback
8. Obsidian Plugin
9. Notion / Zotero / Readwise 等其他 Adapter
```

最重要的边界不要变：

```text
InkLoop Core 保存真实思考现场。
KnowledgeObject 是外部可理解的语义卡片。
Adapter 只是投影，不是新的真相源。
Obsidian 只做 Markdown 知识库同步，不承担原始标注和回屏坐标系统。
```

这样设计的好处是：

```text
- Notion / Obsidian / Markdown / Zotero 后续都能复用同一套 Adapter Core。
- Obsidian 用户可安心编辑自己的笔记，不怕 InkLoop 覆盖。
- InkLoop 自己的原始笔迹、HMP、AI 回屏、对象锚点保持完整。
- 将来做桌面端、墨水屏端、移动端、Web 端，都共享同一套 Schema 与同步语义。
```

---

## Appendix A：Obsidian 完整 Markdown 示例

```md
---
inkloop_schema: inkloop.obsidian_note.v1
inkloop_id: ko_01JZ7D5E7WJK4F5NTAT9QCJBW2
inkloop_kind: ai_note
inkloop_binding_id: bind_01JZ7D5KHZ0P70ZD8CD2EJ7VHY
inkloop_content_hash: sha256:abc123
inkloop_render_hash: sha256:def456
inkloop_source_doc_id: doc_abc
inkloop_source_doc_title: "Attention Is All You Need"
inkloop_source_page: 12
inkloop_source_object_refs:
  - obj_p12_0345
  - obj_p12_0346
inkloop_anchor_bbox: [0.12, 0.34, 0.18, 0.04]
inkloop_uri: "inkloop://doc/doc_abc/page/12?anchor=obj_p12_0345"
status: exported
tags:
  - inkloop
  - inkloop/ai-note
  - reading
  - transformer
created: 2026-06-26T02:10:00.000Z
updated: 2026-06-26T02:10:00.000Z
---

# AI Note · Attention Is All You Need · p12

> [!info] Source
> Document: [[Attention Is All You Need--doc_abc|Attention Is All You Need]]  
> Page: 12  
> Open in InkLoop: [link](inkloop://doc/doc_abc/page/12?anchor=obj_p12_0345)

> [!quote] Source quote
> Scaled dot-product attention...

<!-- inkloop:begin ko_01JZ7D5E7WJK4F5NTAT9QCJBW2 hash=sha256:def456 -->
> [!note] InkLoop
> 这里的关键点是 Q/K/V 的角色分离：K 用来匹配，V 才是被聚合的信息。
<!-- inkloop:end ko_01JZ7D5E7WJK4F5NTAT9QCJBW2 -->

## Context

- Source object refs: `obj_p12_0345`, `obj_p12_0346`
- Anchor bbox: `[0.12, 0.34, 0.18, 0.04]`
- Generated from: `mark_01JZ7D4V7TDQR2C0DB4D9N20TC`
- AI turn: `aiturn_01JZ7D52KKF1N9NR86RDP77E2D`

## My notes

<!-- User-owned area. InkLoop must not overwrite this section. -->
```

---

## Appendix B：ExternalBinding 示例

```json
{
  "schema_version": "inkloop.external_binding.v1",
  "binding_id": "bind_01JZ7D5KHZ0P70ZD8CD2EJ7VHY",
  "workspace_id": "ws_default",
  "provider": "obsidian_fs",
  "target_id": "target_obsidian_vault_sha256_abcd",
  "entity_type": "knowledge_object",
  "entity_id": "ko_01JZ7D5E7WJK4F5NTAT9QCJBW2",
  "remote": {
    "remote_id": "InkLoop/Notes/2026/2026-06/ai-note--attention-is-all-you-need--p12--ko_01JZ7D5E.md",
    "remote_path": "InkLoop/Notes/2026/2026-06/ai-note--attention-is-all-you-need--p12--ko_01JZ7D5E.md",
    "remote_url": "obsidian://open?vault=Second%20Brain&file=InkLoop%2FNotes%2F2026%2F2026-06%2Fai-note--attention-is-all-you-need--p12--ko_01JZ7D5E.md",
    "remote_rev": "mtime:1782450000000",
    "remote_hash": "sha256:def456"
  },
  "mapping": {
    "mapping_version": "obsidian.markdown.v1",
    "content_hash": "sha256:abc123",
    "render_hash": "sha256:def456",
    "controlled_region_id": "ko_01JZ7D5E7WJK4F5NTAT9QCJBW2"
  },
  "sync_state": "active",
  "last_synced_at": "2026-06-26T02:10:00.000Z",
  "last_checked_at": "2026-06-26T02:10:00.000Z",
  "created_at": "2026-06-26T02:10:00.000Z",
  "updated_at": "2026-06-26T02:10:00.000Z"
}
```

---

## Appendix C：最小实现清单

第一版最少代码路径：

```text
packages/schema/knowledge-object.ts
packages/schema/external-binding.ts
packages/knowledge-builder/build-from-ai-turn.ts
packages/adapter-core/adapter.ts
packages/adapter-core/sync-policy.ts
packages/adapters/markdown/frontmatter.ts
packages/adapters/markdown/controlled-section.ts
packages/adapters/markdown/markdown-renderer.ts
packages/adapters/obsidian-fs/adapter.ts
packages/adapters/obsidian-fs/file-resolver.ts
packages/adapters/obsidian-fs/obsidian-uri.ts
packages/sync-engine/queue.ts
```

第一版最少 UI：

```text
1. AI 旁注卡片上出现“导出到 Obsidian”。
2. 第一次导出时选择 Vault 文件夹。
3. 显示 Markdown preview。
4. 确认后写入 Markdown。
5. 成功后打开 Obsidian URI。
6. 冲突时显示“追加新版本 / 跳过”。
```
