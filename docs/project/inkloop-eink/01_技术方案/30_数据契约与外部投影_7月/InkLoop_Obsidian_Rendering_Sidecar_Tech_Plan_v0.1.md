# InkLoop ↔ Obsidian 渲染与隐藏 Sidecar 技术方案 v0.1

> 目标：在不污染用户原生 Markdown / PDF 文件的前提下，让 Obsidian 插件能够渲染 InkLoop 的预览模式、编辑模式、AI 旁注、手写/打字修改、PDF 标注、新建文件，并与现有 KnowledgeObject / Adapter 契约保持自洽。

---

## 0. 一句话结论

实现方式方式是：

```text
Native Source File + Hidden Sidecar Store + SourceAdapter + InkLoop Renderer View + KO Export Adapter
```

具体解释：

```text
用户原生文件：
  .md / .pdf / .canvas / image / scan
  保持原生，不写入 InkLoop frontmatter、HTML comment、block id 或受控区块。

InkLoop 隐藏数据：
  <Vault>/.inkloop/
  保存文档身份、SurfaceIndex、Markdown block map、PDF page object map、无限画布节点、笔迹、AI overlay、KO、同步索引。

Obsidian 插件：
  读取原生文件 + sidecar，打开一个 InkLoop View。
  预览模式：原生内容 + InkLoop overlay / AI gutter。
  编辑模式：无限画布，用户手写/打字默认写入 sidecar，不污染源文件。

KnowledgeObject / Adapter：
  只用于“导出知识对象到 Obsidian/Notion/Markdown”等外部投影。
  不能承担完整文档渲染职责。
```

核心原则：

> **用户文件是用户的，InkLoop 状态是 InkLoop 的。二者通过 sidecar 绑定，不把 InkLoop 内部协议塞进用户文件。**

---

## 1. 先把概念切开：这里其实有两类 Adapter

之前我们一直说“Adapter 只吃 KnowledgeObject”，这个口径仍然成立，但它只适用于“外部导出适配器”。现在讨论 Obsidian 插件里的完整渲染，就必须再拆出一类新的 adapter。

### 1.1 Export Adapter：外部知识投影

用途：把 InkLoop 的知识对象投影到外部系统。

```text
KnowledgeObject
  → Obsidian Markdown note
  → Notion page
  → Readwise highlight
  → Zotero note
```

特征：

- 只吃 `KnowledgeObject`。
- 不碰 Stroke / HMP / Mark / InferenceView / 基岩。
- 生成的是“知识卡片 / 摘录 / AI note / task / summary”。
- 适合 Notion、Obsidian、Markdown、Zotero、Readwise。

### 1.2 Source Adapter：原生文件转 InkLoop 可渲染对象

用途：把不同源文件统一转成 InkLoop Runtime 能渲染、能锚定、能标注的 `RenderableDocument`。

```text
MarkdownSourceAdapter
PdfSourceAdapter
ImageSourceAdapter
InkCanvasSourceAdapter
```

特征：

- 读取原生文件。
- 构建 `SurfaceObject` / `SourceMap`。
- 负责不同格式的锚点、重映射、渲染入口。
- 给 InkLoop Preview/Edit View 使用。
- 不负责向 Notion/Obsidian 导出 KO。

### 1.3 两者的关系

```text
原生文件 / PDF / Markdown
        │
        ▼
SourceAdapter
        │
        ▼
RenderableDocument + SidecarState
        │
        ├── InkLoop Renderer：预览 / 编辑 / AI gutter / 无限画布
        │
        └── KnowledgeBuilder：生成 KnowledgeObject
                    │
                    ▼
              ExportAdapter：导出到 Obsidian note / Notion page
```

所以，Obsidian 插件有两个职责：

1. **InkLoop Renderer Plugin**：负责打开原生文件 + sidecar，渲染 InkLoop 体验。
2. **Obsidian Export Adapter**：负责把 KO 导出成 Obsidian note。

这两个模块可同在一个插件仓库里，但数据契约不要混在一起。

---

## 2. 总体架构

```text
┌────────────────────────────────────────────────────────────┐
│                     Obsidian Vault                         │
│                                                            │
│  用户可见原生文件                                          │
│  ├── Research/Attention.md                                 │
│  ├── Papers/Attention.pdf                                  │
│  └── Notes/My Idea.md                                      │
│                                                            │
│  InkLoop 隐藏 sidecar                                      │
│  └── .inkloop/                                             │
│      ├── manifest.json                                     │
│      ├── indexes/                                          │
│      │   ├── path-index.json                               │
│      │   ├── doc-index.json                                │
│      │   └── ko-index.json                                 │
│      ├── docs/                                             │
│      │   └── doc_xxx/                                      │
│      │       ├── document.json                             │
│      │       ├── source.json                               │
│      │       ├── revisions.jsonl                           │
│      │       ├── surfaces/                                 │
│      │       ├── canvas/                                   │
│      │       ├── marks/                                    │
│      │       ├── overlays/                                 │
│      │       ├── knowledge/                                │
│      │       └── assets/                                   │
│      ├── assets/                                           │
│      ├── outbox/                                           │
│      ├── inbox/                                            │
│      └── logs/                                             │
│                                                            │
└────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────────────────┐
│                  InkLoop Obsidian Plugin                   │
│                                                            │
│  FileResolver                                              │
│  SidecarStore                                              │
│  MarkdownSourceAdapter                                     │
│  PdfSourceAdapter                                          │
│  InkCanvasSourceAdapter                                    │
│  RenderableDocumentBuilder                                 │
│  InkLoopRendererView                                       │
│  KOExportAdapter                                           │
│  Sync / Conflict / Binding                                 │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 2.1 用户文件不污染

默认情况下，InkLoop 不写入：

```text
frontmatter
HTML comment
Obsidian block id，例如 ^abc123
Markdown link
受控区块
隐藏标题
```

用户的 `.md` 文件应该保持像这样：

```md
# Attention Notes

Transformer 的核心是 self-attention。

这个地方我还没完全理解。
```

InkLoop 的笔迹、AI 旁注、锚点、画布修改全部放在：

```text
<Vault>/.inkloop/docs/doc_xxx/
```

### 2.2 为什么不写入 Markdown frontmatter？

frontmatter 可提升身份稳定性，但它有明显代价：

- 污染用户原始文件。
- 会影响 Git diff。
- 会被 Notion / 静态站点 / 发布系统读取。
- 用户可能手动改掉。
- 与“兼容原生 Markdown，不破坏用户文件”的目标冲突。

所以默认使用 **Zero Pollution Mode**。

可保留一个高级设置：

```text
Link stability mode:
  - zero_pollution：默认；所有 InkLoop 身份只存在 sidecar。
  - soft_marker：可选；在 frontmatter 写入 inkloop_id，提高跨工具重命名稳定性。
