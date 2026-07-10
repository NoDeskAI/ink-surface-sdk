# InkLoop KnowledgeObject × Adapter × Obsidian 开发落地方案 v0.2

> 日期：2026-06-26  
> 状态：开发落地正式版，可进入任务拆分  
> 口径来源：`InkLoop对齐文档-KnowledgeObject契约-v0.1.md`  
> 目标读者：InkLoop 内部工程、协作方适配器工程、产品/技术负责人  
> 目标交付：把现有 `marks / ai_turns / HMP / InferenceView` 产出的思考结果稳定转换为 `KnowledgeObject`，再通过 Adapter 投影到 Obsidian，且保证幂等、可追踪、不覆盖用户笔记。

---

## 0. 本文的核心结论

本阶段不做一个“理想化全量数据平台”，而是做一条能落地、能验证、能扩展的最小闭环：

```text
InkLoop Tier 2 既有数据
marks / ai_turns / HMP / InferenceView
        ↓
KnowledgeBuilder
        ↓
KnowledgeObject v1
        ↓
Adapter Core
        ↓
Obsidian FS Adapter v1
        ↓
Obsidian Vault Markdown 文件
```

最关键的技术边界：

1. **Adapter 只消费 KnowledgeObject。**  
   Adapter 永远不碰 `Stroke / HMP / Mark / InferenceView / 基岩 schema`。底层标注理解属于 InkLoop 内部，外部世界只认 `KnowledgeObject`。

2. **InkLoop 是真相源，Obsidian 是投影层。**  
   Obsidian 不是源数据，不反向覆盖 InkLoop 的 AI 旁注正文、原文 quote、坐标和对象引用。v1 最多回传少量元数据，例如 `status / tags / task_done / remote_path`。

3. **v1 不引入 LedgerEvent 事件溯源。**  
   对齐文档已明确：InkLoop 供给 `KO + content_hash + inkloop:// URI`，ExternalBinding、SyncJob、冲突账本由适配器侧持有。不要为了“未来正确”把当前交付拖成无限架构工程。

4. **Obsidian v1 先做本地文件系统写入，v1.5 再做插件。**  
   FS v1 用桌面端或 CLI 直接写 Vault 目录，最快验证价值；Plugin v1.5 再解决 rename/delete 事件、移动端、Vault API 与更可靠的双向元数据同步。

5. **不覆盖用户自由笔记。**  
   InkLoop 只更新自己生成的 controlled section。用户在 controlled section 外写的内容永远保留；如果用户改了 controlled section，进入冲突状态，不自动覆盖。

---

## 1. 架构设计

### 1.1 总体架构图

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         InkLoop App Layer                            │
│                                                                     │
│  Web Demo / Desktop / Paper / Mobile                                 │
│                                                                     │
│  - PDF 导入                                                          │
│  - 笔迹采集                                                          │
│  - 页面对象命中                                                      │
│  - AI 旁注回屏                                                       │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              │ existing Tier 2 data
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        InkLoop Core Existing                         │
│                                                                     │
│  marks         用户标注账本                                           │
│  ai_turns      AI 回复账本                                            │
│  HMP           标注事实取证                                           │
│  InferenceView 给模型看的蒸馏视图                                      │
│                                                                     │
│  注：这里保持现状，不为 Adapter 重构字段名。                           │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              │ build / fold / map
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         KnowledgeBuilder                             │
│                                                                     │
│  输入：marks / ai_turns / docs / HMP                                  │
│  输出：KnowledgeObject v1                                             │
│                                                                     │
│  - ko_id 生成                                                         │
│  - kind 推断                                                          │
│  - content_hash 计算                                                  │
│  - status 映射                                                        │
│  - inkloop:// URI 拼装                                                │
│  - privacy / tags / callout 默认值                                    │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              │ stable contract
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         KnowledgeObject v1                           │
│                                                                     │
│  这是 InkLoop 与协作方唯一冻结接口。                                  │
│  Adapter 只能看这一层。                                               │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              │ plan / render / apply / bind / sync
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           Adapter Core                               │
│                                                                     │
│  - AdapterManifest                                                   │
│  - ExportPlan                                                        │
│  - RenderResult                                                      │
│  - ExternalBinding                                                   │
│  - SyncJob / SyncEvent                                               │
│  - ConflictRecord                                                    │
│  - StoragePort                                                       │
│  - TargetPort                                                        │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
┌─────────────────────────────┐   ┌───────────────────────────────────┐
│ Obsidian FS Adapter v1       │   │ Obsidian Plugin Adapter v1.5       │
│                             │   │                                   │
│ - Node/Tauri 文件系统写入     │   │ - Obsidian Vault API               │
│ - 选择 Vault 文件夹           │   │ - Vault.process                    │
│ - Markdown 渲染               │   │ - FileManager.processFrontMatter   │
│ - 受控区块替换                │   │ - 监听 rename/delete/modify        │
│ - SQLite/IndexedDB binding   │   │ - 本地 HTTP 或 JSON outbox 同步      │
└─────────────────────────────┘   └───────────────────────────────────┘
```

### 1.2 现有链路与新增链路的关系

现有 InkLoop 链路已经完成“用户注意力 → AI 旁注”的核心流程：

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

新增的 KO / Adapter 链路不改变这条主链路，只在 AI 旁注、用户圈注、原文摘录形成之后，从已有账本中折叠出外部世界可理解的对象：

```text
marks / ai_turns / docs
        ↓
KnowledgeBuilder
        ↓
KnowledgeObject
        ↓
Adapter
```

这意味着开发上有两个好处：

- **不阻塞现有标注体验。** KO Builder 是现有主链路之后的派生层，不要求改动笔迹采集、HMP、InferenceView。
- **不让外部 App 侵入核心数据。** Obsidian、Notion、Markdown、Readwise 之后都是不同 Adapter，统一吃 KO。

### 1.3 权责边界

| 层 | 归属 | 是否 v1 必做 | 说明 |
|---|---|---:|---|
| Stroke / HMP / Mark / InferenceView | InkLoop | 已有，保持 | Adapter 不可读取、不可依赖 |
| KnowledgeBuilder | InkLoop | 是 | 把现有 marks/ai_turns 翻译成 KO |
| KnowledgeObject schema | 共同冻结 | 是 | 唯一稳定契约 |
| content_hash | InkLoop | 是 | 判重、幂等、同步 diff 的基础 |
| inkloop:// URI | InkLoop | 是 | Adapter 原样写入，不自己拼 |
| Adapter Core | 协作方主导 | 是 | plan/render/apply/binding/sync/conflict |
| Obsidian FS Adapter | 协作方主导 | 是 | v1 最小闭环 |
| Obsidian Plugin | 协作方主导 | v1.5 | 增强可靠性，不阻塞 v1 |
| LedgerEvent 全事件溯源 | 暂不做 | 否 | 不进入本阶段范围 |
| 全文双向同步 | 暂不做 | 否 | v1 只做 push + 有限元数据 pull |

### 1.4 真相源原则

```text
InkLoop Tier 2 / KnowledgeObject = 内容真相源
ExternalBinding                  = 外部投影映射真相源
Obsidian Markdown                = 用户可读、可编辑的投影结果
```

所以同步规则为：

| 数据 | 真相源 | v1 是否从 Obsidian 回写 |
|---|---|---:|
| AI note 正文 | InkLoop | 否 |
| 原文 quote | InkLoop | 否 |
| page_index / object_refs / anchor_bbox | InkLoop | 否 |
| inkloop_uri | InkLoop | 否 |
| ko_id | InkLoop | 否 |
| content_hash | InkLoop | 否 |
| remote_path | Adapter/Obsidian | 是 |
| Obsidian 文件名变更 | Obsidian/Adapter | 是，更新 binding |
| status | 双方有限同步 | 是 |
| tags | merge | 是 |
| task done | Obsidian 可回写 | 是，仅 task KO |
| 用户自由笔记 | Obsidian | 不回写正文，只保留 |

### 1.5 v1 / v1.5 / v2 范围

#### v1：Obsidian FS 最小闭环

目标：从 fixtures 和真实 KO 导出到 Obsidian Vault，重复导出不重复创建，用户自由内容不被覆盖。

交付：

```text
@inkloop/ko-schema
@inkloop/knowledge-builder
@inkloop/adapter-core
@inkloop/adapter-markdown
@inkloop/adapter-obsidian-fs
@inkloop/adapter-cli
```

v1 做：

- KO schema runtime 校验。
- fixtures 校验。
- KO Builder 最小版本。
- KO JSON outbox。
- Obsidian Markdown renderer。
- Vault 文件夹写入。
- ExternalBinding。
- 重复导出幂等。
- controlled section 更新。
- 用户自由区保留。
- 基础冲突检测。

v1 不做：

- Obsidian 官方插件。
- 全文双向同步。
- OCR 裁图/笔迹/PDF 附件导出。
- relations 图谱。
- 团队 workspace。
- Notion Adapter。

#### v1.5：Obsidian Plugin 增强

目标：插件内部用 Obsidian Vault API 写文件，监听 rename/delete/modify，并支持移动端或更复杂 Vault 场景。

交付：

```text
obsidian-inkloop-plugin
@inkloop/adapter-obsidian-plugin-shared
```

v1.5 做：

- 插件设置页。
- 本地 HTTP / JSON outbox 对接。
- Vault API 写文件。
- rename/delete/modify 监听。
- frontmatter 安全更新。
- binding path 自动修复。
- metadata pull。

#### v2：多 Adapter 与云同步

目标：Notion、Readwise、Zotero、Drive 等接入同一 Adapter Core。

v2 才考虑：

- 多用户 workspace。
- relations。
- 团队共享。
- 云端 Adapter runner。
- Notion data source 映射。
- 文档资产导出。

---

## 2. Schema 设计

### 2.1 KnowledgeObject v1：冻结契约

```ts
export type ISODateTime = string;
export type Sha256 = `sha256:${string}`;
export type NormBBox = [number, number, number, number];

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
 | 'concept';

export type KnowledgeStatus =
 | 'inbox'
 | 'accepted'
 | 'edited'
 | 'dismissed'
 | 'export_ready'
 | 'exported'
 | 'archived';

export type Privacy = 'local_only' | 'export_allowed';

export type KnowledgeSourceRef =
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
   };

export interface KnowledgeObject {
  schema_version: 'inkloop.knowledge_object.v1';

  /** InkLoop 生成，跨端稳定身份。格式：ko_ + ULID。 */
  ko_id: string;

  kind: KnowledgeKind;
  title: string;

  /** Markdown 正文；渲染进 Obsidian controlled section。 */
  body_md: string;

  source: {
    document_id: string;
    document_title: string;
    page_id?: string;

    /** 0-based 页码。渲染给用户时展示为 page_index + 1。 */
    page_index?: number;

    /** 命中页面对象 id，可空。Adapter 不理解，只原样保存。 */
    object_refs: string[];

    /** 归一化 [x, y, w, h]。Adapter 不重算，只保存。 */
    anchor_bbox?: NormBBox;

    /** 被标注的原文摘录。 */
    quote?: string;

    /** InkLoop 负责拼装；Adapter 原样写入。 */
    inkloop_uri: string;
  };

