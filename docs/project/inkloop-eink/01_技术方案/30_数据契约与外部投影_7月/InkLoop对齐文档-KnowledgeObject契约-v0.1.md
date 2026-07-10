# InkLoop ↔ 协作方（适配器）· 对齐文档（KnowledgeObject 契约 v0.1）

> 日期：2026-06-26 · 状态：**正式版，待双方冻结**
> 读者：协作方（适配器）+ InkLoop 内部
> 配套：数据架构总纲、基岩 schema、对方的《Core Schema & Adapter 技术方案 v1.0》

---

## 0. 这份文档是什么 / 怎么用

这是一份**契约**，不是"已完成系统的说明书"。**InkLoop 这边的 KnowledgeBuilder / ko_id / content_hash / inkloop:// URI 目前都还没建**——这很正常，契约的作用就是让两边**并行建、最后天然对齐**。

**协作方今天就能开工**：照着 §2 冻结的 KnowledgeObject schema + §6 的 fixtures（样例 JSON）开发适配器，用 fixtures 当 mock 数据，**完全不依赖 InkLoop 跑起来**。等我们交付真 KO 时，形状一致即可对接。

**唯一的金线（来自对方方案 D2，我们完全认同）**：**适配器只吃 KnowledgeObject。** 永远不碰 Stroke / HMP / Mark / InferenceView / 基岩。

---

## 1. 边界与归属

| 层 | 归属 | 现状 |
|---|---|---|
| 基岩（Tier 1 原始运动）+ marks/ai_turns/HMP/InferenceView（Tier 2，原样） | **InkLoop** | Tier 2 已有；基岩在建 |
| **KnowledgeBuilder**（marks+ai_turns → KnowledgeObject）+ ko_id/content_hash/inkloop:// URI | **InkLoop** | 🔨 待建 |
| **冻结接口** = KnowledgeObject + inkloop:// URI + 锚点裁图访问 + privacy | **共同冻结** | 本文 §2–§5 |
| KnowledgeObject → Adapter 框架 → Obsidian（FS v1 / 插件 v1.5）+ ExternalBinding/Sync/冲突 | **协作方** | 待建 |

**双方共同约定的三条边界**（协作前提，非单向要求）：
1. **接口边界 = KnowledgeObject。** 适配器只消费 KO，不碰 Stroke/HMP/Mark/InferenceView/基岩。对方方案 §5.1–5.10 的 Core Schema 写得很好、作为理解 InkLoop 的参考极有价值；双方约定**各自保留内部实现**——InkLoop 这边不迁就那套理想化字段名（与现有代码不一致），协作方也不必照它重建；真相由 InkLoop 的 KnowledgeBuilder 翻译成 KO 交付。
2. **基础设施按需、不绑死彼此进度。** LedgerEvent 事件溯源这类我们暂不做；InkLoop 供给 KO + `content_hash` + URI，ExternalBinding/SyncJob/冲突账本由协作方持有。哪边要补什么基础设施，各自按需，不强制对方跟进。
3. **fixtures 先行、并行开工。** 协作方拿 §6 fixtures 即可开发，不阻塞在 InkLoop 进度上；InkLoop 并行建 KnowledgeBuilder。两边在 KnowledgeObject 这个面上汇合。

---

## 2. 冻结接口：KnowledgeObject schema（v1）

采用对方 §5.11 的形态，**裁剪到 v1 我们确实能产出的字段**。版本号 `inkloop.knowledge_object.v1`。

```ts
type ISODateTime = string;
type Sha256 = `sha256:${string}`;
type NormBBox = [number, number, number, number]; // 归一化[0,1]

type KnowledgeKind = 'source_document' | 'excerpt' | 'annotation' | 'ai_note' | 'qa' | 'summary' | 'task' | 'decision' | 'risk' | 'question' | 'concept';
type KnowledgeStatus = 'inbox' | 'accepted' | 'edited' | 'dismissed' | 'export_ready' | 'exported' | 'archived';
type Privacy = 'local_only' | 'export_allowed';   // v1 只用这两档（团队/云后置）

type KnowledgeSourceRef =
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

interface KnowledgeObject {
  schema_version: 'inkloop.knowledge_object.v1';
  ko_id: string;                  // 'ko_'+ULID，InkLoop 生成，跨端稳定身份
  kind: KnowledgeKind;
  title: string;
  body_md: string;                // 渲染进受控区块的正文

  source: {
    document_id: string;
    document_title: string;
    page_id?: string;             // 'pg_{hash8}_{idx}'
    page_index?: number;          // 0-based
    object_refs: string[];        // 命中页面对象 id（字符级，如 'run3_12'）；可空
    anchor_bbox?: NormBBox;
    quote?: string;               // 被标注的原文
    inkloop_uri: string;          // 见 §4
  };

  source_refs?: KnowledgeSourceRef[]; // 组合证据：文档锚点 + 会议标记 + 项目记忆

  provenance: {
    created_from: 'mark' | 'ai_turn' | 'session' | 'meeting_mark' | 'postprocess' | 'manual';
    mark_ids?: string[];          // = 我们的 event_id
    ai_turn_ids?: string[];
    meeting_id?: string;
    meeting_mark_ids?: string[];
    postprocess_result_id?: string;
  };

  tags: string[];                 // 默认含 'inkloop' + 'inkloop/<kind>'
  status: KnowledgeStatus;
  privacy: Privacy;

  render_hints?: {
    markdown_callout?: 'note' | 'quote' | 'question' | 'todo' | 'summary' | 'tip' | 'warning' | 'success';
  };

  content_hash: Sha256;           // canonicalJson(KO 去掉本字段) 的 sha256；判重导出
  created_at: ISODateTime;
  updated_at: ISODateTime;
}
```