```

v1 默认只做 `zero_pollution`。

---

## 3. 隐藏 Sidecar 存储位置

选定默认：

```text
<Vault>/.inkloop/
```

### 3.1 为什么放在 Vault 内？

优点：

- 跟随 Vault 一起移动。
- 用户用 Git / Dropbox / iCloud / Syncthing 时，InkLoop 状态可一起走。
- Obsidian 插件和 InkLoop Desktop 都能通过同一套路径找到数据。
- 对用户可见内容零污染。

风险：

- 隐藏目录是否被同步，取决于用户的同步工具配置。
- 如果用户把 Vault 推到 Git，`.inkloop` 也可能被推上去。
- 如果用户希望 InkLoop 状态完全本地，需要提供“App data mode”。
- Obsidian Vault API 对隐藏目录支持有限，插件访问隐藏目录时需要走更底层 adapter / filesystem 能力。

### 3.2 Sidecar 位置配置

```ts
export type SidecarLocation =
 | 'vault_hidden'     // <Vault>/.inkloop，默认选定
 | 'vault_visible'    // <Vault>/_inkloop，兼容性更强但可见
 | 'app_data'         // OS app data，不随 Vault 走
 | 'inkloop_cloud';   // 云同步，后续

export interface SidecarSettings {
  location: SidecarLocation;
  vault_hidden_dir: '.inkloop';
  visible_fallback_dir: '_inkloop';
  sync_heavy_assets: boolean;
  store_pdf_inside_vault: boolean;
}
```

### 3.3 执行策略

| 场景 | sidecar 位置 | 说明 |
|---|---|---|
| v1 桌面端 | `.inkloop/` | 最符合“不污染用户文件” |
| 插件移动端 | `_inkloop/` 或 plugin data | 隐藏目录/FS 能力不稳定，先降级 |
| 企业隐私 | App data | 不跟 Vault 同步，防止泄漏 |
| 多端同步 | InkLoop Cloud + 本地缓存 | 后续主线 |

---

## 4. Sidecar 文件结构

### 4.1 顶层结构

```text
<Vault>/.inkloop/
  manifest.json
  settings.json

  indexes/
    path-index.json
    doc-index.json
    ko-index.json
    orphan-index.json

  docs/
    doc_01JZ8.../
      document.json
      source.json
      revisions.jsonl

      surfaces/
        surface-manifest.json
        markdown.blocks.jsonl
        markdown.lines.jsonl
        pdf.pages.jsonl
        pdf.objects.page-0001.jsonl

      canvas/
        canvas.json
        nodes.jsonl
        strokes.jsonl
        text-nodes.jsonl
        viewport.json

      marks/
        marks.jsonl
        hmp.jsonl

      overlays/
        ai-turns.jsonl
        screen-overlays.jsonl

      knowledge/
        ko-index.json
        ko_01JZ8....json

      assets/
        page-preview-0001.webp
        anchor-crop-xxx.webp

  assets/
    sha256/
      ab/
        sha256_abcd....pdf
        sha256_efgh....png

  outbox/
    knowledge-objects-<export_id>.json

  inbox/
    commands-<id>.json

  logs/
    plugin-events.jsonl
    conflicts.jsonl
```

### 4.2 为什么不是一个巨大的 JSON？

不采用把所有数据放进一个 `data.json`，原因：

- PDF + 无限画布 + strokes 可能很大。
- Git diff 会爆炸。
- 每次更新一个笔迹都重写整文件风险高。
- 插件启动时不应该读全量。
- JSONL 更适合 append-only marks / overlays。

要求：

```text
配置 / manifest：小 JSON
事件 / 笔迹 / overlay：JSONL
索引：小 JSON，可重建
重资产：content-addressed assets
未来高性能：SQLite，作为 InkLoop Desktop 内部缓存，不强依赖 Obsidian 插件
```

---

## 5. 核心 Schema

## 5.1 Vault Manifest

```ts
export interface InkLoopVaultManifest {
  schema_version: 'inkloop.vault_manifest.v1';
  vault_id: string;              // Obsidian vault id 或 InkLoop 生成的 fallback id
  created_at: string;
  updated_at: string;

  sidecar_location: 'vault_hidden' | 'vault_visible' | 'app_data' | 'inkloop_cloud';
  plugin_version?: string;
  inkloop_runtime_version?: string;

  indexes: {
    path_index_hash?: string;
    doc_index_hash?: string;
    ko_index_hash?: string;
  };
}
```

## 5.2 Document Record

```ts
export type SourceType =
 | 'markdown'
 | 'pdf'
 | 'image'
 | 'scan'
 | 'epub'
 | 'ink_canvas'
 | 'obsidian_canvas';

export interface InkLoopDocumentRecord {
  schema_version: 'inkloop.document.v1';

  doc_id: string;
  title: string;
  source_type: SourceType;

  source_ref_id: string;

  created_at: string;
  updated_at: string;
  last_opened_at?: string;

  default_view: 'preview' | 'edit';

  capabilities: {
    native_text_editable: boolean;
    paginated: boolean;
    infinite_canvas: boolean;
    supports_handwriting: boolean;
    supports_ai_overlay: boolean;
  };
}
```

## 5.3 SourceRef：原生文件引用

```ts
export interface SourceRef {
  schema_version: 'inkloop.source_ref.v1';
  source_ref_id: string;
  doc_id: string;

  kind:
 | 'obsidian_vault_file'   // 用户 vault 内的 .md / .pdf
 | 'inkloop_asset'         // InkLoop 管理的隐藏资产
 | 'external_file'         // vault 外部文件
 | 'generated_markdown'    // InkLoop 新建的 markdown
 | 'inkloop_internal';     // 纯 InkLoop canvas，没有原生文件

  vault_file?: {
    vault_id: string;
    path: string;             // vault 相对路径，例如 Research/A.md
    extension: string;         // .md / .pdf
  };

  asset?: {
    asset_id: string;
    content_hash: string;
    relative_path: string;     // .inkloop/assets/sha256/...
    mime_type: string;
  };

  identity: {
    original_path?: string;
    current_path?: string;
    initial_content_hash?: string;
    current_content_hash?: string;
    size?: number;
    mtime?: number;
    fingerprint: string;
  };

  status:
 | 'active'
 | 'path_moved'
 | 'missing'
 | 'relinked'
 | 'replaced'
 | 'conflict';
}
```

## 5.4 SourceRevision：文件版本快照

```ts
export interface SourceRevision {
  schema_version: 'inkloop.source_revision.v1';