  /** 组合证据：文档锚点 + 会议事件标记 + 项目记忆。 */
  source_refs?: KnowledgeSourceRef[];

  provenance: {
    created_from: 'mark' | 'ai_turn' | 'session' | 'meeting_mark' | 'postprocess' | 'manual';
    mark_ids?: string[];
    ai_turn_ids?: string[];
    meeting_id?: string;
    meeting_mark_ids?: string[];
    postprocess_result_id?: string;
  };

  /** 默认含 inkloop 与 inkloop/<kind-slug>。 */
  tags: string[];

  status: KnowledgeStatus;
  privacy: Privacy;

  render_hints?: {
    markdown_callout?: 'note' | 'quote' | 'question' | 'todo' | 'summary' | 'tip' | 'warning' | 'success';
  };

  /** sha256(canonicalJson(KO 去掉 content_hash 字段))。 */
  content_hash: Sha256;

  created_at: ISODateTime;
  updated_at: ISODateTime;
}
```

### 2.2 v1 明确不进入 KO 的字段

这些字段不是永远不要，而是 v1 不放，避免空头承诺：

| 字段 | v1 不放原因 | 后续策略 |
|---|---|---|
| `relations` | 当前无稳定关系图对外契约 | v1.1 以 minor 增量添加 |
| `workspace_id` | 先单用户 | 多用户/团队版再加 |
| `owner_user_id` | 先单用户 | 云同步再加 |
| `export_hints` | v1 用默认渲染 | Adapter 支持多模板后再加 |
| `session_id` | 现有契约未冻结 | summary/collection 类 KO 再加 |
| `inference_view_id` | 内部实现字段，不给 Adapter | debug 包或开发模式再加 |
| `hmp_ids` | 内部证据字段，不给 Adapter | 需要审计时以 debug metadata 增量加 |
| `asset_refs` | v1 不导出裁图/笔迹/PDF | v1.2 加入受控附件能力 |

### 2.3 Schema 与 Adapter 的联动关系

Adapter 不理解 InkLoop 内部，但必须理解 KO 字段的导出语义：

| KO 字段 | Adapter 用途 | Obsidian 落点 |
|---|---|---|
| `ko_id` | 远端身份、binding key、文件 frontmatter identity | `inkloop_id` |
| `kind` | 选择模板、callout 类型、目录 | `inkloop_kind`、文件路径 |
| `title` | note 标题和文件标题 | Markdown `# title`、文件名 |
| `body_md` | controlled section 主体 | callout 或正文 |
| `source.document_id` | source note 身份 | `document_id` |
| `source.document_title` | 源文档展示 | `document_title`、source backlink |
| `source.page_index` | 页码展示 | `page` / `page_index` |
| `source.object_refs` | 锚点审计和回跳 | YAML list，不参与 Obsidian 锚定 |
| `source.anchor_bbox` | 锚点审计 | YAML 数组 |
| `source.quote` | 原文引用 | quote callout |
| `source.inkloop_uri` | 回跳 InkLoop | Markdown link / frontmatter |
| `source_refs` | 组合证据审计，保留会议标记和项目记忆引用 | YAML list，不参与 Obsidian 锚定 |
| `provenance` | debug / 审计 | YAML |
| `tags` | Obsidian tag | YAML `tags` |
| `status` | 导出过滤 / 回写 | `inkloop_status` |
| `privacy` | 导出前置校验 | 不导出或 YAML 保留 |
| `render_hints.markdown_callout` | 选择 callout 样式 | `[!note]` / `[!quote]` 等 |
| `content_hash` | 幂等、diff、冲突判断 | `inkloop_content_hash` + controlled marker |
| `created_at/updated_at` | 排序、展示、审计 | YAML |

### 2.4 Runtime 校验

使用 Zod 定义 runtime schema：

```ts
import { z } from 'zod';

export const NormBBoxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(([x, y, w, h]) => {
    return x >= 0 && y >= 0 && w >= 0 && h >= 0 && x + w <= 1.000001 && y + h <= 1.000001;
  }, 'bbox must be normalized [x,y,w,h]');

export const KnowledgeObjectSchema = z.object({
  schema_version: z.literal('inkloop.knowledge_object.v1'),
  ko_id: z.string().regex(/^ko_[0-9A-HJKMNP-TV-Z]{26}$/),
  kind: z.enum(['source_document', 'excerpt', 'annotation', 'ai_note', 'qa', 'summary', 'task', 'decision', 'risk', 'question', 'concept']),
  title: z.string().min(1).max(200),
  body_md: z.string().max(100_000),
  source: z.object({
    document_id: z.string().min(1),
    document_title: z.string().min(1),
    page_id: z.string().optional(),
    page_index: z.number().int().nonnegative().optional(),
    object_refs: z.array(z.string()).default([]),
    anchor_bbox: NormBBoxSchema.optional(),
    quote: z.string().max(20_000).optional(),
    inkloop_uri: z.string().regex(/^inkloop:\/\//),
  }),
  source_refs: z.array(z.discriminatedUnion('ref_type', [
    z.object({
      ref_type: z.literal('document'),
      document_id: z.string().min(1),
      page_id: z.string().min(1),
      page_index: z.number().int().nonnegative().optional(),
      event_id: z.string().optional(),
      trace_id: z.string().optional(),
      bbox: NormBBoxSchema.optional(),
      object_refs: z.array(z.string()).default([]),
      quote: z.string().max(20_000).optional(),
    }),
    z.object({
      ref_type: z.literal('meeting_mark'),
      meeting_id: z.string().min(1),
      meeting_mark_id: z.string().min(1),
      time_ms: z.number().nonnegative(),
      captured_at_ms: z.number().nonnegative(),
      kind: z.enum(['question', 'risk', 'action', 'decision', 'attention', 'note']),
      source: z.string().min(1),
    }),
    z.object({
      ref_type: z.literal('project_memory'),
      memory_id: z.string().min(1),
      kind: z.enum(['goal', 'milestone', 'decision', 'risk', 'task', 'knowledge_object']),
      title: z.string().min(1),
      source_uri: z.string().optional(),
    }),
  ])).optional(),
  provenance: z.object({
    created_from: z.enum(['mark', 'ai_turn', 'session', 'meeting_mark', 'postprocess', 'manual']),
    mark_ids: z.array(z.string()).optional(),
    ai_turn_ids: z.array(z.string()).optional(),
    meeting_id: z.string().optional(),
    meeting_mark_ids: z.array(z.string()).optional(),
    postprocess_result_id: z.string().optional(),
  }),
  tags: z.array(z.string()).default([]),
  status: z.enum(['inbox', 'accepted', 'edited', 'dismissed', 'export_ready', 'exported', 'archived']),
  privacy: z.enum(['local_only', 'export_allowed']),
  render_hints: z
    .object({
      markdown_callout: z.enum(['note', 'quote', 'question', 'todo', 'summary', 'tip', 'warning', 'success']).optional(),
    })
    .optional(),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type KnowledgeObject = z.infer<typeof KnowledgeObjectSchema>;
```

开发期必须提供两个入口：

```ts
export function parseKnowledgeObject(input: unknown): KnowledgeObject;
export function safeParseKnowledgeObject(input: unknown): SafeParseReturnType<unknown, KnowledgeObject>;
```

所有 Adapter 的第一个动作都是：

```ts
const ko = parseKnowledgeObject(raw);
```

不允许 Adapter 对“半残 KO”做兼容性猜测。

### 2.5 `ko_id` 生成与稳定性

契约要求 `ko_id = 'ko_' + ULID`。但是如果每次构建都重新生成 ULID，会导致重复导出。因此必须引入 `provenance_key → ko_id` 映射表。

#### provenance_key 规则

| KO 类型 | provenance_key |
|---|---|
| AI note / QA | `ai_turn:<ai_turn_id>` |
| excerpt / annotation | `mark:<mark_id>` |
| source_document | `document:<document_id>` |
| summary | `summary:<document_id>:<session_or_time_bucket_hash>` |
| manual | `manual:<local_manual_id>` |

#### 本地映射表

```ts
interface KnowledgeIdentityIndex {
  provenance_key: string;
  ko_id: string;
  created_at: string;
  last_seen_at: string;
}
```

算法：

```ts
function getOrCreateKoId(provenanceKey: string): string {
  const hit = identityIndex.get(provenanceKey);
  if (hit) return hit.ko_id;

  const koId = `ko_${ulid()}`;
  identityIndex.put({ provenance_key: provenanceKey, ko_id: koId, created_at: now(), last_seen_at: now() });
  return koId;
}
```

这样即使 KO 是按需构建，`ko_id` 仍然稳定。

### 2.6 `content_hash` 规则

`content_hash` 是 Adapter 幂等和冲突判断的基础，必须稳定。

#### 计算口径

```text
content_hash = 'sha256:' + sha256(canonicalJson(knowledgeObject without content_hash))
```

#### canonicalJson 规则

1. 移除 `content_hash` 字段。
2. 对 object keys 递归按字典序排序。
3. `undefined` 字段不写入。
4. `null` 保留。
5. 数组顺序保留，不排序。
6. 字符串不做 trim。
7. 日期必须是 ISO string。
8. 不带空格和换行。

示例：

```ts
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export async function computeKnowledgeHash(ko: Omit<KnowledgeObject, 'content_hash'>): Promise<Sha256> {
  const body = canonicalize(ko);
  const digest = await sha256Hex(body);
  return `sha256:${digest}`;
}
```

#### 什么变化会改变 hash

会改变：

- `body_md` 改变。
- `quote` 改变。
- `tags` 改变。
- `status` 改变。
- `updated_at` 改变。
- `source.inkloop_uri` 改变。

这会导致“只改 status 也变 hash”。如果不想让 status 改变触发正文重渲染，可在 Adapter 内区分：

```ts
content_hash        // 全量 KO hash，判定 KO 版本
render_body_hash    // renderer 自己计算，只针对会影响 controlled section 的字段
metadata_hash       // 只针对 frontmatter/status/tags
```

要求 v1 做两个 hash：

```ts
interface RenderHashes {
  ko_content_hash: Sha256;     // KO 原始 hash
  render_body_hash: Sha256;    // quote + body_md + source link + template version
}
```

`content_hash` 仍按契约生成；`render_body_hash` 属于 Adapter 内部，不写回 KO。

### 2.7 `inkloop://` URI 拼装

Adapter 不拼 URI，只使用 KO 中的 `source.inkloop_uri`。InkLoop 内部需要提供统一 builder：

```ts
export function buildInkloopDocUri(documentId: string): string {
  return `inkloop://doc/${encodeURIComponent(documentId)}`;
}