**v1 暂不放（对方方案里有、但我们还没有，故不进契约，避免空头承诺）**：`relations`（无关系图）、`export_hints`（用默认）、`workspace_id/owner_user_id`（单用户，先省）、`provenance` 里的 `session_id/inference_view_id/hmp_ids`（可后补）。会议场景的组合证据不放进这些内部字段，统一进入 `source_refs`。需要时按 minor 版本号追加，不破坏 v1。

---

## 3. 字段来源映射 + 就绪状态

每个 KO 字段从我们真实数据怎么来。**✅=现成可取 · 🔨=我们要建（都很轻）· ⏳=待定**。

| KO 字段 | 来源（InkLoop 真实数据） | 就绪 |
|---|---|---|
| `ko_id` | InkLoop 生成 | 🔨 生成器 |
| `kind` | 按 mark.feature_type + 有无 ai_turn 推（对方 §6.4 规则） | 🔨 KnowledgeBuilder |
| `title` | `docs.filename` + 页码（"… · p12"） | ✅ |
| `body_md` | ai_note=`ai_turns.ai_reply`；excerpt=`marks.marked_text` | ✅ |
| `source.document_id` | `marks.document_id` | ✅ |
| `source.document_title` | `docs.filename`（暂用文件名当标题） | ✅ |
| `source.page_id / page_index` | `marks.page_id / page_index` | ✅ |
| `source.object_refs` | `HMP.target_object_refs` | ✅ |
| `source.anchor_bbox` | `marks.bbox` / `HMP.anchor` | ✅ |
| `source.quote` | `marks.marked_text` | ✅ |
| `source.inkloop_uri` | 由 doc_id/page/object_id 拼（§4） | 🔨 URI 拼装 |
| `source_refs` | `PostProcessResult.source_refs`，包含 document / meeting_mark / project_memory | 🔨 会议后处理接入 |
| `provenance.mark_ids` | `ai_turns.anchor.mark_ids` / `marks.mark_id`(=event_id) | ✅ |
| `provenance.ai_turn_ids` | `ai_turns.entry_id` | ✅ |
| `provenance.meeting_id / meeting_mark_ids / postprocess_result_id` | 会议事件 schema 合约 | 🔨 会议后处理接入 |
| `tags` | 默认 `['inkloop','inkloop/<kind>']`（无用户 tag 体系） | 🔨 默认 |
| `status` | 由 `ai_turns.overlay_state` 映射（shown→export_ready / accepted→accepted / dismissed→dismissed / folded→不导出） | 🔨 映射 |
| `privacy` | v1 默认 `export_allowed` | 🔨 默认 |
| `render_hints.markdown_callout` | 由 kind 默认（对方 §10.4 表） | 🔨 默认 |
| `content_hash` | `sha256(canonicalJson(ko))` | 🔨 计算 |
| `created_at/updated_at` | `ai_turns.created_at` / 现取 | ✅ |

**结论**：没有一个字段我们产不出。🔨 全是 KnowledgeBuilder 里的轻量逻辑，不需要改我们的 Tier 2 schema、更不碰基岩。

---

## 4. inkloop:// URI 约定（InkLoop 注册协议；协作方只读不拼）

```text
inkloop://doc/<document_id>
inkloop://doc/<document_id>/page/<page_index>?anchor=<object_id>
inkloop://ko/<ko_id>
inkloop://mark/<mark_id>
```

- 每个 KO 的 `source.inkloop_uri` 由 InkLoop 拼好放进去，**协作方原样写入 Markdown、不自己拼**。
- 适配器侧的 `obsidian://open?...` 回链按对方方案 §13.1，归协作方。

---

## 5. 资产 / 锚点裁图访问约定