  rev_id: string;
  doc_id: string;
  source_ref_id: string;

  content_hash: string;
  mtime?: number;
  size?: number;

  created_at: string;

  parser: {
    adapter: 'markdown' | 'pdf' | 'ink_canvas';
    version: string;
  };

  surface_manifest_hash: string;
}
```

## 5.5 SurfaceObject：统一可锚定对象

原 PDF 的字符级对象、Markdown 的 block/line/span、图片区域、canvas node 都可统一成 `SurfaceObject`。

```ts
export type SurfaceObjectKind =
 | 'pdf_char'
 | 'pdf_text_run'
 | 'pdf_line'
 | 'pdf_image_region'
 | 'md_block'
 | 'md_line'
 | 'md_span'
 | 'image_region'
 | 'canvas_node';

export interface SurfaceObject {
  schema_version: 'inkloop.surface_object.v1';

  object_id: string;
  doc_id: string;
  source_revision_id: string;

  kind: SurfaceObjectKind;

  text?: string;

  source_anchor: SourceAnchor;
  visual_anchor?: VisualAnchor;

  reading_order: number;
  parent_object_id?: string;

  fingerprint: {
    text_hash?: string;
    context_hash?: string;
    geometry_hash?: string;
  };
}
```

## 5.6 SourceAnchor：格式相关锚点

```ts
export type SourceAnchor =
 | MarkdownSourceAnchor
 | PdfSourceAnchor
 | CanvasSourceAnchor;

export interface MarkdownSourceAnchor {
  type: 'markdown';
  file_path: string;

  block_id: string;
  heading_path: string[];

  range: {
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
  };

  quote?: string;
  context_before?: string;
  context_after?: string;
}

export interface PdfSourceAnchor {
  type: 'pdf';
  page_index: number;
  object_refs: string[];
  bbox: [number, number, number, number]; // normalized
  quote?: string;
}

export interface CanvasSourceAnchor {
  type: 'canvas';
  node_id: string;
  bbox: [number, number, number, number]; // canvas coordinate, not normalized page bbox
}
```

## 5.7 VisualAnchor：渲染后的位置

`VisualAnchor` 是派生缓存，不是真相源。

```ts
export interface VisualAnchor {
  viewport_id: string;
  mode: 'preview' | 'edit';

  rect: {
    x: number;
    y: number;
    w: number;
    h: number;
  };

  coordinate_space:
 | 'dom_px'
 | 'pdf_page_norm'
 | 'canvas_world';

  computed_at: string;
}
```

Markdown 没有天然页面，所以预览模式下的 bbox 必须等 DOM 渲染完成后计算；PDF 可直接用 page normalized bbox；无限画布使用 world coordinate。

---

## 6. 无限画布 Runtime Schema

你们现在前端已经进入“无限画布 + 预览/编辑双模式”，这里要求把画布状态正式独立出来。

## 6.1 CanvasState

```ts
export interface InkLoopCanvasState {
  schema_version: 'inkloop.canvas.v1';

  doc_id: string;
  canvas_id: string;

  coordinate_space: {
    unit: 'world_px';
    origin: 'top_left';
    scale_base: 1;
  };

  mode_defaults: {
    preview_layout: 'source_first' | 'canvas_first';
    edit_layout: 'free_canvas';
  };

  layers: CanvasLayer[];
  viewport?: CanvasViewport;

  updated_at: string;
}
```

## 6.2 CanvasLayer

```ts
export interface CanvasLayer {
  layer_id: string;
  kind:
 | 'source_render'
 | 'ink'
 | 'typed_text'
 | 'ai_overlay'
 | 'selection'
 | 'debug';

  visible: boolean;
  locked: boolean;
  z_index: number;
}
```

## 6.3 CanvasNode

```ts
export type CanvasNodeKind =
 | 'source_proxy'     // PDF page / Markdown block 在画布中的代理
 | 'ink_stroke'
 | 'typed_text'
 | 'ai_card'
 | 'image'
 | 'link'
 | 'group';

export interface CanvasNode {
  schema_version: 'inkloop.canvas_node.v1';

  node_id: string;
  doc_id: string;
  canvas_id: string;
  layer_id: string;

  kind: CanvasNodeKind;

  frame: {
    x: number;
    y: number;
    w: number;
    h: number;
    rotation?: number;
  };

  payload:
 | SourceProxyPayload
 | InkStrokePayload
 | TypedTextPayload
 | AiCardPayload
 | ImagePayload;

  anchor?: {
    source_object_ids?: string[];
    source_anchor?: SourceAnchor;
  };

  created_at: string;
  updated_at: string;
  deleted_at?: string;
}
```

## 6.4 TypedTextPayload

```ts
export interface TypedTextPayload {
  type: 'typed_text';

  body_md: string;

  text_role:
 | 'free_note'
 | 'ai_edit'
 | 'source_patch_candidate'
 | 'caption'
 | 'task';