export function buildInkloopPageUri(input: {
  documentId: string;
  pageIndex: number;
  anchorObjectId?: string;
}): string {
  const base = `inkloop://doc/${encodeURIComponent(input.documentId)}/page/${input.pageIndex}`;
  if (!input.anchorObjectId) return base;
  return `${base}?anchor=${encodeURIComponent(input.anchorObjectId)}`;
}

export function buildInkloopKoUri(koId: string): string {
  return `inkloop://ko/${encodeURIComponent(koId)}`;
}

export function buildInkloopMarkUri(markId: string): string {
  return `inkloop://mark/${encodeURIComponent(markId)}`;
}
```

v1 暂时只保证 URI 被写进 Obsidian；InkLoop 桌面端协议注册可稍后做，但字段要先稳定。

---

## 3. KnowledgeBuilder 模块设计

### 3.1 模块职责

KnowledgeBuilder 的职责是把 InkLoop 内部已有事实折叠为 KO。它不负责外部导出，也不处理 Obsidian 逻辑。

```text
输入：
- docs
- marks
- ai_turns
- HMP
- overlay state

输出：
- KnowledgeObject[]
- KnowledgeBuildReport
```

### 3.2 包结构

```text
packages/
  ko-schema/
    src/
      knowledge-object.ts
      validators.ts
      canonical-json.ts
      hash.ts
      uri.ts
      fixtures.ts
      index.ts

  knowledge-builder/
    src/
      builder.ts
      identity-index.ts
      kind-inference.ts
      status-map.ts
      default-tags.ts
      default-render-hints.ts
      source-map.ts
      build-report.ts
      index.ts
```

### 3.3 输入接口

为了不把 KnowledgeBuilder 绑死在 IndexedDB 或 SQLite 上，使用端口接口：

```ts
export interface KnowledgeBuilderStorePort {
  getDoc(documentId: string): Promise<InkLoopDoc | null>;
  listDocs(): Promise<InkLoopDoc[]>;

  getFoldedMarks(documentId: string): Promise<InkLoopMark[]>;
  getFoldedAiTurns(documentId: string): Promise<InkLoopAiTurn[]>;

  getKoIdByProvenanceKey(key: string): Promise<string | null>;
  putKoIdentity(key: string, koId: string): Promise<void>;

  upsertKnowledgeObject?(ko: KnowledgeObject): Promise<void>;
  listKnowledgeObjects?(query: KnowledgeQuery): Promise<KnowledgeObject[]>;
}
```

### 3.4 输出接口

```ts
export interface BuildKnowledgeObjectsInput {
  document_id?: string;
  mark_ids?: string[];
  ai_turn_ids?: string[];
  include_dismissed?: boolean;
  include_archived?: boolean;
  now?: string;
}

export interface BuildKnowledgeObjectsResult {
  objects: KnowledgeObject[];
  skipped: Array<{
    reason:
 | 'privacy_local_only'
 | 'folded'
 | 'dismissed'
 | 'empty_body'
 | 'missing_source'
 | 'unsupported_kind';
    source_id: string;
    detail?: string;
  }>;
  warnings: Array<{
    code: string;
    detail: string;
  }>;
}
```

### 3.5 kind 推断规则

v1 先用确定性规则，不调用模型。

```ts
function inferKnowledgeKind(input: {
  mark?: InkLoopMark;
  aiTurn?: InkLoopAiTurn;
  postProcessResultType?: 'task' | 'decision' | 'risk' | 'question' | 'knowledge_note';
  hasQuestion?: boolean;
  isUserHandwritingNote?: boolean;
}): KnowledgeKind {
  if (input.postProcessResultType) {
    if (input.postProcessResultType === 'knowledge_note') return 'ai_note';
    return input.postProcessResultType;
  }

  if (input.aiTurn) {
    if (input.hasQuestion) return 'qa';
    return 'ai_note';
  }

  if (input.mark) {
    if (input.isUserHandwritingNote) return 'annotation';
    if (input.mark.marked_text?.trim()) return 'excerpt';
    return 'annotation';
  }

  return 'concept';
}
```

更细规则：

| 输入情况 | kind | body_md |
|---|---|---|
| AI turn 有 hand-written question | `qa` | `ai_turn.ai_reply`，前面渲染 question |
| AI turn 无明确 question | `ai_note` | `ai_turn.ai_reply` |
| mark 无 AI，但命中文字 | `excerpt` | `marks.marked_text` |
| mark 是用户手写笔记 | `annotation` | 手写识别文本或描述 |
| session summary | `summary` | session 级总结 |
| TODO / action 语义 | `task` | 待办正文 |
| PostProcessResult decision | `decision` | 决策正文 |
| PostProcessResult risk | `risk` | 风险正文 |
| PostProcessResult question | `question` | 问题正文 |

v1 的任务识别先依赖显式 marker，例如用户手写被识别为 `TODO:`、`待办:`、`action:`。会议场景里的 `decision`、`risk`、`question` 只来自 `PostProcessResult.result_type`，不从会议转写或说话人内容推断。

### 3.6 status 映射

```ts
export function mapOverlayStateToKnowledgeStatus(overlayState: string): KnowledgeStatus | null {
  switch (overlayState) {
    case 'shown':
      return 'export_ready';
    case 'accepted':
      return 'accepted';
    case 'edited':
      return 'edited';
    case 'dismissed':
      return 'dismissed';
    case 'folded':
      return null; // 不导出
    default:
      return 'inbox';
  }
}
```

导出 eligibility：

```ts
function isExportable(ko: KnowledgeObject): boolean {
  return ko.privacy === 'export_allowed'
    && ['export_ready', 'accepted', 'edited'].includes(ko.status)
    && ko.body_md.trim().length > 0;
}
```

### 3.7 默认 tags

```ts
function defaultTags(kind: KnowledgeKind): string[] {
  const slug = kind.replace('_', '-');
  return ['inkloop', `inkloop/${slug}`];
}
```

示例：

| kind | tags |
|---|---|
| `ai_note` | `['inkloop', 'inkloop/ai-note']` |
| `excerpt` | `['inkloop', 'inkloop/excerpt']` |
| `qa` | `['inkloop', 'inkloop/qa']` |
| `task` | `['inkloop', 'inkloop/task']` |
| `decision` | `['inkloop', 'inkloop/decision']` |
| `risk` | `['inkloop', 'inkloop/risk']` |
| `question` | `['inkloop', 'inkloop/question']` |

### 3.8 默认 render_hints

```ts
function defaultCallout(kind: KnowledgeKind): KnowledgeObject['render_hints']['markdown_callout'] {
  switch (kind) {
    case 'excerpt': return 'quote';
    case 'annotation': return 'note';
    case 'ai_note': return 'note';
    case 'qa': return 'question';
    case 'summary': return 'summary';
    case 'task': return 'todo';
    case 'decision': return 'success';
    case 'risk': return 'warning';
    case 'question': return 'question';
    case 'concept': return 'tip';
    default: return 'note';
  }
}
```

### 3.9 source 构建规则

```ts
function buildSource(input: {
  doc: InkLoopDoc;
  mark?: InkLoopMark;
  aiTurn?: InkLoopAiTurn;
}): KnowledgeObject['source'] {
  const mark = input.mark ?? findPrimaryMark(input.aiTurn);
  const objectRefs = mark?.hmp?.target_object_refs ?? mark?.hmp?.object_refs ?? [];
  const anchorObjectId = objectRefs[0];

  return {
    document_id: input.doc.document_id,
    document_title: input.doc.filename ?? input.doc.title ?? 'Untitled document',
    page_id: mark?.page_id,
    page_index: mark?.page_index,
    object_refs: objectRefs,
    anchor_bbox: mark?.bbox ?? mark?.hmp?.anchor_bbox,
    quote: mark?.marked_text,
    inkloop_uri: buildInkloopPageUri({
      documentId: input.doc.document_id,
      pageIndex: mark?.page_index ?? 0,
      anchorObjectId,
    }),
  };
}
```

### 3.10 KO 持久化策略

v1 选定“构建后缓存”，不是每次临时计算：

```text
marks / ai_turns 变化
        ↓
KnowledgeBuilder rebuild affected KO
        ↓
upsert knowledge_objects store
        ↓
adapter 从 knowledge_objects 查询 export_ready 对象
```

新增本地 store：

```ts
interface PersistedKnowledgeObjectRecord {
  ko_id: string;
  document_id: string;
  provenance_key: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  privacy: Privacy;
  content_hash: Sha256;
  object_json: KnowledgeObject;
  created_at: string;
  updated_at: string;
  last_built_at: string;
}
```

如果当前不想改 IndexedDB 版本，也可先输出 JSON：

```text
.inkloop/outbox/knowledge-objects-<export_id>.json
```

但要求尽快补 `knowledge_objects` store，因为 Adapter UI、筛选、预览、状态更新都需要稳定查询。

---

## 4. Adapter Core 模块设计

### 4.1 Adapter Core 职责

Adapter Core 不知道 Obsidian 细节，也不处理 InkLoop 内部数据。它只定义统一导出生命周期：

```text
validate KO
  ↓
validate target
  ↓
plan export
  ↓
render remote payload
  ↓
apply to remote target
  ↓
write ExternalBinding
  ↓
emit SyncEvent
  ↓
optional pull metadata
```

### 4.2 包结构

```text
packages/
  adapter-core/
    src/
      manifest.ts
      adapter.ts
      target.ts
      export-plan.ts
      render-result.ts
      external-binding.ts
      sync-job.ts
      sync-event.ts
      conflict.ts
      storage-port.ts
      queue.ts
      errors.ts
      index.ts
```

### 4.3 AdapterManifest

```ts
export interface AdapterManifest {
  provider: 'obsidian_fs' | 'obsidian_plugin' | 'markdown' | 'notion' | string;
  display_name: string;
  version: string;

  direction: 'push' | 'pull' | 'bidirectional';

  auth: 'none' | 'local_fs' | 'plugin_token' | 'oauth' | 'api_key';

  capabilities: {
    create: boolean;
    update: boolean;
    append: boolean;
    delete: boolean;
    read: boolean;
    pull_metadata: boolean;
    deep_link: boolean;
    attachments: boolean;
    controlled_sections: boolean;
    frontmatter: boolean;
  };
}
```

Obsidian FS v1：

```ts
export const ObsidianFsManifest: AdapterManifest = {
  provider: 'obsidian_fs',
  display_name: 'Obsidian Vault Folder',
  version: '0.1.0',
  direction: 'push',
  auth: 'local_fs',
  capabilities: {
    create: true,
    update: true,
    append: true,
    delete: false,
    read: true,
    pull_metadata: true,
    deep_link: true,
    attachments: false,
    controlled_sections: true,
    frontmatter: true,
  },
};
```

### 4.4 Adapter 接口

```ts
export interface ExportAdapter<Config, Target, Payload> {
  manifest: AdapterManifest;

  validateConfig(config: Config): Promise<ValidationResult>;
  resolveTarget(config: Config): Promise<Target>;