- v1 默认**不导出**任何裁图/笔迹/PDF（对方 D9，隐私最小化）。
- 当 `render_hints` 将来允许锚点裁图时，InkLoop 通过 `AssetRef{asset_id, content_hash, uri}` 提供（对方 §5.1 AssetRef 形态），适配器按需取。**v1 不实现，先留口。**

---

## 6. Fixtures（协作方对着这个开发，无需 InkLoop 跑起来）

**Fixture A · ai_note**
```json
{
  "schema_version": "inkloop.knowledge_object.v1",
  "ko_id": "ko_01JZ7D5E7WJK4F5NTAT9QCJBW2",
  "kind": "ai_note",
  "title": "量子力学导论 · p14",
  "body_md": "量子纠缠已被贝尔不等式实验反复验证（如 2022 诺奖 Aspect 等）；它不传递信息，故不违反相对论。",
  "source": {
    "document_id": "doc_3f9a1c2b7e04",
    "document_title": "量子力学导论",
    "page_id": "pg_3f9a1c2b_13",
    "page_index": 13,
    "object_refs": ["run_p14_021_3", "run_p14_021_4", "run_p14_021_5", "run_p14_021_6"],
    "anchor_bbox": [0.31, 0.31, 0.12, 0.02],
    "quote": "量子纠缠",
    "inkloop_uri": "inkloop://doc/doc_3f9a1c2b7e04/page/13?anchor=run_p14_021_3"
  },
  "provenance": { "created_from": "ai_turn", "mark_ids": ["evt_9b2c"], "ai_turn_ids": ["ent_7a01"] },
  "tags": ["inkloop", "inkloop/ai-note"],
  "status": "export_ready",
  "privacy": "export_allowed",
  "render_hints": { "markdown_callout": "note" },
  "content_hash": "sha256:0000",
  "created_at": "2026-06-26T06:32:07.829Z",
  "updated_at": "2026-06-26T06:32:07.829Z"
}
```

**Fixture B · excerpt（无 AI，仅用户圈注原文）**
```json
{
  "schema_version": "inkloop.knowledge_object.v1",
  "ko_id": "ko_01JZ7DA9X4Q2M0K7P5N3RBYE10",
  "kind": "excerpt",
  "title": "量子力学导论 · p14",
  "body_md": "不确定性原理给出了位置与动量的测量精度下限。",
  "source": {
    "document_id": "doc_3f9a1c2b7e04",
    "document_title": "量子力学导论",
    "page_id": "pg_3f9a1c2b_13",
    "page_index": 13,
    "object_refs": ["run_p14_044_0"],
    "anchor_bbox": [0.18, 0.52, 0.46, 0.03],
    "quote": "不确定性原理给出了位置与动量的测量精度下限。",
    "inkloop_uri": "inkloop://doc/doc_3f9a1c2b7e04/page/13?anchor=run_p14_044_0"
  },
  "provenance": { "created_from": "mark", "mark_ids": ["evt_5d8f"] },
  "tags": ["inkloop", "inkloop/excerpt"],
  "status": "export_ready",
  "privacy": "export_allowed",
  "render_hints": { "markdown_callout": "quote" },
  "content_hash": "sha256:0000",
  "created_at": "2026-06-26T06:35:10.000Z",
  "updated_at": "2026-06-26T06:35:10.000Z"
}
```

> `content_hash` 在 fixtures 里用占位 `sha256:0000`；真实计算公式见 §3。

---

## 7. InkLoop 这边要建的清单（我们的交付）

全部属 KnowledgeBuilder + 周边，**不碰 Tier 2 schema、不碰基岩**：

- [ ] `ko_id` 生成（ULID）
- [ ] KnowledgeBuilder：marks+ai_turns 折叠成 KnowledgeObject（kind 推断按对方 §6.4）
- [ ] `content_hash`（canonicalJson + sha256）
- [ ] `status` 映射（overlay_state → KnowledgeStatus；folded 不导出）
- [ ] `inkloop://` 协议注册 + URI 拼装
- [ ] tags / privacy / callout 默认值
- [ ] 一个导出 KnowledgeObject 列表的接口（供适配器拉取，或导出成 JSON 文件给 FS 适配器）

交付节奏：与基岩**并行**，互不阻塞（两者分坐 Tier 2 两侧）。先交付能产出 §6 形态 KO 的最小 KnowledgeBuilder，协作方即可从 fixtures 切到真数据。

---

## 8. 待双方确认的开放项

1. **KnowledgeObject v1 字段集**（§2）是否就此冻结？协作方若发现缺字段，走 minor 版本追加、不破 v1。
2. **KO 投喂方式**：适配器主动拉取 InkLoop 接口，还是 InkLoop 导出 KO 列表 JSON 给 FS 适配器扫？（v1 倾向后者，最简）
3. **status / privacy 默认值**是否认可（§3）。
4. 对方方案 §5.1–5.10、§5.12 LedgerEvent 确认划为**适配器范围外**。