  commit_target?:
 | { type: 'sidecar_only' }
 | { type: 'markdown_source_patch'; file_path: string; range?: MarkdownSourceAnchor['range'] };
}
```

关键点：编辑模式里用户“任意位置打字”，默认应该是：

```text
commit_target = sidecar_only
```

只有用户明确选择“写回 Markdown 原文”时，才生成 `markdown_source_patch`。

---

## 7. 三类文件如何兼容

## 7.1 原生 Markdown 文件

### 7.1.1 存储原则

```text
源文件：Research/Attention.md
InkLoop 数据：.inkloop/docs/doc_xxx/*
```

不写：

```text
---
inkloop_id: xxx
---

<!-- inkloop:xxx -->
^inkloop-block-id
```

### 7.1.2 打开流程

```text
用户在 Obsidian 选中 Attention.md
    ↓
InkLoop 插件命令：Open in InkLoop view
    ↓
FileResolver.resolve(active TFile)
    ↓
SidecarStore.findOrCreateDocumentForPath(path)
    ↓
MarkdownSourceAdapter.read(file)
    ↓
MarkdownSourceAdapter.buildSurface(content)
    ↓
SidecarStore.loadCanvasAndOverlays(doc_id)
    ↓
InkLoopRenderer.renderPreview 或 renderEdit
```

### 7.1.3 Markdown Surface 构建

Markdown 没有 PDF 那种页和固定坐标，所以要建立文本语义锚点：

```text
heading_path
block ordinal
line range
text hash
quote
context before/after
```

对象层要求：

```text
md_block：段落、标题、列表项、引用块、代码块、表格块
md_line：渲染前的源文件行
md_span：选中的局部文本，可选
```

示例：

```json
{
  "object_id": "mdblk_doc01_0008_a19f3c2d",
  "kind": "md_block",
  "text": "Transformer 的核心是 self-attention。",
  "source_anchor": {
    "type": "markdown",
    "file_path": "Research/Attention.md",
    "block_id": "mdblk_doc01_0008_a19f3c2d",
    "heading_path": ["Attention Notes"],
    "range": {"start_line": 12, "start_col": 0, "end_line": 12, "end_col": 35},
    "quote": "Transformer 的核心是 self-attention。",
    "context_before": "# Attention Notes",
    "context_after": "这个地方我还没完全理解。"
  },
  "reading_order": 8,
  "fingerprint": {
    "text_hash": "sha256:...",
    "context_hash": "sha256:..."
  }
}
```

### 7.1.4 Markdown 锚点重映射

当用户改了 Markdown 文件，旧的 line range 可能失效。重映射顺序：

```text
1. exact object id + content_hash 命中
2. quote 精确搜索
3. quote + context before/after 模糊搜索
4. heading_path + ordinal 附近搜索
5. text semantic/fuzzy match
6. orphan anchor：保留旁注，但标记“锚点需确认”
```

冲突状态：

```ts
export type AnchorRemapStatus =
 | 'exact'
 | 'fuzzy_quote'
 | 'fuzzy_context'
 | 'heading_nearby'
 | 'orphan'
 | 'ambiguous';
```

UI 处理：

- `exact / fuzzy_quote`：正常显示。
- `fuzzy_context / heading_nearby`：显示弱提示。
- `ambiguous`：让用户选择锚点。
- `orphan`：放到右侧“未定位批注”。

### 7.1.5 Markdown 预览模式

预览模式要尽量接近 Obsidian 原生阅读体验：

```text
左侧：Markdown 渲染结果
右侧：AI gutter / AI cards
覆盖层：手写笔迹 / typed notes / anchors
```

实现有两条路线：

#### 选定路线 A：InkLoop 自定义 View

插件注册一个 `InkLoopDocumentView`，内部自己渲染：

```text
MarkdownRenderer / 自有 Markdown renderer
    + OverlayLayer
    + AIGutterLayer
    + CanvasInteractionLayer
```

优点：

- 控制力强。
- 和 InkLoop 桌面端 / 墨水屏端渲染一致。
- 不干扰 Obsidian 原生 editor。
- 容易做无限画布。

缺点：

- 要重做一层 Markdown 渲染 / 样式适配。
- 不能 100% 等同 Obsidian 原生阅读视图。

#### 辅助路线 B：注入 Obsidian 原生阅读视图

插件通过 Markdown post processor 或 editor extension 插入 overlay。

优点：

- 视觉上更像 Obsidian。
- 用户仍在原生 note 中看内容。

缺点：

- Reading view / Live Preview / Source mode 差异大。
- DOM 结构可能随 Obsidian 版本变化。
- 无限画布交互会受 Obsidian editor 限制。

结论：

```text
v1 选定自定义 InkLoop View。
原生注入只做轻量 anchor / open button / side panel，不做主渲染链路。
```

### 7.1.6 Markdown 编辑模式

编辑模式里，用户可任意位置手写或打字。必须区分两件事：

```text
A. 修改 InkLoop canvas layer
B. 修改原生 Markdown source
```

默认行为：

| 用户动作 | 默认写入位置 | 是否污染 .md |
|---|---|---|
| 手写 | sidecar canvas / marks | 否 |
| 任意位置 typed note | sidecar canvas / text node | 否 |
| 修改 AI 旁注 | sidecar overlays / KO | 否 |
| 对原文执行“替换这句话” | 先生成 source patch candidate | 否，直到用户确认 |
| 用户确认“写回 Markdown” | 原生 .md | 是，但这是用户主动修改原文，不是协议污染 |

写回 Markdown 必须是显式动作：

```text
Apply to source Markdown
```

写回时使用：

```text
Vault.process(file, fn)
```

而不是 `read → async → modify`，避免覆盖用户同时编辑。

---

## 7.2 PDF 文件

### 7.2.1 存储原则

PDF 本身保持原生 `.pdf`，InkLoop 标注不写入 PDF binary。

```text
源文件：Papers/Attention.pdf
InkLoop 数据：.inkloop/docs/doc_xxx/*
```

如果 PDF 是从 InkLoop 导入，而不是 Obsidian Vault 里已有文件，有两个选项：

```text
选项 A：复制到 Vault 可见附件目录
  Papers/Attention.pdf
  .inkloop/docs/doc_xxx/*

选项 B：复制到 InkLoop 隐藏资产目录
  .inkloop/assets/sha256/xx/sha256_xxx.pdf
  .inkloop/docs/doc_xxx/*
```

选定默认：

```text
用户从 Obsidian 打开已有 PDF → source_ref = obsidian_vault_file
用户从 InkLoop 导入 PDF → 询问“保存为 Vault 文件”还是“保存到 InkLoop 隐藏库”
```

### 7.2.2 PDF 渲染流程

```text
PdfSourceAdapter.load(pdf bytes)
    ↓
PDF.js render page
    ↓
extract text layer / image regions
    ↓
build PDF SurfaceObject
    ↓
load sidecar marks / overlays
    ↓
render preview: PDF page + ink layer + AI gutter
```

PDF 的 `SurfaceObject` 可沿用现有设计：

```text
pdf_char / pdf_text_run / pdf_line / pdf_image_region
```

锚点使用：

```text
page_index
object_refs
normalized bbox
quote
```

### 7.2.3 PDF 编辑模式

PDF 不应该直接被改写。编辑模式中的所有修改默认进入 sidecar：

```text
手写批注 → sidecar marks/strokes
 typed note → sidecar canvas/text-nodes
 AI edit → sidecar overlays/knowledge
 裁图/OCR → sidecar assets/surface
```

如果用户选择“导出带批注 PDF”，那是单独的 export pipeline：

```text
source PDF + sidecar annotations → flattened annotated PDF
```

这个导出文件不是源文件覆盖，默认另存。

---

## 7.3 InkLoop 新建文件

新建文件分三种：

### 7.3.1 Text-first：新建 Markdown

如果用户新建的是文字笔记，直接创建原生 Markdown：

```text
Notes/Untitled.md
.inkloop/docs/doc_xxx/*
```

这样兼容性最好。

默认内容可为空：

```md
# Untitled
```

用户在 InkLoop edit mode 中任意打字，默认还是 sidecar text node；如果用户要整理成正文，再执行“Apply to Markdown”。

### 7.3.2 PDF-first：导入 PDF

如上：PDF binary 原生保存，sidecar 存标注。

### 7.3.3 Canvas-first：纯 InkLoop 无限画布

如果这个文件本质是白板/自由画布，不应伪装成 Markdown。选定：

```text
.inkloop/docs/doc_xxx/document.json
.inkloop/docs/doc_xxx/canvas/*
```

并提供一个可选投影：

```text
InkLoop/Exports/Untitled.md
```

这个 Markdown 是导出视图，不是真相源。

后续可研究 Obsidian `.canvas` 原生格式投影，但 v1 不要把它当核心存储格式，因为 InkLoop 的手写、AI overlay、PDF anchor 都比 Obsidian Canvas 更复杂。

---

## 8. Obsidian 插件渲染方案

## 8.1 插件模块

```text
src/
  main.ts
  settings.ts

  sidecar/
    SidecarStore.ts
    HiddenFsAdapter.ts
    VisibleVaultAdapter.ts
    indexes.ts
    lock.ts

  source/
    SourceAdapter.ts
    MarkdownSourceAdapter.ts
    PdfSourceAdapter.ts
    InkCanvasSourceAdapter.ts
    SourceRemapper.ts

  render/
    InkLoopDocumentView.ts
    PreviewRenderer.ts
    EditCanvasRenderer.ts
    AIGutterLayer.ts
    InkLayer.ts
    TextNodeLayer.ts
    AnchorResolver.ts

  ko/
    KnowledgeObjectStore.ts
    ObsidianExportAdapter.ts

  sync/
    BindingStore.ts
    ConflictStore.ts
    SyncEngine.ts

  commands/
    openInkLoopView.ts
    exportKO.ts
    applySourcePatch.ts
```

## 8.2 打开入口

提供四个入口：

```text
1. 右键文件：Open in InkLoop
2. 命令面板：Open current file in InkLoop
3. Ribbon：Open InkLoop dashboard
4. inkloop://doc/<doc_id> 深链打开
```

## 8.3 InkLoopDocumentView

`InkLoopDocumentView` 是主渲染容器，不直接改用户文件。

```ts
export interface InkLoopDocumentViewState {
  doc_id: string;
  source_path?: string;
  mode: 'preview' | 'edit';
  source_revision_id?: string;
}
```

生命周期：

```text
onOpen
  → resolve doc
  → load source
  → build / update surface
  → load sidecar state
  → render

onModeSwitch
  → preview/edit renderer switch

onClose
  → flush pending sidecar writes
```

## 8.4 预览模式渲染

```text
┌───────────────────────────────────────────────┐
│ Toolbar: Preview | Edit | Export | Sync       │
├───────────────────────────────┬───────────────┤
│ Native content render          │ AI gutter     │
│ - Markdown rendered blocks     │ - AI notes    │
│ - PDF pages                    │ - unresolved  │
│ - Ink strokes overlay          │ - tasks       │
│ - highlight anchors            │               │
└───────────────────────────────┴───────────────┘
```

渲染步骤：

```text
1. render native source content
2. compute visual anchors
3. map sidecar marks / overlays to visual anchors
4. place AI cards in right gutter
5. draw ink strokes / highlights / typed notes
6. attach interaction handlers
```

AI gutter 的位置不写进 Markdown。它只存在于 DOM / canvas layer。

## 8.5 编辑模式渲染

```text
┌───────────────────────────────────────────────┐
│ Toolbar: Preview | Edit | Apply to source     │
├───────────────────────────────────────────────┤
│ Infinite Canvas                               │
│                                               │
│  [source proxy blocks/pages]                  │
│       + free handwriting                      │
│       + typed text anywhere                   │
│       + AI cards editable                     │
│       + arrows / groups / images              │
│                                               │
└───────────────────────────────────────────────┘
```

编辑模式关键规则：

```text
1. 不需要先点按钮，用户直接写/打字。
2. 所有自由修改默认是 sidecar canvas node。
3. 不自动写回原生 Markdown/PDF。
4. 用户明确选择 apply source patch 才改 Markdown。
5. PDF 永远不原地改写。
```

这样既满足“任意位置编辑”，又满足“不污染用户文件”。

---

## 9. Obsidian 原生 Markdown 兼容细节

## 9.1 不插入 block id 的代价

不污染 Markdown 意味着锚点稳定性一定弱于写入 block id。

必须接受以下事实：

```text
用户在 Obsidian 外部重命名 + 大幅修改 Markdown，且插件没有收到 rename/modify 事件时，sidecar 只能通过内容指纹和模糊匹配找回，不能 100% 保证。
```

解决方案：

```text
默认：Zero Pollution Mode，尽量靠 sidecar + events + fingerprint。
可选：Soft Marker Mode，用户允许写入 frontmatter/block id 时，稳定性更强。
```

## 9.2 Path Index

```ts
export interface PathIndexRecord {
  path: string;
  doc_id: string;
  source_ref_id: string;
  last_seen_mtime?: number;
  last_seen_size?: number;
  last_seen_content_hash?: string;
  last_seen_at: string;
}
```

`path-index.json`：

```json
{
  "schema_version": "inkloop.path_index.v1",
  "items": {
    "Research/Attention.md": {
      "path": "Research/Attention.md",
      "doc_id": "doc_01JZ...",
      "source_ref_id": "src_01JZ...",
      "last_seen_content_hash": "sha256:...",
      "last_seen_at": "2026-06-27T...Z"
    }
  }
}
```

## 9.3 Rename 处理

如果 Obsidian 插件收到 rename 事件：

```text
old_path → new_path
  ↓
path-index 更新
source_ref.current_path 更新
binding.remote_path 更新
rebuild SourceRevision
```

如果插件没有收到事件，但下次打开发现旧路径 missing：

```text
1. 在 Vault 中按 content_hash / fingerprint 扫描候选文件。
2. 只有一个候选 → 自动 relink。
3. 多个候选 → 用户选择。
4. 没有候选 → doc 标记 source_missing。
```

## 9.4 Modify 处理

修改事件不代表冲突。Markdown 用户正常编辑源文件很常见。

处理流程：

```text
modify event
  ↓ debounce
read file
  ↓
compute content_hash
  ↓
if hash changed:
  create SourceRevision
  rebuild Markdown surface
  remap anchors
  mark overlay remap status
```

不应因为 Markdown 改了就覆盖 sidecar，也不应因为 sidecar 有修改就覆盖 Markdown。

---

## 10. Sidecar 写入与并发

## 10.1 写入原则

```text
append-only 优先
小文件原子替换
索引可重建
重资产 content-addressed
冲突不覆盖
```

## 10.2 文件锁

Obsidian 插件、InkLoop Desktop、外部同步工具可能同时碰 `.inkloop`。

要求实现轻量 lock：

```text
.inkloop/locks/<doc_id>.lock
```

内容：

```json
{
  "owner": "obsidian_plugin",
  "process_id": "...",
  "created_at": "...",
  "expires_at": "..."
}
```

策略：

```text
短事务才锁。
锁过期可抢占。
不要长期持有锁。
写 JSON 文件时先写 .tmp，再 rename。
```

## 10.3 JSONL append

适合：

```text
marks.jsonl
hmp.jsonl
ai-turns.jsonl
screen-overlays.jsonl
plugin-events.jsonl
conflicts.jsonl
```

每行：

```json
{"record_id":"...","schema_version":"...","created_at":"...","payload":{}}
```

## 10.4 Compact

长期使用后 JSONL 会膨胀，需要 compact：

```text
marks.jsonl + tombstones → marks.compacted.jsonl
ai-turns supersedes → ai-turns.compacted.jsonl
```

compact 不应在插件启动时做；放到后台或用户触发。

---

## 11. KnowledgeObject 与 Sidecar 如何联动

## 11.1 KO 仍然是外部导出契约

`KnowledgeObject` 不存完整画布状态，不存完整 PDF page index，不存所有 strokes。

KO 的定位：

```text
一个可被 Notion/Obsidian/Markdown/Readwise 理解的知识单元。
```

它可引用 sidecar 中的锚点：

```ts
source: {
  document_id: 'doc_...',
  object_refs: ['mdblk_...', 'pdfchar_...'],
  anchor_bbox?: [...],
  quote?: '...',
  inkloop_uri: 'inkloop://doc/doc_.../object/mdblk_...'
}
```

## 11.2 Sidecar 中保存 KO

```text
.inkloop/docs/doc_xxx/knowledge/
  ko-index.json
  ko_01JZ....json
```

KO 由 InkLoop runtime / KnowledgeBuilder 产生。

Obsidian Export Adapter 可把 KO 导出为单独 Markdown note：

```text
InkLoop/Notes/2026-06-27 AI Note - Attention p12 - QCJBW2.md
```

这类导出 note 是用户选择生成的“知识投影”，不是源文件污染。

## 11.3 源文件与导出 note 的区别

| 类型 | 文件 | 是否用户源文件 | InkLoop 是否可写 |
|---|---|---:|---:|
| 原生 Markdown 源 | `Research/A.md` | 是 | 默认不写 |
| PDF 源 | `Papers/A.pdf` | 是 | 不写 binary |
| InkLoop sidecar | `.inkloop/docs/doc_xxx/*` | 否 | 可写 |
| KO 导出 note | `InkLoop/Notes/AI Note.md` | 派生文件 | 可控区块可写，但不影响源文件 |

这能同时满足：

```text
1. 原生 Markdown 不被污染。
2. Obsidian 里仍能看到 InkLoop 生成的知识笔记。
3. PDF 和新建文件都能纳入同一套机制。
```

---

## 12. 三条主流程

## 12.1 打开已有 Markdown

```text
User opens Research/A.md in Obsidian
  ↓
Command: Open in InkLoop
  ↓
FileResolver.ensureDoc(path)
  ↓
if no sidecar doc:
  create doc_id
  create SourceRef(kind=obsidian_vault_file)
  write document.json/source.json
  update path-index
  build initial Markdown surface
else:
  load doc_id
  check mtime/hash
  rebuild surface if changed
  remap anchors
  load canvas/marks/overlays
  render InkLoop view
```

用户在 InkLoop 编辑模式手写：

```text
PointerEvent
  ↓
InkLoop Stroke
  ↓
CanvasNode(kind=ink_stroke)
  ↓
marks.jsonl / canvas nodes
  ↓
AI overlay if triggered
  ↓
source .md 不变
```

用户在 InkLoop 编辑模式打字：

```text
Type anywhere
  ↓
CanvasNode(kind=typed_text, commit_target=sidecar_only)
  ↓
text-nodes.jsonl
  ↓
source .md 不变
```

用户选择写回 Markdown：

```text
Generate SourcePatchCandidate
  ↓
Preview diff
  ↓
User confirm
  ↓
Vault.process(file, patchFn)
  ↓
source .md changed by user intent
  ↓
rebuild surface/revision
```

## 12.2 导入 PDF

```text
User imports Attention.pdf
  ↓
Choose storage:
  A. Save into Vault visible path
  B. Save into .inkloop/assets hidden path
  ↓
create doc_id/source_ref
  ↓
PdfSourceAdapter indexes pages/text/images
  ↓
render InkLoop PDF view
  ↓
marks/overlays stored in sidecar
```

## 12.3 新建 InkLoop 文件

```text
New document
  ↓
Choose type:
  Markdown note / PDF import / Free canvas
```

Markdown note：

```text
create Notes/Untitled.md
create sidecar doc
open InkLoop view
```

Free canvas：

```text
create sidecar-only doc
source_type = ink_canvas
open InkLoop edit mode
optional export to Markdown later
```

---

## 13. Obsidian 插件 API 使用边界

## 13.1 对用户可见 Vault 文件

`.md` / `.pdf` / generated notes 这类 Obsidian 可见文件，优先使用 Obsidian API：

```text
Vault.read / cachedRead
Vault.process
Vault.create
Vault.rename
FileManager.trashFile
FileManager.processFrontMatter（仅用于生成的 KO note，源文件默认不用）
```

不要直接用 Node `fs` 改用户可见 Markdown 文件。

## 13.2 对隐藏 `.inkloop` sidecar

隐藏目录可能不是 Vault API 的普通可见文件，需要使用：

```text
Vault.adapter
FileSystemAdapter（desktop only，必须 gated）
CapacitorAdapter（mobile，能力不同）
```

封装成：

```ts
interface SidecarFsPort {
  readText(path: string): Promise<string>;
  writeTextAtomic(path: string, content: string): Promise<void>;
  appendJsonLine(path: string, value: unknown): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
}
```

不要让业务代码直接依赖 `fs` 或 `Vault.adapter`。

## 13.3 Desktop / Mobile 差异

v1 选定 desktop-only：

```json
{
  "isDesktopOnly": true
}
```

如果后续支持移动端：

- 不在 top-level import `fs/path/electron`。
- 通过 `Platform.isDesktopApp` 判断。
- 对隐藏目录访问做 fallback。
- sidecar 可切到 `_inkloop` 或 InkLoop Cloud。
- 网络请求使用 Obsidian 选定的请求 API。

---

## 14. 冲突与边界场景

| 场景 | 检测方式 | 处理 |
|---|---|---|
| 用户改 Markdown 内容 | content_hash 变化 | rebuild surface，remap anchors |
| 用户重命名 Markdown | Obsidian rename event | 更新 path-index/source_ref |
| 用户在外部重命名 | path missing + fingerprint scan | 自动 relink 或用户选择 |
| 用户删除源文件 | path missing | doc status = source_missing，sidecar 保留 |
| 用户复制同一文件 | 多个 content_hash 候选 | duplicate candidates，用户确认 |
| 用户删除 `.inkloop` | manifest missing | 提示 InkLoop 状态丢失，可重新创建 |
| 用户把 sidecar 同步到 Git | 检测 .git | 提示是否生成 .gitignore 要求 |
| PDF 被替换 | content_hash changed | 新 revision；旧 anchors 标记需重映射 |
| Markdown 锚点找不到 | remap orphan | 放到 unresolved gutter |
| 多处 quote 相同 | ambiguous | 用户选择锚点 |
| 插件和 InkLoop Desktop 同时写 | lock / revision check | 后写方重试或 conflict |

---

## 15. 最小可落地版本：MVP 范围

### 15.1 MVP 必须做

```text
1. .inkloop sidecar store
2. path-index / doc-index
3. MarkdownSourceAdapter
4. PdfSourceAdapter 基础读取和渲染
5. InkLoopDocumentView：preview/edit 双模式
6. sidecar canvas nodes：ink_stroke / typed_text / ai_card
7. AI overlay gutter
8. Markdown anchor remap：exact + quote search + orphan
9. Zero Pollution Mode
10. KO 读取 / 导出到 generated Obsidian note
```

### 15.2 MVP 暂不做

```text
1. 直接修改 Obsidian 原生阅读视图 DOM 的复杂注入
2. 自动写回 Markdown 原文
3. Obsidian mobile 支持
4. PDF 原地写入 annotation
5. Obsidian Canvas 原生格式双向同步
6. 高级语义锚点重映射
7. 多人协作冲突合并
```

---

## 16. 代码级接口正式版

## 16.1 SourceAdapter

```ts
export interface SourceAdapter<TSource> {
  source_type: SourceType;

  canOpen(ref: SourceRef): boolean;

  load(ref: SourceRef, ctx: SourceLoadContext): Promise<TSource>;

  buildSurface(input: {
    doc: InkLoopDocumentRecord;
    ref: SourceRef;
    source: TSource;
    previousRevision?: SourceRevision;
  }): Promise<BuildSurfaceResult>;

  remapAnchors(input: {
    oldRevision: SourceRevision;
    newRevision: SourceRevision;
    anchors: SourceAnchor[];
  }): Promise<RemapResult[]>;

  renderPreview(input: {
    source: TSource;
    surface: SurfaceManifest;
    container: HTMLElement;
  }): Promise<RenderHandle>;
}
```

## 16.2 SidecarStore

```ts
export interface SidecarStore {
  ensureVaultManifest(): Promise<InkLoopVaultManifest>;

  findDocByPath(path: string): Promise<InkLoopDocumentRecord | null>;
  createDocForSource(ref: SourceRef): Promise<InkLoopDocumentRecord>;

  loadDocument(docId: string): Promise<InkLoopDocumentRecord>;
  loadSourceRef(docId: string): Promise<SourceRef>;

  appendMark(docId: string, mark: unknown): Promise<void>;
  appendOverlay(docId: string, overlay: unknown): Promise<void>;
  appendCanvasNode(docId: string, node: CanvasNode): Promise<void>;

  loadCanvasState(docId: string): Promise<InkLoopCanvasState>;
  loadCanvasNodes(docId: string): Promise<CanvasNode[]>;
  loadOverlays(docId: string): Promise<unknown[]>;

  saveKnowledgeObject(docId: string, ko: KnowledgeObject): Promise<void>;
  listKnowledgeObjects(docId: string): Promise<KnowledgeObject[]>;
}
```

## 16.3 RendererView

```ts
export interface InkLoopRendererView {
  open(docId: string): Promise<void>;
  switchMode(mode: 'preview' | 'edit'): Promise<void>;
  refresh(): Promise<void>;
  flush(): Promise<void>;
}
```

---

## 17. 关键实现伪代码

### 17.1 打开当前 Obsidian 文件

```ts
async function openCurrentFileInInkLoop(app: App) {
  const file = app.workspace.getActiveFile();
  if (!file) return;

  const vault = await sidecar.ensureVaultManifest();

  let doc = await sidecar.findDocByPath(file.path);
  if (!doc) {
    const ref = await createSourceRefFromTFile(vault.vault_id, file);
    doc = await sidecar.createDocForSource(ref);
  }

  const ref = await sidecar.loadSourceRef(doc.doc_id);
  const adapter = sourceAdapterRegistry.resolve(ref);
  const source = await adapter.load(ref, { app });

  const surfaceResult = await adapter.buildSurface({
    doc,
    ref,
    source,
    previousRevision: await sidecar.getLatestRevision(doc.doc_id),
  });

  await sidecar.saveRevision(surfaceResult.revision);
  await sidecar.saveSurfaceManifest(doc.doc_id, surfaceResult.surface);

  await inkLoopView.open(doc.doc_id);
}
```

### 17.2 Markdown 修改后的 anchor remap

```ts
async function onMarkdownModified(file: TFile) {
  const doc = await sidecar.findDocByPath(file.path);
  if (!doc) return;

  const ref = await sidecar.loadSourceRef(doc.doc_id);
  const adapter = markdownSourceAdapter;

  const oldRevision = await sidecar.getLatestRevision(doc.doc_id);
  const source = await adapter.load(ref, { app });

  const next = await adapter.buildSurface({ doc, ref, source, previousRevision: oldRevision });

  const anchors = await sidecar.listAnchors(doc.doc_id);
  const remaps = await adapter.remapAnchors({
    oldRevision,
    newRevision: next.revision,
    anchors,
  });

  await sidecar.saveRevision(next.revision);
  await sidecar.saveSurfaceManifest(doc.doc_id, next.surface);
  await sidecar.saveAnchorRemaps(doc.doc_id, remaps);

  await inkLoopView.refreshIfOpen(doc.doc_id);
}
```

### 17.3 编辑模式写入 typed text

```ts
async function onCanvasTextCommitted(input: {
  docId: string;
  x: number;
  y: number;
  bodyMd: string;
}) {
  const node: CanvasNode = {
    schema_version: 'inkloop.canvas_node.v1',
    node_id: ulidNodeId(),
    doc_id: input.docId,
    canvas_id: await getCanvasId(input.docId),
    layer_id: 'layer_typed_text',
    kind: 'typed_text',
    frame: { x: input.x, y: input.y, w: 280, h: 120 },
    payload: {
      type: 'typed_text',
      body_md: input.bodyMd,
      text_role: 'free_note',
      commit_target: { type: 'sidecar_only' },
    },
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  await sidecar.appendCanvasNode(input.docId, node);
  renderer.addNode(node);
}
```

### 17.4 可选：写回 Markdown 原文

```ts
async function applyMarkdownPatch(file: TFile, patch: MarkdownPatch) {
  await app.vault.process(file, (current) => {
    const latestHash = sha256(current);
    if (latestHash !== patch.base_content_hash) {
      throw new Error('SOURCE_CHANGED_REVIEW_REQUIRED');
    }
    return applyPatch(current, patch);
  });
}
```

---

## 18. 渲染坐标策略

### 18.1 三套坐标

| 坐标系 | 用途 |
|---|---|
| source coordinate | Markdown line/col、PDF page normalized bbox |
| DOM coordinate | 预览模式实际渲染后的元素位置 |
| canvas world coordinate | 编辑模式无限画布坐标 |

不要混用。

### 18.2 预览模式

```text
Markdown source anchor
  → rendered DOM range
  → DOMRect
  → AI gutter y-position

PDF source anchor
  → page normalized bbox
  → page DOM rect
  → DOMRect
  → AI gutter y-position
```

### 18.3 编辑模式

```text
source object
  → source proxy node on canvas
  → canvas world rect
  → AI card / ink stroke / typed text around it
```

编辑模式里 PDF 页面、Markdown block 都可是 `source_proxy` 节点。用户在任意位置新增内容，不一定要有 source anchor。

---

## 19. 和现有 InkLoop 前端链路的关系

现有链路：

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
→ IndexedDB
```

在 Obsidian 插件方案中：

```text
IndexedDB 的职责 → sidecar store / runtime cache
PDF SurfaceObject → PDFSourceAdapter
重排 reader → RenderableDocument / PreviewRenderer
ScreenOverlay → overlays.jsonl + AI gutter
marks / ai_turns append-only → marks.jsonl / ai-turns.jsonl
```

不需要推翻现有链路，只是把浏览器本地 IndexedDB 的部分持久化能力抽象为：

```text
RuntimeStorePort
  - IndexedDBRuntimeStore
  - SidecarRuntimeStore
  - CloudRuntimeStore
```

---

## 20. 与 KO / Adapter 开发口径保持一致

继续遵守：

```text
External Adapter 只吃 KnowledgeObject。
```

但新增一句：

```text
Renderer Plugin 不属于 External Adapter，它是 InkLoop Runtime 的一个宿主，需要读取 Sidecar Runtime Schema。
```

最终模块边界：

```text
InkLoop Core Runtime
  - SourceAdapter
  - SidecarStore
  - Renderer
  - KnowledgeBuilder

External Adapter
  - Obsidian KO Export
  - Notion KO Export
  - Markdown KO Export
```

---

## 21. 要求研发拆解

### Sprint 1：Sidecar Store MVP

交付：

```text
.inkloop manifest
path-index/doc-index
SidecarStore
HiddenFsPort
atomic write
JSONL append
```

验收：

```text
打开一个 .md，生成 .inkloop/docs/doc_xxx
重开 Obsidian 能找回 doc_id
不修改原始 .md
```

### Sprint 2：MarkdownSourceAdapter

交付：

```text
Markdown parser
block/line SurfaceObject
SourceRevision
quote/context remap
```

验收：

```text
Markdown 改一行后，已有 AI 旁注能重新定位
找不到的锚点进入 unresolved gutter
```

### Sprint 3：InkLoopDocumentView 预览模式

交付：

```text
自定义 InkLoop view
Markdown preview
AI gutter
ink overlay
sidecar overlay load
```

验收：

```text
打开 .md 看到原生内容 + 右侧 AI notes
原始 .md 无任何变化
```

### Sprint 4：编辑模式无限画布

交付：

```text
EditCanvasRenderer
free handwriting
typed text anywhere
canvas nodes sidecar persistence
preview/edit switch
```

验收：

```text
用户随手写/打字后，刷新仍恢复
原始 .md 不变
```

### Sprint 5：PDFSourceAdapter

交付：

```text
PDF load
page render
text layer / object refs
PDF overlay
PDF sidecar annotations
```

验收：

```text
导入 PDF 后可预览和标注
标注不写入 PDF binary
```

### Sprint 6：KO Export Adapter 对接

交付：

```text
从 sidecar / runtime 生成 KO
KO 导出为 Obsidian note
generated notes 可使用 controlled section
```

验收：

```text
用户选择“导出 AI note 到 Obsidian”
生成派生 Markdown note
源 Markdown/PDF 不变
```

---

## 22. 需要现在拍板的决策

1. **默认是否使用 `.inkloop/` 隐藏目录？**  选定：是，desktop v1 默认。
2. **是否允许默认写入用户 Markdown frontmatter？**  选定：否。
3. **Obsidian 插件主渲染是否使用自定义 InkLoop View？**  选定：是。
4. **编辑模式任意打字是否写回 Markdown？**  选定：默认不写，只进 sidecar。
5. **PDF 是否原地写入 annotation？**  选定：否，只导出副本。
6. **纯 InkLoop canvas 是否生成原生文件？**  选定：sidecar 为真相源，Markdown 是可选投影。
7. **KO 是否继续作为外部导出唯一契约？**  选定：是。
8. **Renderer 是否可读取 sidecar runtime schema？**  选定：必须可，否则无法完整渲染。

---

## 23. 最终口径

对内工程口径：

> Obsidian 插件不是只做 KO 导出，它同时是 InkLoop Runtime 的一个宿主。KO 仍然是外部导出契约；完整渲染需要 Sidecar Runtime Schema。用户的 Markdown/PDF 是原生源文件，InkLoop 的笔迹、AI 旁注、画布节点和锚点索引全部存到 `.inkloop` sidecar。预览模式读取原生源文件 + sidecar 渲染；编辑模式默认只写 sidecar，不自动修改源文件。PDF 和 InkLoop 新建文件也走同一套 SourceRef + Sidecar 机制。

对外用户口径：

> InkLoop 不会改写你的 Markdown 和 PDF。你的原文件保持原样；InkLoop 的手写、AI 旁注和画布编辑保存在一个独立的本地资料夹里。你可随时导出成普通 Markdown 或带批注 PDF。