  plan(input: {
    objects: KnowledgeObject[];
    target: Target;
    storage: AdapterStoragePort;
    policy: SyncPolicy;
  }): Promise<ExportPlan>;

  render(input: {
    object: KnowledgeObject;
    target: Target;
    binding?: ExternalBinding;
  }): Promise<Payload>;

  apply(input: {
    object: KnowledgeObject;
    target: Target;
    payload: Payload;
    binding?: ExternalBinding;
    policy: SyncPolicy;
  }): Promise<ApplyResult>;

  pullMetadata?(input: {
    target: Target;
    bindings: ExternalBinding[];
  }): Promise<PullMetadataResult>;
}
```

### 4.5 ExportPlan

```ts
export interface ExportPlan {
  plan_id: string;
  provider: string;
  target_id: string;
  created_at: string;

  items: ExportPlanItem[];

  summary: {
    create_count: number;
    update_count: number;
    skip_count: number;
    conflict_count: number;
  };
}

export interface ExportPlanItem {
  ko_id: string;
  action:
 | 'create'
 | 'update'
 | 'skip_unchanged'
 | 'skip_privacy'
 | 'skip_status'
 | 'conflict'
 | 'relink_then_update';

  reason?: string;
  binding_id?: string;
  remote_path?: string;
  preview_markdown?: string;
  conflict_code?: ConflictCode;
}
```

### 4.6 ExternalBinding

ExternalBinding 是 Adapter 层最重要的持久对象。

```ts
export interface ExternalBinding {
  binding_id: string;

  provider: 'obsidian_fs' | 'obsidian_plugin' | string;
  target_id: string;

  ko_id: string;
  ko_content_hash: Sha256;
  render_body_hash: Sha256;

  remote_id: string;
  remote_path: string;
  remote_url?: string;

  remote_rev?: string;

  mapping_version: 'inkloop.obsidian.mapping.v1';

  sync_state:
 | 'active'
 | 'queued'
 | 'remote_changed'
 | 'remote_missing'
 | 'duplicate_remote'
 | 'conflict'
 | 'error'
 | 'archived';

  last_exported_at: string;
  last_seen_remote_at?: string;
  last_error?: string;

  created_at: string;
  updated_at: string;
}
```

`remote_id` 在 Obsidian FS v1 中可使用：

```text
remote_id = sha256(vault_root_canonical_path + ':' + remote_path)
```

因为 Obsidian 文件没有稳定 remote id，真正身份仍是 frontmatter 的 `inkloop_id`。

### 4.7 SyncJob

```ts
export interface SyncJob {
  job_id: string;
  provider: string;
  target_id: string;

  direction: 'push' | 'pull_metadata';
  ko_ids: string[];

  status:
 | 'queued'
 | 'running'
 | 'succeeded'
 | 'partial_succeeded'
 | 'failed'
 | 'blocked';

  priority: 'interactive' | 'background';
  attempts: number;
  max_attempts: number;

  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;

  last_error?: string;
  plan_id?: string;
}
```

### 4.8 SyncEvent

```ts
export interface SyncEvent {
  event_id: string;
  job_id?: string;
  binding_id?: string;
  ko_id?: string;
  provider: string;

  level: 'debug' | 'info' | 'warn' | 'error';
  type:
 | 'plan.created'
 | 'file.created'
 | 'file.updated'
 | 'file.skipped_unchanged'
 | 'binding.created'
 | 'binding.updated'
 | 'conflict.detected'
 | 'remote_missing'
 | 'duplicate_remote'
 | 'job.completed'
 | 'job.failed';

  message: string;
  data?: Record<string, unknown>;
  created_at: string;
}
```

### 4.9 ConflictRecord

```ts
export type ConflictCode =
 | 'controlled_section_modified'
 | 'missing_controlled_section'
 | 'frontmatter_identity_missing'
 | 'frontmatter_identity_mismatch'
 | 'remote_file_missing'
 | 'duplicate_remote_files'
 | 'write_permission_denied'
 | 'invalid_vault'
 | 'schema_version_unsupported';

export interface ConflictRecord {
  conflict_id: string;
  provider: string;
  target_id: string;
  ko_id: string;
  binding_id?: string;
  code: ConflictCode;

  severity: 'low' | 'medium' | 'high';

  remote_path?: string;
  local_content_hash?: Sha256;
  remote_render_body_hash?: Sha256;

  resolution_status: 'open' | 'resolved' | 'ignored';
  resolution_strategy?:
 | 'append_new_version'
 | 'overwrite_controlled_section'
 | 'create_new_file'
 | 'relink_existing_file'
 | 'ignore_remote';

  detail: string;
  created_at: string;
  updated_at: string;
}
```

### 4.10 SyncPolicy

```ts
export interface SyncPolicy {
  content_authority: 'inkloop' | 'manual';
  metadata_authority: 'inkloop' | 'remote' | 'merge';

  conflict_strategy:
 | 'skip'
 | 'append_new_version'
 | 'ask_user'
 | 'inkloop_wins';

  privacy_filter: Privacy[];

  delete_policy: 'never_delete_remote' | 'trash_remote_on_archive';

  allowed_statuses: KnowledgeStatus[];
}
```

v1 默认：

```ts
export const DefaultObsidianFsPolicy: SyncPolicy = {
  content_authority: 'inkloop',
  metadata_authority: 'merge',
  conflict_strategy: 'append_new_version',
  privacy_filter: ['export_allowed'],
  delete_policy: 'never_delete_remote',
  allowed_statuses: ['export_ready', 'accepted', 'edited'],
};
```

---

## 5. Obsidian FS Adapter v1 设计

### 5.1 为什么 v1 先做 FS Adapter

Obsidian 的核心模型是一个 Vault，本质是一个文件夹以及其中的子文件夹。v1 直接写入 Vault 文件系统，能最快验证导出价值，同时避免插件开发、审核、移动端差异和用户安装成本。

v1 的目标不是“完美 Obsidian 集成”，而是满足这些硬指标：

- 能把 KO 变成 Markdown。
- 能写入用户指定 Vault。
- 重复导出同一个 KO 不重复创建。
- KO 内容变化时只更新 InkLoop controlled section。
- 用户自己在文件里写的内容不被覆盖。
- 用户移动/重命名文件后能尽量找回。
- 冲突不自动覆盖。

### 5.2 FS Adapter 包结构

```text
packages/
  adapter-markdown/
    src/
      render-knowledge-object.ts
      render-frontmatter.ts
      render-callout.ts
      render-source-section.ts
      controlled-section.ts
      markdown-escape.ts
      file-name.ts
      index.ts

  adapter-obsidian-fs/
    src/
      manifest.ts
      config.ts
      target.ts
      vault-validator.ts
      path-policy.ts
      obsidian-uri.ts
      source-note.ts
      export-planner.ts
      fs-writer.ts
      frontmatter-parser.ts
      controlled-section-parser.ts
      conflict-detector.ts
      metadata-puller.ts
      adapter.ts
      index.ts
```

### 5.3 Target 配置

```ts
export interface ObsidianFsConfig {
  vault_root: string;

  /** 默认 InkLoop */
  base_dir?: string;

  /** 是否创建 Sources 文档索引 note。默认 true。 */
  create_source_notes?: boolean;

  /** 是否在 Obsidian 中自动打开导出后的 note。默认 false。 */
  open_after_export?: boolean;

  /** Vault 名称或 Vault ID，用于 obsidian://open。可选。 */
  vault_name_or_id?: string;
}

export interface ObsidianFsTarget {
  target_id: string;
  vault_root: string;
  base_dir: string;
  notes_dir: string;
  sources_dir: string;
  assets_dir: string;
  vault_name_or_id?: string;
}
```

### 5.4 Vault 校验

```ts
async function validateVaultRoot(vaultRoot: string): Promise<ValidationResult> {
  // 必须存在
  // 必须是目录
  // 必须可读写
  // 如果存在 .obsidian，则认为高度可信
  // 如果不存在 .obsidian，可警告但不硬失败；部分用户可能指定一个将要作为 Vault 的文件夹
}
```

校验等级：

| 条件 | 结果 |
|---|---|
| 路径不存在 | fail |
| 不是目录 | fail |
| 无写权限 | fail |
| 包含 `.obsidian/` | pass |
| 不包含 `.obsidian/` | warn |
| `InkLoop/` 不存在 | export 时创建 |
| 路径在系统敏感目录 | warn/fail，例如 `/`, `C:\Windows` |

### 5.5 Vault 目录结构

默认写入：

```text
<Vault>/
  InkLoop/
    Sources/
      量子力学导论 - doc_3f9a1c2b7e04.md
    Notes/
      2026-06-26 AI Note - 量子力学导论 p14 - QCJBW2.md
      2026-06-26 Excerpt - 量子力学导论 p14 - RBYE10.md
    Tasks/
      2026-06-26 Task - 量子力学导论 p22 - 8DM1GA.md
    Summaries/
      2026-06-26 Summary - 量子力学导论 - 2QW9SA.md
    Concepts/
      Concept - 量子纠缠 - C1Z4F3.md
    _assets/
      # v1 暂不使用
```

目录映射：

| kind | dir |
|---|---|
| `source_document` | `Sources/` |
| `excerpt` | `Notes/` 或 `Excerpts/`；v1 选定 `Notes/` 减少目录 |
| `annotation` | `Notes/` |
| `ai_note` | `Notes/` |
| `qa` | `Notes/` |
| `summary` | `Summaries/` |
| `task` | `Tasks/` |
| `concept` | `Concepts/` |

v1 选定少目录版本：`Sources / Notes / Tasks / Summaries / Concepts / _assets`。

### 5.6 文件命名规则

必须满足：

- Windows / macOS / Linux 文件名兼容。
- 同名文档不会冲突。
- 用户重命名后仍可通过 frontmatter 找回。
- 文件名可读。

```ts
function makeObsidianFileName(ko: KnowledgeObject): string {
  const date = ko.created_at.slice(0, 10);
  const kindLabel = kindToFileLabel(ko.kind);
  const title = sanitizeFileName(ko.source.document_title || ko.title).slice(0, 80);
  const page = ko.source.page_index === undefined ? '' : ` p${ko.source.page_index + 1}`;
  const tail = ko.ko_id.slice(-6);
  return `${date} ${kindLabel} - ${title}${page} - ${tail}.md`;
}
```

非法字符处理：

```ts
function sanitizeFileName(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
 || 'Untitled';
}
```

### 5.7 Markdown 文件身份设计

路径不是身份，`inkloop_id` 才是身份。

文件 frontmatter 必须包含：

```yaml
inkloop_id: ko_01JZ7D5E7WJK4F5NTAT9QCJBW2
inkloop_schema: inkloop.knowledge_object.v1
inkloop_kind: ai_note
inkloop_status: export_ready
inkloop_content_hash: sha256:...
inkloop_render_body_hash: sha256:...
document_id: doc_3f9a1c2b7e04
document_title: 量子力学导论
page_index: 13
page: 14
object_refs:
  - run_p14_021_3
  - run_p14_021_4
anchor_bbox:
  - 0.31
  - 0.31
  - 0.12
  - 0.02
inkloop_uri: inkloop://doc/doc_3f9a1c2b7e04/page/13?anchor=run_p14_021_3
created: 2026-06-26T06:32:07.829Z
updated: 2026-06-26T06:32:07.829Z
tags:
  - inkloop
  - inkloop/ai-note
```

为什么不用 `status` 而用 `inkloop_status`：

- Obsidian 用户可能已经用 `status` 管自己的项目。
- `inkloop_status` 表示 InkLoop projection 状态，语义更明确。

### 5.8 Controlled Section 设计

正文采用受控区块：

```md
<!-- inkloop:begin ko=ko_01JZ7D5E7WJK4F5NTAT9QCJBW2 hash=sha256:abc123 mapping=inkloop.obsidian.mapping.v1 -->

> [!quote] Source quote
> 量子纠缠

> [!note] InkLoop
> 量子纠缠已被贝尔不等式实验反复验证（如 2022 诺奖 Aspect 等）；它不传递信息，故不违反相对论。

**Source**: [[量子力学导论 - doc_3f9a1c2b7e04|量子力学导论]], p14  
**Open in InkLoop**: [inkloop://doc/doc_3f9a1c2b7e04/page/13?anchor=run_p14_021_3](inkloop://doc/doc_3f9a1c2b7e04/page/13?anchor=run_p14_021_3)

<!-- inkloop:end ko=ko_01JZ7D5E7WJK4F5NTAT9QCJBW2 -->
```

文件完整模板：

```md
---
# YAML frontmatter
---

# AI Note · 量子力学导论 · p14

<!-- inkloop:begin ko=... hash=... mapping=inkloop.obsidian.mapping.v1 -->
...
<!-- inkloop:end ko=... -->

---

## My notes

<!-- 用户在这里写内容；InkLoop 永不覆盖。 -->
```

### 5.9 controlled section 替换算法

```ts
function replaceControlledSection(input: {
  existingMarkdown: string;
  koId: string;
  oldRenderBodyHash?: Sha256;
  newSection: string;
}): ReplaceResult {
  const sections = findInkloopSections(existingMarkdown, koId);

  if (sections.length === 0) {
    return { type: 'missing_section' };
  }

  if (sections.length > 1) {
    return { type: 'duplicate_sections' };
  }

  const section = sections[0];
  const currentSectionHash = hashSectionBody(section.body);

  // 如果当前文件里的 section 跟上次写入的不一致，说明用户或外部工具改了受控区块。
  if (oldRenderBodyHash && currentSectionHash !== oldRenderBodyHash) {
    return { type: 'controlled_section_modified', currentSectionHash };
  }

  const nextMarkdown =
    existingMarkdown.slice(0, section.start) +
    newSection +
    existingMarkdown.slice(section.end);

  return { type: 'replaced', markdown: nextMarkdown };
}
```

关键点：

- 不用全文覆盖。
- 只替换 `inkloop:begin/end` 之间的内容。
- 如果 controlled section 被用户改过，不直接覆盖。
- 用户在 section 外的任何内容保留。

### 5.10 首次导出流程

```text
1. Adapter 收到 KO。
2. 校验 schema_version。
3. 检查 privacy：local_only 直接跳过。
4. 检查 status：只导出 export_ready / accepted / edited。
5. 查询 ExternalBinding：ko_id 是否已有 binding。
6. 无 binding：扫描 InkLoop 目录，查是否已有 frontmatter.inkloop_id = ko_id。
7. 仍无：生成目标路径。
8. 渲染 Markdown。
9. 原子写入文件。
10. 写 ExternalBinding。
11. 写 SyncEvent file.created / binding.created。
```

### 5.11 重复导出流程

```text
1. 查询 binding by ko_id + target_id。
2. 如果 ko_content_hash 相同：skip_unchanged。
3. 如果 hash 不同：读取 remote_path。
4. 如果文件存在且 frontmatter.inkloop_id = ko_id：尝试替换 controlled section。
5. 替换成功：更新 frontmatter 与 binding。
6. 如果 controlled section 被改：生成 ConflictRecord。
7. 根据 policy：append_new_version 或 ask_user。
```

### 5.12 文件被用户重命名 / 移动

```text
1. binding.remote_path 找不到。
2. 扫描 <Vault>/InkLoop/**/*.md。
3. 解析 frontmatter.inkloop_id。
4. 找到唯一匹配：更新 binding.remote_path，然后继续 update。
5. 找到多个匹配：duplicate_remote_files 冲突。
6. 找不到：remote_file_missing。
7. 默认策略：create_new_file，并把旧 binding 状态标记 remote_missing。
```

### 5.13 文件被用户删除

v1 默认不删除远端，也不恢复旧文件，处理：

```text
remote_path 不存在
  ↓
scan by inkloop_id
  ↓
找不到
  ↓
ConflictRecord(remote_file_missing)
  ↓
按 policy 创建新文件或提示用户
```

默认：创建新文件，并记录事件：

```text
file.recreated_after_missing
```

### 5.14 文件里 frontmatter 被删

如果 binding 指向的路径存在，但 frontmatter 缺失 `inkloop_id`：

```text
1. 不覆盖该文件。
2. 标记 frontmatter_identity_missing。
3. 默认新建一个文件。
4. 旧路径保留给用户。
```

原因：没有身份字段时，继续写可能误伤用户笔记。

### 5.15 文件里 frontmatter 的 inkloop_id 不匹配

```text
binding.ko_id = ko_A
file.frontmatter.inkloop_id = ko_B
```

处理：

```text
1. 立即停止写入。
2. ConflictRecord(frontmatter_identity_mismatch)。
3. scan 当前 Vault 查找 ko_A。
4. 找到唯一文件则 relink。
5. 找不到则 create_new_file。
```

### 5.16 controlled section 被用户改

判断方式：

```text
hash(current controlled section body) !== binding.render_body_hash
```

默认策略：`append_new_version`。

文件变成：

```md
<!-- inkloop:begin ko=... hash=old -->
用户改过的旧区块
<!-- inkloop:end ko=... -->

<!-- inkloop:conflict ko=... detected=2026-06-26T... reason=controlled_section_modified -->
InkLoop detected that the controlled section was edited in Obsidian.
A new version was appended below instead of overwriting your edits.
<!-- inkloop:conflict-end ko=... -->

<!-- inkloop:begin ko=... hash=new -->
新版本
<!-- inkloop:end ko=... -->
```

但为避免一个文件里出现多个 active controlled section，要求更稳的做法：

```text
旧 section 改名为 inkloop:user-edited-snapshot
新 section 使用正式 inkloop:begin/end
```

示例：

```md
<!-- inkloop:snapshot-begin ko=... original_hash=old detected=... -->
用户改过的旧内容
<!-- inkloop:snapshot-end ko=... -->

<!-- inkloop:begin ko=... hash=new mapping=inkloop.obsidian.mapping.v1 -->
新内容
<!-- inkloop:end ko=... -->
```

### 5.17 Source Note 设计

每个文档创建一个 Source Note，便于 Obsidian 内 backlink：

路径：

```text
InkLoop/Sources/<safe_document_title> - <document_id>.md
```

内容：

```md
---
inkloop_document_id: doc_3f9a1c2b7e04
document_title: 量子力学导论
inkloop_uri: inkloop://doc/doc_3f9a1c2b7e04
created: 2026-06-26T06:32:07.829Z
updated: 2026-06-26T06:32:07.829Z
tags:
  - inkloop
  - inkloop/source
---

# 量子力学导论

Open in InkLoop: [inkloop://doc/doc_3f9a1c2b7e04](inkloop://doc/doc_3f9a1c2b7e04)

## Notes exported from InkLoop

<!-- InkLoop may append links here in v1.1. v1 can leave this section empty. -->
```

v1 可只创建 Source Note，不维护 note 列表，减少复杂度。Obsidian 自己的 backlinks 已经能从 KO note 指回 Source Note。

### 5.18 Obsidian URI 生成

用于导出后打开文件：

```ts
function buildObsidianOpenUri(input: {
  vault?: string;
  file?: string;
  absolutePath?: string;
  headingOrBlock?: string;
}): string {
  const params = new URLSearchParams();
  if (input.absolutePath) params.set('path', input.absolutePath);
  else {
    if (input.vault) params.set('vault', input.vault);
    if (input.file) params.set('file', input.headingOrBlock ? `${input.file}#${input.headingOrBlock}` : input.file);
  }
  return `obsidian://open?${params.toString()}`;
}
```

注意：

- URI 参数必须 encode。
- FS Adapter 不依赖 URI 完成写入，只用 URI 打开文件。
- 不用 `obsidian://new` 作为可靠写入路径，因为它缺少我们需要的幂等、hash、binding 与冲突检测。

### 5.19 写文件的原子性

FS v1 写入采用 per-target 串行队列，避免并发写同一个 Vault：

```ts
const queue = new PQueue({ concurrency: 1 });
```

写入流程：

```ts
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.inkloop.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
}
```

Windows 下如果 rename 覆盖失败，降级：

```text
1. 写 tmp
2. 读原文件备份到 .inkloop.bak
3. unlink 原文件
4. rename tmp
5. 失败则尝试恢复 bak
```

### 5.20 Metadata Pull v1

v1 只 pull 这些字段：

- `inkloop_status`
- `tags`
- `completed`，仅 task
- `remote_path`

不 pull：

- `body_md`
- `quote`
- `object_refs`
- `anchor_bbox`
- `inkloop_uri`
- controlled section 正文

Metadata pull 算法：

```text
1. 遍历 active bindings。
2. 如果 remote_path 不存在，scan by inkloop_id。
3. 读取 frontmatter。
4. inkloop_status 如果属于允许枚举，则回传给 InkLoop 或记录 pending metadata update。
5. tags 与 KO tags 做 merge。
6. task KO 读取 completed: true/false。
7. 更新 binding.last_seen_remote_at。
```

回写到 InkLoop 的 API：

```http
POST /api/v1/knowledge/objects/:ko_id/metadata
```

请求：

```json
{
  "provider": "obsidian_fs",
  "target_id": "target_...",
  "remote_path": "InkLoop/Notes/2026-06-26 AI Note - ...md",
  "metadata": {
    "status": "archived",
    "tags": ["inkloop", "inkloop/ai-note", "research"],
    "completed": true
  }
}
```

InkLoop 端可先不把这些 metadata 写回 Tier 2，只存在 `knowledge_object_metadata_overrides` 表。

---

## 6. Obsidian Plugin Adapter v1.5 设计

### 6.1 为什么需要插件

FS v1 能快速验证，但有天然限制：

- 无法可靠感知用户在 Obsidian 内重命名文件。
- 无法可靠感知删除、移动、修改事件。
- 在移动端无法直接使用 Node 文件系统。
- 无法融入 Obsidian 命令面板、设置页、状态栏。
- 无法利用 Obsidian 的 Vault API 和 frontmatter API。

Plugin v1.5 的目标是增强可靠性，不改变 KO 契约。

### 6.2 插件架构

```text
obsidian-inkloop-plugin/
  manifest.json
  package.json
  src/
    main.ts
    settings.ts
    inkloop-client.ts
    ko-schema.ts
    renderer/
      render-knowledge-object.ts
      controlled-section.ts
    vault/
      vault-writer.ts
      frontmatter.ts
      indexer.ts
      path-policy.ts
    sync/
      sync-service.ts
      binding-store.ts
      conflict-store.ts
    ui/
      setting-tab.ts
      export-modal.ts
      conflict-modal.ts
      status-bar.ts
```

### 6.3 插件与 InkLoop 的通信

v1.5 选定两种模式：

#### 模式 A：本地 HTTP bridge

InkLoop 桌面端启动本地服务：

```text
127.0.0.1:<port>
```

插件通过 pairing token 调用：

```http
GET /api/v1/knowledge/objects?status=export_ready
Authorization: Bearer <pairing_token>
```

优点：

- 不需要用户手动导出 JSON。
- 插件可主动 pull。
- 后续能做“从 Obsidian 打开 InkLoop”。

风险：

- 需要本地服务生命周期管理。
- token 存储要谨慎。
- CORS/本地端口被占用要处理。

#### 模式 B：JSON outbox

InkLoop 导出：

```text
<Vault>/InkLoop/.inbox/knowledge-objects-<export_id>.json
```

插件扫描 `.inbox` 并导入。

优点：

- 简单、稳定、不依赖本地端口。
- 适合调试和离线。

缺点：

- 体验不如自动同步。
- 需要文件投喂。

v1.5 要求两者都支持：HTTP 为主，JSON outbox 为 fallback。

### 6.4 Plugin 写入策略

插件内不要直接用 Node `fs` 写 Vault 文件；应优先使用 Obsidian Vault API。写已有文件时用 `Vault.process()`，避免 read/modify 之间文件被外部修改导致覆盖。frontmatter 更新使用 `FileManager.processFrontMatter()`。

伪代码：

```ts
async function updateNote(file: TFile, rendered: RenderedMarkdown): Promise<void> {
  await this.app.vault.process(file, (current) => {
    const result = replaceControlledSection({
      existingMarkdown: current,
      koId: rendered.ko_id,
      oldRenderBodyHash: rendered.old_render_body_hash,
      newSection: rendered.controlled_section,
    });

    if (result.type !== 'replaced') {
      throw new ControlledSectionConflict(result.type);
    }

    return result.markdown;
  });

  await this.app.fileManager.processFrontMatter(file, (fm) => {
    fm.inkloop_id = rendered.ko_id;
    fm.inkloop_content_hash = rendered.ko_content_hash;
    fm.inkloop_render_body_hash = rendered.render_body_hash;
    fm.inkloop_status = rendered.status;
  });
}
```

### 6.5 事件监听

插件监听 Vault 事件：

```ts
this.registerEvent(this.app.vault.on('rename', this.onRename));
this.registerEvent(this.app.vault.on('delete', this.onDelete));
this.registerEvent(this.app.vault.on('modify', this.onModify));
this.registerEvent(this.app.vault.on('create', this.onCreate));
```

处理逻辑：

| 事件 | 处理 |
|---|---|
| rename | 读取 frontmatter.inkloop_id，更新 binding.remote_path |
| delete | binding 标记 `remote_missing` |
| modify | debounce 后检查 controlled section hash，若改变则 `remote_changed` |
| create | 如果含 inkloop_id，尝试 relink 或标记 duplicate |

### 6.6 插件移动端兼容

如果希望插件支持移动端：

- 不在 top-level import `fs/path/electron`。
- 网络请求用 Obsidian 选定的 request API。
- 不把 `Vault.adapter` 强转为 FileSystemAdapter。
- 路径用 `normalizePath()`。
- 插件数据用 `loadData()` / `saveData()`。

v1.5 可先 desktop-only；如果 desktop-only，manifest 设置：

```json
{
  "isDesktopOnly": true
}
```

后续移动端再单独解除。

### 6.7 插件设置项

```ts
interface InkLoopPluginSettings {
  connection_mode: 'local_http' | 'json_outbox';
  inkloop_base_url?: string;
  pairing_token?: string;

  base_dir: string; // default InkLoop
  auto_sync: boolean;
  sync_interval_seconds: number;

  conflict_strategy: 'append_new_version' | 'ask_user';
  open_after_export: boolean;
}
```

### 6.8 插件命令

- `InkLoop: Connect to InkLoop`
- `InkLoop: Import pending KnowledgeObjects`
- `InkLoop: Export selected pending notes`
- `InkLoop: Open current note in InkLoop`
- `InkLoop: Scan vault for InkLoop notes`
- `InkLoop: Resolve conflicts`

---

## 7. API 设计

### 7.1 P0 JSON handoff

为了协作方不依赖 InkLoop 跑起来，先定义 JSON export envelope：

```ts
export interface KnowledgeObjectExportEnvelope {
  schema_version: 'inkloop.knowledge_export.v1';
  export_id: string;
  generated_at: string;
  source: {
    app: 'inkloop';
    app_version?: string;
    document_id?: string;
  };
  objects: KnowledgeObject[];
}
```

文件例子：

```text
.inkloop/outbox/knowledge-objects-20260626T063207Z.json
```

CLI：

```bash
pnpm inkloop-adapter export-obsidian \
  --input fixtures/knowledge-objects.json \
  --vault ~/Documents/MyVault \
  --base-dir InkLoop \
  --dry-run
```

### 7.2 InkLoop 内部 API

#### List KnowledgeObjects

```http
GET /api/v1/knowledge/objects?status=export_ready,accepted,edited&privacy=export_allowed&document_id=doc_xxx
```

返回：

```json
{
  "schema_version": "inkloop.knowledge_list.v1",
  "objects": [],
  "next_cursor": null
}
```

#### Get KnowledgeObject

```http
GET /api/v1/knowledge/objects/:ko_id
```

#### Build / rebuild KnowledgeObjects

```http
POST /api/v1/knowledge/build
```

请求：

```json
{
  "document_id": "doc_3f9a1c2b7e04",
  "mark_ids": ["evt_9b2c"],
  "ai_turn_ids": ["ent_7a01"]
}
```

返回：

```json
{
  "objects": [],
  "skipped": [],
  "warnings": []
}
```

#### Update metadata from Adapter

```http
POST /api/v1/knowledge/objects/:ko_id/metadata
```

请求：

```json
{
  "provider": "obsidian_fs",
  "target_id": "target_01J...",
  "remote_path": "InkLoop/Notes/2026-06-26 AI Note - xxx.md",
  "metadata": {
    "status": "archived",
    "tags": ["inkloop", "research"]
  }
}
```

### 7.3 Adapter API

#### Preview export

```http
POST /api/v1/adapters/obsidian-fs/preview
```

请求：

```json
{
  "ko_ids": ["ko_01JZ7D5E7WJK4F5NTAT9QCJBW2"],
  "target": {
    "vault_root": "/Users/me/Documents/ObsidianVault",
    "base_dir": "InkLoop"
  }
}
```

返回：

```json
{
  "plan": {
    "plan_id": "plan_01J...",
    "summary": {
      "create_count": 1,
      "update_count": 0,
      "skip_count": 0,
      "conflict_count": 0
    },
    "items": [
      {
        "ko_id": "ko_01J...",
        "action": "create",
        "remote_path": "InkLoop/Notes/2026-06-26 AI Note - 量子力学导论 p14 - QCJBW2.md",
        "preview_markdown": "---\n..."
      }
    ]
  }
}
```

#### Run export

```http
POST /api/v1/adapters/obsidian-fs/export
```

返回：

```json
{
  "job_id": "job_01J...",
  "status": "queued"
}
```

#### Get job status

```http
GET /api/v1/adapters/jobs/:job_id
```

#### Resolve conflict

```http
POST /api/v1/adapters/conflicts/:conflict_id/resolve
```

请求：

```json
{
  "strategy": "append_new_version"
}
```

---

## 8. 存储设计

### 8.1 StoragePort

Adapter Core 不能绑死 SQLite / IndexedDB：

```ts
export interface AdapterStoragePort {
  getBinding(targetId: string, koId: string): Promise<ExternalBinding | null>;
  upsertBinding(binding: ExternalBinding): Promise<void>;
  listBindings(query: BindingQuery): Promise<ExternalBinding[]>;

  createSyncJob(job: SyncJob): Promise<void>;
  updateSyncJob(job: SyncJob): Promise<void>;
  getSyncJob(jobId: string): Promise<SyncJob | null>;

  appendSyncEvent(event: SyncEvent): Promise<void>;

  createConflict(conflict: ConflictRecord): Promise<void>;
  updateConflict(conflict: ConflictRecord): Promise<void>;
  listConflicts(query: ConflictQuery): Promise<ConflictRecord[]>;
}
```

### 8.2 SQLite DDL（桌面端选定）

```sql
CREATE TABLE IF NOT EXISTS adapter_targets (
  target_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_bindings (
  binding_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  target_id TEXT NOT NULL,
  ko_id TEXT NOT NULL,
  ko_content_hash TEXT NOT NULL,
  render_body_hash TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  remote_path TEXT NOT NULL,
  remote_url TEXT,
  remote_rev TEXT,
  mapping_version TEXT NOT NULL,
  sync_state TEXT NOT NULL,
  last_exported_at TEXT NOT NULL,
  last_seen_remote_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, target_id, ko_id)
);

CREATE INDEX IF NOT EXISTS idx_external_bindings_target
  ON external_bindings(provider, target_id);

CREATE INDEX IF NOT EXISTS idx_external_bindings_remote_path
  ON external_bindings(provider, target_id, remote_path);

CREATE TABLE IF NOT EXISTS sync_jobs (
  job_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  target_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  ko_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  plan_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT,
  binding_id TEXT,
  ko_id TEXT,
  provider TEXT NOT NULL,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_events_job ON sync_events(job_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_ko ON sync_events(ko_id);

CREATE TABLE IF NOT EXISTS conflicts (
  conflict_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  target_id TEXT NOT NULL,
  ko_id TEXT NOT NULL,
  binding_id TEXT,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  remote_path TEXT,
  local_content_hash TEXT,
  remote_render_body_hash TEXT,
  resolution_status TEXT NOT NULL,
  resolution_strategy TEXT,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conflicts_status
  ON conflicts(provider, target_id, resolution_status);
```

### 8.3 IndexedDB 版本

如果继续在 Web demo 内跑，Adapter storage 可使用 Dexie：

```ts
class AdapterDb extends Dexie {
  targets!: Table<AdapterTargetRecord, string>;
  bindings!: Table<ExternalBinding, string>;
  jobs!: Table<SyncJob, string>;
  events!: Table<SyncEvent, string>;
  conflicts!: Table<ConflictRecord, string>;

  constructor() {
    super('inkloop_adapters');
    this.version(1).stores({
      targets: 'target_id, provider',
      bindings: 'binding_id, [provider+target_id+ko_id], [provider+target_id+remote_path]',
      jobs: 'job_id, provider, target_id, status',
      events: 'event_id, job_id, ko_id, provider, created_at',
      conflicts: 'conflict_id, [provider+target_id+resolution_status], ko_id',
    });
  }
}
```

---

## 9. 技术选型

### 9.1 总体选型表

| 模块 | 选型 | 原因 | 备注 |
|---|---|---|---|
| 主要语言 | TypeScript strict | 与现有 Vite + TS 一致，便于共享 schema | 全包开启 `strict: true` |
| Monorepo | pnpm workspace | 包管理快，适合多 package | 可与现有 npm 迁移并行 |
| Schema 校验 | Zod | runtime 校验 + TS 类型推导 | 用 `zod-to-json-schema` 可导出 JSON Schema |
| ID | ulid | 契约指定 `ko_ + ULID`，可排序 | 使用 monotonic ULID 可降低同毫秒冲突 |
| Hash | Web Crypto / Node crypto 封装 | 浏览器与 Node 都能跑 | 统一 `sha256Hex()` |
| Canonical JSON | 自研轻量或 `json-canonicalize` | 保证 hash 稳定 | 必须有测试快照 |
| Markdown 渲染 | 自研模板 | KO body 已是 Markdown，无需复杂 AST | v1 不引入 heavy renderer |
| YAML frontmatter | `yaml` 包 | 比手写字符串稳 | Obsidian plugin 内用 FileManager API |
| FS 写入 | Node `fs.promises` / Tauri fs plugin | v1 写本地 Vault | 需要 atomic write 和队列 |
| Adapter storage | SQLite（桌面）/ IndexedDB（Web） | 桌面适合 SQLite，Web 继续 IDB | 通过 StoragePort 隔离 |
| 队列 | `p-queue` | 简单可靠 | 每个 Vault concurrency=1 |
| 测试 | Vitest | TS 包单测 | snapshot + temp vault 集成测试 |
| E2E | Playwright | 后续测 UI | v1 可先不强制 |
| CLI | cac / commander | 方便 fixtures 先行 | `inkloop-adapter export-obsidian` |
| 桌面壳 | Tauri v2 选定 | 文件系统权限、体积小、适合生产 | 如要最快开发，Electron 也可临时用 |
| Obsidian 插件 | 官方 Obsidian API | Vault API / processFrontMatter | v1.5 |

### 9.2 为什么选择 Zod

需求：

- Adapter 必须拒绝不合法 KO。
- fixtures 可直接跑校验。
- API 入参要 runtime 校验。
- TypeScript 类型要从 schema 推导。

Zod 的优势是开发速度快。缺点是 schema 体积比 TypeBox 稍大，但这里不是性能瓶颈。

### 9.3 为什么 v1 不引入 AST Markdown renderer

我们不需要做 Markdown 到 Markdown 的复杂语义改写。v1 的写入策略是：

```text
frontmatter + heading + controlled section + user free area
```

这适合模板字符串。引入 mdast/remark 会让包变重、调试复杂。等未来需要合并复杂文档结构，再引入 AST。

### 9.4 桌面壳：Tauri vs Electron

| 维度 | Tauri | Electron |
|---|---|---|
| 文件系统 | Rust command 或 plugin-fs | Node fs 直接可用 |
| 包体积 | 小 | 大 |
| 内存 | 低 | 高 |
| 前端复用 | 高 | 高 |
| 开发速度 | 中 | 快 |
| 生产气质 | 更适合长期 | 更适合快速集成 |

要求：

- **P0：先做 Node CLI。** 不依赖桌面壳，协作方今天可用 fixtures 开发。
- **P1：桌面产品采用 Tauri v2。** Adapter FS 写入通过 Tauri command 或 plugin-fs 封装为 `FileSystemPort`。
- **如果工程团队 Electron 更熟，允许用 Electron 做内部 alpha。** 但不要把 Electron 选型和 Adapter Core 绑死。

### 9.5 Obsidian Plugin 技术原则

插件阶段遵循：

- 优先 Vault API，不直接使用底层 Adapter API。
- 后台修改文件用 `Vault.process()`。
- frontmatter 用 `FileManager.processFrontMatter()`。
- 移动端不在 top-level import Node 模块。
- 插件网络请求使用 Obsidian 选定 request API。
- 使用 `Plugin.loadData()` / `Plugin.saveData()` 保存插件配置。
- 所有用户路径用 `normalizePath()`。

---

## 10. 开发任务拆解

### Sprint 0：契约冻结与工程脚手架

目标：把口径固化成代码包，协作方能跑 fixtures。

任务：

- [ ] 建 pnpm workspace。
- [ ] 建 `packages/ko-schema`。
- [ ] 写 KnowledgeObject Zod schema。
- [ ] 加入对齐文档中的 Fixture A / Fixture B。
- [ ] 写 `validate-fixtures` 命令。
- [ ] 写 canonicalJson / sha256 工具。
- [ ] 明确 `content_hash` 测试快照。
- [ ] 写 `inkloop://` URI builder。

验收：

```bash
pnpm test packages/ko-schema
pnpm validate:fixtures
```

必须通过：

- Fixture A/B schema valid。
- `content_hash` 重复计算一致。
- 改 `body_md` 后 hash 改变。
- 改字段顺序 hash 不变。

### Sprint 1：Adapter Core + Markdown Renderer

目标：不连接真实 InkLoop，只用 fixtures 生成 Markdown 预览。

任务：

- [ ] 建 `packages/adapter-core`。
- [ ] 定义 Manifest / ExportPlan / Binding / SyncJob / Conflict。
- [ ] 建 `packages/adapter-markdown`。
- [ ] 实现 frontmatter renderer。
- [ ] 实现 callout renderer。
- [ ] 实现 controlled section renderer。
- [ ] 实现 file name sanitizer。
- [ ] 实现 source note renderer。
- [ ] 加 snapshot tests。

验收：

```bash
pnpm test packages/adapter-markdown
```

必须通过：

- Fixture A 渲染为 `[!note]`。
- Fixture B 渲染为 `[!quote]`。
- frontmatter 包含 `inkloop_id / content_hash / uri / tags`。
- 文件名不含非法字符。

### Sprint 2：Obsidian FS Adapter CLI

目标：fixtures → 本地临时 Vault → Markdown 文件。

任务：

- [ ] 建 `packages/adapter-obsidian-fs`。
- [ ] Vault validator。
- [ ] Path policy。
- [ ] Atomic writer。
- [ ] Frontmatter parser。
- [ ] Controlled section parser。
- [ ] ExternalBinding SQLite/JSON storage。
- [ ] CLI：`export-obsidian`。
- [ ] Dry-run preview。
- [ ] Temp vault integration tests。

验收命令：

```bash
pnpm inkloop-adapter export-obsidian \
  --input packages/ko-schema/fixtures/knowledge-objects.json \
  --vault /tmp/InkLoopTestVault \
  --dry-run

pnpm inkloop-adapter export-obsidian \
  --input packages/ko-schema/fixtures/knowledge-objects.json \
  --vault /tmp/InkLoopTestVault
```

必须通过：

- 生成正确目录结构。
- 首次导出 create。
- 第二次导出 skip_unchanged。
- 修改 fixture body 后 update 同一文件。
- 用户自由区内容保留。

### Sprint 3：KnowledgeBuilder 最小版

目标：真实 InkLoop 数据 → KO。

任务：

- [ ] 建 `packages/knowledge-builder`。
- [ ] 接入现有 docs / marks / ai_turns store。
- [ ] 建 `knowledge_identity_index`。
- [ ] 实现 `ko_id` 稳定生成。
- [ ] 实现 kind 推断。
- [ ] 实现 status 映射。
- [ ] 实现 source 构建。
- [ ] 实现 tags/privacy/callout 默认值。
- [ ] 实现 content_hash。
- [ ] 输出 KO JSON envelope。

验收：

- 导入 PDF，圈一段文字，只生成 `excerpt` KO。
- 圈文字后 AI 旁注，生成 `ai_note` 或 `qa` KO。
- dismissed 不进入默认 export list。
- 同一个 mark/ai_turn 重建后 ko_id 不变。
- KO schema valid。

### Sprint 4：InkLoop UI 集成

目标：用户在 InkLoop 里能看到待导出 KO 并导出到 Obsidian。

任务：

- [ ] 设置页增加 Obsidian 目标路径配置。
- [ ] 增加“导出到 Obsidian”按钮。
- [ ] 增加 export preview modal。
- [ ] 展示 create/update/skip/conflict。
- [ ] 接入 Adapter job 状态。
- [ ] 导出成功后可打开 Obsidian URI。
- [ ] 导出成功后 KO status 可设为 `exported` 或保留原状态。

验收：

- 用户可选择 Vault 路径。
- 点击预览能看到将创建/更新的文件。
- 点击导出后 Obsidian Vault 出现 Markdown。
- 再次点击不重复创建。
- 出错能看到明确错误。

### Sprint 5：冲突与 metadata pull

目标：覆盖真实用户会做的破坏性操作。

任务：

- [ ] controlled section modified 检测。
- [ ] missing section 检测。
- [ ] frontmatter missing 检测。
- [ ] identity mismatch 检测。
- [ ] remote file missing 检测。
- [ ] duplicate remote files 检测。
- [ ] conflict UI。
- [ ] metadata pull：status/tags/task_done。

验收：

- 用户改自由区，不冲突，导出保留。
- 用户改 controlled section，产生 conflict，不覆盖。
- 用户重命名文件，重新导出能 relink。
- 用户删除文件，重新导出创建新文件并记录事件。
- 用户修改 `inkloop_status: archived`，InkLoop 看到 metadata override。

### Sprint 6：Obsidian Plugin Spike

目标：验证插件通信和 Vault API 写入可行性。

任务：

- [ ] 建插件 repo。
- [ ] manifest / settings。
- [ ] JSON outbox import。
- [ ] Vault writer。
- [ ] processFrontMatter。
- [ ] rename/delete/modify 监听。
- [ ] local HTTP pairing spike。

验收：

- 插件能从 JSON 导入 KO。
- 插件能创建/更新 note。
- 重命名后 binding 更新。
- 删除后 binding remote_missing。
- controlled section 改动能被识别。

---

## 11. 测试计划

### 11.1 Unit Tests

| 测试对象 | 用例 |
|---|---|
| KO schema | Fixture A/B valid；缺字段 invalid；未知 kind invalid |
| canonicalJson | key 顺序不影响 hash；数组顺序影响 hash；undefined 被忽略 |
| URI builder | doc/page/ko/mark URI encode 正确 |
| kind inference | mark-only→excerpt；aiTurn→ai_note；question→qa |
| status map | shown→export_ready；folded→null |
| file name | 非法字符清理；长度限制；空 title fallback |
| frontmatter | YAML parse/stringify 保留必要字段 |
| controlled section parser | 找到 begin/end；重复 section 报错；缺失报错 |
| renderer | 快照测试，callout 正确 |

### 11.2 Integration Tests：Temp Vault

每个测试创建临时目录：

```text
/tmp/inkloop-vault-test-<id>/
  .obsidian/
```

用例：

1. 首次导出 fixture A → 创建 note。
2. 再次导出 fixture A → skip_unchanged。
3. 修改 body_md → update 同一文件。
4. 用户在 `## My notes` 下写内容 → update 后保留。
5. 用户改 controlled section → conflict。
6. 用户重命名文件 → scan by inkloop_id → relink。
7. 用户删除文件 → remote_missing → create_new_file。
8. 复制同一个文件两份 → duplicate_remote_files。
9. 删除 frontmatter → frontmatter_identity_missing。
10. 改 frontmatter.inkloop_id → frontmatter_identity_mismatch。

### 11.3 Contract Tests

协作方与 InkLoop 双方共享：

```text
fixtures/
  ai_note.json
  excerpt.json
  qa.json
  task.json
  summary.json
  invalid_missing_ko_id.json
  invalid_local_only.json
```

每次 CI 跑：

```bash
pnpm test:contract
```

### 11.4 Performance Tests

目标：

| 场景 | 目标 |
|---|---:|
| 100 KO dry-run preview | < 1s |
| 100 KO 首次写入 | < 5s |
| 1000 KO scan by inkloop_id | < 10s |
| 单 KO 更新 | < 200ms，不含磁盘偶发延迟 |
| controlled section parse | O(file size)，100KB note < 50ms |

v1 不追求百万 note；Obsidian Vault 本身也不适合把每个字符级对象投影成文件。

---

## 12. 隐私与安全

### 12.1 v1 默认不导出

- 原始 PDF。
- 原始笔迹 strokes。
- 页面截图。
- 裁图。
- 完整 OCR 页面文本。
- HMP 内部完整证据。
- InferenceView 完整上下文。

v1 只导出 KO 中已经显式包含的：

- 标题。
- AI note / excerpt 正文。
- quote。
- page index。
- object_refs。
- anchor_bbox。
- inkloop_uri。
- tags/status。

### 12.2 privacy gate

```ts
if (ko.privacy !== 'export_allowed') {
  return { action: 'skip_privacy' };
}
```

UI 中要显示：

```text
此对象 privacy=local_only，不会导出到 Obsidian。
```

### 12.3 导出预览

首次导出前必须有 preview：

- 将要写入哪个 Vault。
- 将创建/更新哪些文件。
- 每个文件包含哪些 quote / AI note。
- 是否有 skipped / conflict。

### 12.4 本地 HTTP bridge 安全

如果 v1.5 插件使用本地 HTTP：

- 只监听 `127.0.0.1`，不监听 `0.0.0.0`。
- 每个设备生成 pairing token。
- token 可撤销。
- API 只暴露 KO，不暴露原始 PDF / strokes。
- 请求记录 audit log。

---

## 13. 错误码

```ts
export type AdapterErrorCode =
 | 'KO_SCHEMA_INVALID'
 | 'KO_PRIVACY_BLOCKED'
 | 'KO_STATUS_NOT_EXPORTABLE'
 | 'VAULT_NOT_FOUND'
 | 'VAULT_NOT_WRITABLE'
 | 'FILE_WRITE_FAILED'
 | 'FILE_READ_FAILED'
 | 'FRONTMATTER_PARSE_FAILED'
 | 'CONTROLLED_SECTION_MISSING'
 | 'CONTROLLED_SECTION_MODIFIED'
 | 'REMOTE_FILE_MISSING'
 | 'DUPLICATE_REMOTE_FILES'
 | 'IDENTITY_MISMATCH'
 | 'UNKNOWN';
```

用户可读错误示例：

| code | 用户提示 |
|---|---|
| `VAULT_NOT_WRITABLE` | 当前 Obsidian Vault 无法写入，请检查文件夹权限。 |
| `KO_PRIVACY_BLOCKED` | 该笔记被标记为 local_only，不会导出。 |
| `CONTROLLED_SECTION_MODIFIED` | Obsidian 中的 InkLoop 区块已被修改，为避免覆盖，已进入冲突处理。 |
| `REMOTE_FILE_MISSING` | 之前导出的文件找不到了，可能被移动或删除。 |
| `DUPLICATE_REMOTE_FILES` | Vault 中发现多个相同 InkLoop ID 的文件，需要手动选择保留哪一个。 |

---

## 14. 最小验收闭环

### 14.1 用 fixtures 验收

```bash
pnpm install
pnpm test
pnpm validate:fixtures
pnpm inkloop-adapter export-obsidian \
  --input packages/ko-schema/fixtures/knowledge-objects.json \
  --vault /tmp/InkLoopVault
```

检查：

```text
/tmp/InkLoopVault/InkLoop/Sources/...
/tmp/InkLoopVault/InkLoop/Notes/...
```

### 14.2 用真实 InkLoop 验收

1. 导入一个 PDF。
2. 圈一段文本。
3. 让 AI 生成旁注。
4. 打开“导出到 Obsidian”。
5. 预览中看到一个 `ai_note` 和/或 `excerpt`。
6. 选择 Vault。
7. 导出。
8. 打开 Obsidian，看到 Markdown note。
9. 再点导出，不重复创建。
10. 在 Obsidian note 里 `## My notes` 写一句话。
11. 回 InkLoop 再导出，用户写的内容仍在。
12. 修改 controlled section，回 InkLoop 再导出，产生冲突而非覆盖。

---

## 15. 研发分工

### InkLoop 侧

- KO schema 确认。
- KnowledgeBuilder。
- ko_id 稳定映射。
- content_hash。
- inkloop:// URI。
- KO JSON / API 输出。
- Export UI。
- metadata override 接收。

### 协作方 / Adapter 侧

- Adapter Core。
- Markdown renderer。
- Obsidian FS Adapter。
- ExternalBinding / SyncJob / Conflict storage。
- CLI。
- Temp vault tests。
- Obsidian Plugin v1.5。

### 共同维护

- fixtures。
- contract tests。
- KO schema version。
- mapping version。
- 冲突策略。
- 用户文案。

---

## 16. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| KO 字段频繁变化 | Adapter 返工 | v1 字段冻结；新增字段走 optional minor |
| ko_id 不稳定 | 重复导出文件 | provenance_key→ko_id 映射表 |
| content_hash 不稳定 | 误判更新/冲突 | canonicalJson + 快照测试 |
| 用户改 controlled section | 覆盖用户内容 | hash 检测 + append_new_version |
| 用户移动文件 | binding 失效 | scan frontmatter.inkloop_id relink |
| 用户复制文件 | 多个 remote | duplicate conflict，不自动写 |
| Vault 权限问题 | 导出失败 | preflight 校验 |
| Web 端无法写本地文件 | 阻塞 Obsidian FS | v1 CLI/桌面端；Web 只导出 JSON/ZIP |
| 插件移动端差异 | v1.5 拖慢 | 插件后置；desktop-only spike |
| 过早做双向同步 | 复杂度爆炸 | v1 仅 metadata pull |

---

## 17. 最终目录结构

```text
inkloop/
  apps/
    web/
    desktop/
    paper/

  packages/
    ko-schema/
    knowledge-builder/
    adapter-core/
    adapter-markdown/
    adapter-obsidian-fs/
    adapter-cli/

  plugins/
    obsidian-inkloop/

  fixtures/
    knowledge-objects/
      ai-note.json
      excerpt.json
      qa.json
      task.json
      invalid-missing-ko-id.json

  docs/
    architecture/
      ko-adapter-obsidian-dev-plan.md
    adr/
      0001-adapter-only-consumes-ko.md
      0002-obsidian-fs-before-plugin.md
      0003-inkloop-is-source-of-truth.md
```

---

## 18. ADR 正式版

### ADR-0001：Adapter 只消费 KnowledgeObject

决策：Adapter 只能读取 `KnowledgeObject`，不能读取 `Stroke / HMP / Mark / InferenceView`。

原因：

- 避免外部 App 与 InkLoop 内部实现耦合。
- 允许 InkLoop 改内部基岩/Tier2，不影响 Adapter。
- Notion/Obsidian/Markdown/Readwise 可共用同一契约。

后果：

- KnowledgeBuilder 必须承担翻译职责。
- KO schema 需要更稳定。

### ADR-0002：Obsidian FS v1 先于 Plugin

决策：v1 先做本地文件系统写入；Obsidian Plugin 放 v1.5。

原因：

- FS 能最快验证用户价值。
- fixtures 可直接开发。
- 插件会引入额外安装、移动端、API 细节和审核成本。

后果：

- v1 无法实时监听 rename/delete。
- 需要 scan by `inkloop_id` 修复 binding。

### ADR-0003：InkLoop 是内容真相源

决策：Obsidian 不反向覆盖 InkLoop 的正文、quote、坐标和对象引用。

原因：

- Obsidian 是 Markdown projection，不理解 InkLoop 锚点语义。
- 双向正文同步早期风险极高。
- 用户笔记应该保留在自由区，而不是成为 InkLoop 内部事实。

后果：

- v1 pull 仅限 metadata。
- 用户改 controlled section 时进入 conflict。

---

## 19. 首周执行清单

第一周要求只做这 10 件事：

1. 冻结 `KnowledgeObject v1` TypeScript + Zod。
2. 把对齐文档中的 Fixture A/B 放入 repo。
3. 跑通 `validate:fixtures`。
4. 实现 canonicalJson + content_hash。
5. 实现 Markdown renderer 快照。
6. 实现 controlled section parser。
7. 实现 file name sanitizer。
8. 实现 Obsidian FS CLI dry-run。
9. 实现 temp vault 首次写入。
10. 实现第二次导出 skip_unchanged。

这一周完成后，团队就能看到一个真实闭环：

```text
Fixture KO → Adapter → Obsidian Markdown → 幂等重复导出
```

然后再接真实 InkLoop KnowledgeBuilder，不会互相阻塞。

---

## 20. 最终判断

本方案的关键不是“做 Obsidian 导出”，而是建立一层可长期复用的外部投影协议：

```text
KnowledgeObject = InkLoop 对外的知识对象契约
Adapter Core    = 所有外部 App 的统一投影框架
Obsidian FS     = 第一个最小可验证 Adapter
Plugin          = 第二阶段增强可靠性
```

只要守住三条线：

```text
Adapter 只吃 KO
InkLoop 是真相源
Obsidian 只更新受控区块，不碰用户自由区
```

这套架构就能既快落地，又不把后续 Notion、Readwise、Zotero、云同步全部锁死在早期临时代码里。
