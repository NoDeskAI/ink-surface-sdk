# InkLoop 前端标注链路 · 代码对接规格（CODEX-READABLE SPEC）

> **用途**：给工程同事 + 其 AI（codex/agent）对着代码做集成/改动用的密集事实层。不是叙事文档（那份在 `前端标注链路-技术文档.md/.html`）。
> **基线**：分支 `feat/xzq-hmp`，as-of commit `fd19606`（2026-06-22）。
> **怎么用**：每条事实带 `文件:行 · 符号`。**行号会随代码漂移——以符号名为准，`grep` 符号定位，行号只作 as-of 提示**。本文是薄薄一层盖在代码上的真相投影，代码变了从代码重投影，别把它当第二份真相。
> **状态图例**：`[done]` 已实现并跑通 · `[dev]` 仅 dev/云端形态 · `[stub]` 接缝在、实现空（恒返回空/未接）。

---

## 0. 术语锁定（撞名陷阱，先钉死）

| 术语 | 精确含义 | 不是 |
|---|---|---|
| **主推理调用** | 产旁注/答问的那一跳：`/api/chat`，**只在 `commitSessionDiscussion` 调一次** | 不是 interpret/ocr |
| **识别类调用** | 取证阶段轻调用：`/api/interpret`（手写vs画）、`/api/ocr-vlm`（局部OCR）、`/api/explain-image`；发生在 `captureMark`/`enrichHmp` | 不是主推理 |
| **`kind=mixed`**（识别层） | interpret 返回值：一团墨**又是字又是画** | ≠ 下行 |
| **`mode=mixed`**（取证层） | `HMP.mode`：既锚到正文、自身又是内容 | ≠ 上行 |
| **mark** | 一处连续画的若干 stroke 合成的一次手势（处理单位） | 不是单笔 stroke |
| **session** | 一本书自上次回复以来累积的 mark（可跨页，内存） | 不是对话历史 |
| **buffer** | 每本书一条对话滑窗 messages（`chat/buffer.ts`） | 不是 session |
| **markup / freeform** | markup=圈/划/箭头（有几何模板）；freeform=手写/画 | — |

---

## 1. 不变量（断言式——这些是有意设计，**不要当 bug "修掉"**）

1. **坐标永远归一化** `NormBBox=[x,y,w,h]∈[0,1]`。像素只在 `capture/ink.ts`（采集除画布）和 `surface/renderer.ts`/`anchor-layer.ts`（渲染乘回）两端出现。换算唯一入口 `core/transform.ts`。
2. **模型只引用对象 id，绝不生成坐标**。"标到哪个字"由几何命中算 `SurfaceObject.id`；"旁注贴哪"由前端把 id 解析回 bbox（`surface/anchor-layer.ts:19 resolveAnchorBBox`）。**任何让模型吐 bbox 的改动都是错的**。
3. **笔迹无损**（含 `pressure`）。下游判定都从 `stroke_points` 原始点序算。
4. **取证在落笔当时**（`captureMark`），随 mark 存死；`commitSessionDiscussion` 提交时**只读不重取**（提交时画布可能已翻页）。
5. **真相只在两件 append-only 账本**：`marks` + `ai_turns`（`local/store.ts`）。其余（session/mark-graph/InferenceView/overlays/buffer）全是 reload 现算的派生物，**不持久**。擦除=tombstone，改写=supersedes，**绝不 `put` 覆盖**。
6. **存料不存图**：`crop_ref`/`vector_ref` 落库前剥成 `undefined`（`main.ts` 落 mark 处 + `ai_turns` 存 inference_view 处）。marks/ai_turns 账本里没有图。
7. **markup 锚内容，freeform(self_content) 不锚正文**（`buildHmp`）。手写/画属 self_content，**不锚**到 bbox 碰巧蹭到的正文（否则模型幻觉）。
8. **markup 非终判**：见 §9 地雷①。

---

## 2. 数据契约（签名 as-of `fd19606`，全在 `src/core/contracts.ts` 除非另注）

```ts
// 坐标/单笔
type NormBBox = [number, number, number, number];        // contracts.ts:14  归一化 [x,y,w,h]
interface StrokePoint { x; y; t; pressure }               // contracts.ts:16  pressure 0–1 无损
type EventType = stroke|highlight|circle|underline|arrow|margin_note|tap_region|eraser|unknown  // :9
interface AnnotationEvent { event_id; trace_id; document_id; page_id; event_type; geometry.bbox; stroke_points; pointer_type } // :47  pointer_type: pen|touch|mouse|reader

// 契约分两批：SCHEMA_VERSION='0' 冻结(改须 bump+通知) · HMP_SCHEMA_VERSION='2' · INFERVIEW_SCHEMA_VERSION='1'
const SCHEMA_VERSION='0'        // :7   （冻结，勿轻动）
const HMP_SCHEMA_VERSION='2'    // :161
const INFERVIEW_SCHEMA_VERSION='1' // :231

// 页面对象表（字符级）
interface SurfaceObject { id; type; bbox; text?; role?; source }  // :177
//   id 形式：文本 `${run.id}_${charIndex}`(target.ts:67，run.id 形如 tl_3) · 图 `img_${pageIndex}_${i}`(target.ts:77)
//   type: title|text_block|image|chat_message|blank_region · source: structure|reflow|ocr|vlm(provenance)
interface SurfaceIndex { surface_id; surface_type; page_index; objects[] }  // :187，存 state.surfaceIndex（仅当前页）

// 取证记录 HMP（12 字段，contracts.ts:209）—— 只放事实+证据，无 AI 推断
interface HMP {
  hmp_id; surface_id; version;
  mode: 'anchored'|'self_content'|'mixed'|'unknown';                 // HmpMode :199
  action: MarkShape;  // enclosure|underline|cross|arrow|handwriting|sketch|highlight|unknown  :195
  target_region: NormBBox;            // 多笔 union bbox
  target_object_refs: string[];       // 命中的 SurfaceObject.id（markup 有值；self_content 空）
  object_hint: 'text'|'image_region'|'ui_region'|'blank'|'diagram'|'unknown';  // :202
  text_hint?: string;                 // OCR/识别异步补填
  crop_ref?: string; vector_ref?: string;  // dataURL，仅内存；落库前剥（不变量⑥）
  confidence: number;                 // 0–1，随 mode/来源
}

// 关系图
interface MarkNode { shape; feature_type; mode; object_hint; target_object_refs; text_hint; text; bbox; t }  // :243
interface MarkEdge { from; to; kind:'spatial'|'temporal'|'semantic'; rel; weight; quadrant?; direction? }    // :259
interface MarkGraph { surface_ids; nodes; edges }  // :270
interface PriorNeighbor { text; rel:'proximity'|'containment'|'same_row'; mark_id?; reply? }  // :282 空间召回产物，不进 graph.nodes

// 蒸馏载荷（采集↔推理合同面）
interface InferenceView {  // :290
  view_id; trigger:'idle'|'handwriting'; narrative; marked; page_context?; question?;
  crop?:{role:'ink'|'composite';data}; anchor_refs[]; anchor_bbox; page_id;
  recall?: PriorNeighbor[];
  referent_lines?;                    // 手写问题纵向压着的正文行
  page_annotations?: {marked;reply}[];// 本页其他批注+旧回应（动态背景）
  thematic?: {text;pageIndex;score;anchorRefs?}[];  // 全书主题召回 —— [stub] 现 no-op 恒空
  version;
}
interface ScreenOverlay { overlay_id; state; display_text; geometry.anchor_bbox; object_refs? }  // :131

// 持久格式（src/core/store-format.ts）
const STORE_VERSION='2'  // store-format.ts:17
const DB_VERSION=3       // store-format.ts:18  IDB: docs + pdf_blobs + marks + ai_turns
// PersistedMark / PersistedAiTurn 见 store-format.ts
```

---

## 3. 管线阶段（入口·in→out·状态）

| 阶段 | 入口 `文件:行 · 符号` | in → out | 状态 |
|---|---|---|---|
| 采集 | `capture/ink.ts · initInk` | 指针事件 → `Stroke`（笔/手分流·死区·归一化·getCoalescedEvents 无损） | [done] |
| 区域组装 | `main.ts:~190 initInk 回调` + `flushRegion` | stroke → mark（空间连贯并区；far-stroke 收口 / `REGION_QUIET_MS` 停笔收口；无时长上限） | [done] |
| 几何分类 | `capture/classify.ts · classifyScored`(模板) / `classifyStrokeFeature`(特征) | 点序 → `ScoredGesture` / `StrokeFeature{type,raw.ocrWorthy,raw.spanRatio,raw.strokeCount,raw.templateType}` | [done] |
| 识别定型 | `core/pipeline.ts:280 recognizeInk` → `/api/interpret` | 白底 ink 图 → `{kind,reading,description}`；映射 handwriting/drawing | [dev]（云端，端侧未落地） |
| 取证 | `evidence/target.ts:127 buildHmp` + `:48 wrapSurfaceIndex` + `:88 resolveTarget`（`focus.ts:11 pointInPolygon` 包围优先 + 相交兜底） | mark+index → `HMP` | [done] |
| 裁图/OCR兜底 | `evidence/ocr.ts:35 grabLayers`（ink 白底PNG无损 / composite JPEG q=0.78）；`enrichHmp`→`/api/ocr-vlm` 补 text_hint | bbox → 两图；失败静默 | [done]/[dev] |
| 落 mark | `main.ts` → `local/store.ts:188 appendMarkEntry`（剥 crop/vector） | mark → marks 账本 | [done] |
| 手写早提交 | `main.ts:166`（`feature.type==='handwriting'` → `commitSession(...,'handwriting')`） | — | [done] |
| 建图 | `evidence/mark-graph.ts:84 buildMarkGraph` + `:34 quadrantOf`（时空四象限） | marks+hmps → `MarkGraph`（spatial/temporal/semantic 三类边） | [done] |
| 空间召回 | `evidence/recall.ts:52 findSpatialRecall` | 账本 → `PriorNeighbor[]`（containment/proximity/same_row；严格页内；封顶 RECALL_K；失败 `[]`） | [done] |
| 主题召回 | `evidence/thematic.ts:15 findThematicRecall` → `local/vector.ts search` | query → `[]` | **[stub]** no-op 恒空 |
| 蒸馏 | `evidence/inference-view.ts:65 projectInferenceView` | MarkGraph → `InferenceView`（丢坐标/stroke/分数） | [done] |
| 上下文分类 | `core/pipeline.ts:541 classifyContext` → `/api/classify-context` | view+history → `{respond,reason}`；**仅手写轮**；fold→`return false` 不落 overlay、mark 留 session | [dev] |
| 主推理 | `core/pipeline.ts:464 commitSessionDiscussion` → `chat/stream-client.ts chatTurn` → `/api/chat` | view → 流式旁注 → `anchor:place` 落屏 | [dev] |
| 落 ai_turn | `local/store.ts:194 appendAiTurnEntry` + `:239 setSynthesisWatermark` | turn → ai_turns 账本（剥 crop） | [done] |
| 读取/回屏 | `surface/anchor-layer.ts:19 resolveAnchorBBox`(原版页) · `surface/reader.ts charToBlock`(重排页) | object_refs → bbox → px | [done] |
| reload 重建 | `main.ts:362 restoreFromLedger` | 账本 → strokes+overlays+buffer(最近3轮 `:402 slice(-3)`)+pending session | [done] |

---

## 4. AI 端点册（注册在 `vite.config.ts` middleware，handler 在 `server/infer.ts`）

| 端点 | 注册 `vite.config.ts:` | handler | role | 流式 | req → resp |
|---|---|---|---|---|---|
| `/api/chat` | 70 | `chatStream` | annotator | NDJSON `{k:'t'\|'r',d}` | `{messages,role,model,maxTokens}` → 流(t=正文/r=思考) |
| `/api/interpret` | 64 | `runInterpret` | ink_classifier | 否 | `{image,model?}` → `{kind:handwriting\|sketch\|mixed\|none, reading, description}` |
| `/api/classify-context` | 65 | `runClassifyContext` | context_classifier | 否 | `{question,view_narrative,marked,conversation,model}` → `{respond:bool, reason}` |
| `/api/ocr-vlm` | 62 | `runOcrVlm` | ocr | 否 | `{image,scope?,bbox?,model?}` → `{text}` |
| `/api/explain-image` | 63 | `runExplainImage` | image_explain | 否 | `{image}` → `{text}` |
| `/api/reflow-ai-stream` | 43 | (stream) | reflow_structure | NDJSON | 重排分组流 |
| `/api/reflow · -ai · -vlm` | 40/41/66 | `runReflow*` | reflow_* | 否 | 重排精修/结构/看图 |
| `/api/__debug/event` | 30 | `debugEvent` | — | — | dev 遥测落 `.dev-telemetry.jsonl` |

- 提示词在 `server/prompts.ts`：`PROMPT_VERSION='v3'`(:14)、`SYSTEM_PROMPTS: Record<PromptRole,string>`(:26)。客户端只传 `role`，不传 system。
- annotator 审计标签 `PROMPT_TAG='annotator@v3'`（`pipeline.ts:27`，与 PROMPT_VERSION 人工对齐）。
- interpret 的 kind 枚举原文：`prompts.ts:50`。**v3 给 annotator 加了 `<background>` 段**（prompts.ts:30）。

## 5. 模型路由 + 网关（`server/infer.ts`）

- 网关：NoDesk passthrough，`LLM_GATEWAY_URL`（默认 `infer.ts:22`），Bearer key 在 `.env`（`LLM_GATEWAY_KEY`，勿打印）。
- **按 model 前缀路由渠道**（`infer.ts:29`）：`kimi*` → moonshot(`api.moonshot.cn/anthropic/v1/messages`)；其余(`claude*`/`gemini*`) → DMX(`dmxapi.cn/v1/messages`)。
- 思考：`claude*`/`kimi*` 请求 thinking（budget 1024/minTokens 1280，`infer.ts:42`），经网关回 `k:'r'` 帧；`gemini*` 不回、不请求。
- 模型来源：`settings.inferModel`（chat + interpret/ocr/classify 同源）/ `settings.reflowModel`（重排，`REFLOW_MODEL`）。env `LLM_MODEL` 未设兜底 `kimi-k2.6`（`infer.ts:24`）。
- ⚠️ 实跑模型可能 ≠ 期望（遥测见释义轮被降级）——见 §9 地雷⑦。

---

## 6. 常量单一真源（改这些去这一处，别在别处复述）

| 常量 | 值 | `文件:行` |
|---|---|---|
| `DEADZONE_PX` | 1.3 px | `capture/ink.ts:13` |
| `SWIPE_MIN_PX` | 60 px | `capture/ink.ts:16` |
| `PX_PER_MM` | 96/25.4 ≈3.78 | `capture/classify.ts:17` |
| `REGION_QUIET_MS` | 6000 | `main.ts:41` |
| `REGION_NEAR` | 0.06 | `main.ts:42` |
| `ASSEMBLY_WINDOW` | 1200 | `capture/session.ts:16` |
| `BURST_GAP_MS` | 12000 | `capture/session.ts:18` |
| `IDLE_COMMIT_MS` | 90000 | `capture/session.ts:20` |
| `SPATIAL_NEAR` | 0.12 | `evidence/mark-graph.ts:20` |
| `NEAR_TIME_MS` | 30000 | `evidence/mark-graph.ts:31` |
| `ROW_BAND` | 0.03 | `evidence/recall.ts:27` |
| `ROW_REACH` | 0.5 | `evidence/recall.ts:28` |
| `RECALL_K` | 3 | `evidence/recall.ts:20` |
| `MAX_TURNS` | 6（=最近3轮） | `chat/buffer.ts:10` |
| composite JPEG q | 0.78 | `evidence/ocr.ts:35 grabLayers` |

---

## 7. 实现状态矩阵（impl/stub + 锚）

| 模块 | 状态 | 锚 |
|---|---|---|
| 采集/分类/取证/建图/召回/蒸馏/持久 主干 | `[done]` | 见 §3 |
| 识别 `/api/interpret`（手写vs画） | `[dev]` 云端 | `pipeline.ts:280` · 端侧替换见 §8 |
| 主推理 `/api/chat`、classify-context | `[dev]` 云端网关 | `infer.ts` · `vite.config.ts` dev-only 代理 |
| 主题召回 thematic | **[stub]** no-op 恒空 | `thematic.ts:15` 包 `vector.ts:25 search()→[]` |
| 本地向量库 VectorStore | **[stub]** | `vector.ts:18-25`（upsert TODO / search `[]`） |
| 冷路径 S1–S7 编排 | **[stub]** | `agent/index.ts:24 runScenario`→`P5 stub` |
| 对外 MCP 边 | **[stub]** | `mcp/index.ts:13 pushTo` / `:18 serveJudgmentMcp` |
| 语义颜色/立场、Judgment Brief、导出、companion、跨设备同步 | **未建** | 产品路线，不在本仓现状 |

---

## 8. 扩展接缝（集成/对接从这里下手）

- **端侧识别替换（B 组）**：把 `pipeline.ts:280 recognizeInk`→`/api/interpret` 换成端侧分类器，**保持返回形状 `{kind,reading,description}`**，`kind∈{handwriting,sketch,mixed,none}`。传输层（浏览器→bridge / 系统服务）藏契约后即可，下游不动。`captureMark` 调用点此刻 `event.stroke_points` 仍在内存 ⟹ **stroke-native 可无架构改动接通**（不必只喂图）。
- **本地向量库**：实现 `local/vector.ts VectorStore.upsert/search`（选型 sqlite-vec/DuckDB/本地 embedding）。**铁律：本地直连，绝不 MCP 化**。实现后 `thematic.ts` 自动点亮（已包好）、`InferenceView.thematic` 自动有值。灌料 = 每条 HMP 的 `marked_text` + `target_object_refs`。
- **冷路径 S1–S7**：`agent/index.ts runScenario`（确定性 pipeline，非自主 agent，后台异步）。
- **对外 MCP**：`mcp/index.ts`——`serveJudgmentMcp`(把判断库包成 MCP server，阶段二) / `pushTo`(推 Notion/Linear/Todo)。**MCP 只在外部集成这条缝，内部模型/库/向量全本地直连**。
- 派生代码须**容忍混版本**（账本 append-only/reload 现算）；`recognition?` 之类加成可选、bump 版本号只作信号。

---

## 9. 地雷 / 反直觉（"看着像 bug，其实是有意的"——动之前先读）

1. **markup 非终判**：几何判成 `circle` 的圈，若 `markupLooksLikeDrawing`（`pipeline.ts:299`）判定它**没真圈住任何非空白内容**（`pointInPolygon` 真·圈内）**且 `strokeCount≥2`**，会**推翻 markup、改送 `/api/interpret`** 重新定型（治"哭脸被当圈漏判画"）。别假设 markup=终点。
2. **freeform 不锚正文**：手写/画是 `self_content`，`target_object_refs=[]`，**故意不锚** bbox 蹭到的正文（不变量⑦）。别"修"成锚上去。
3. **`same_row` 只属空间召回**（`recall.ts`），**不是 mark-graph 边**。图内空间边只有 `containment/proximity/same_target`（`mark-graph.ts`）。别把 same_row 加进 graph。
4. **`kind=mixed`（interpret）≠ `mode=mixed`（HMP）**。见 §0。mixed 识别结果：仍按 `handwriting` 定型但 `hasDrawing=true`，**转写和画描述两者都留**，原图照送推理（`pipeline.ts` recognize 映射处）。
5. **手写提交 ≠ 必回**：`main.ts:166` 立即触发提交，但 `commitSessionDiscussion` 里 `classifyContext`（`pipeline.ts:541`）判 respond/fold；**fold→`return false`，session 不清、留作下次综合**（`commitSession` `committed` 才清，`main.ts:170`）。
6. **thematic/vector 恒空**：`thematic.ts`/`vector.ts:25` 是 stub。**别对着它的返回值接逻辑**，现在永远 `[]`。
7. **实跑模型可能被降级**：`settings.inferModel` 默认期望与遥测实跑可能不符（释义轮被 routing 降到轻模型）。改模型行为前先看遥测，别只看默认值。
8. **`appendMarkEntry` 未 await**（`main.ts` 落 mark 处 `void appendMarkEntry(...)`），随后手写可能立刻 commit ⟹ 写库异步失败时 `ai_turns` 可能引用未落库 mark（弱一致）。做导出/sync 前要把失败显式化或重试。
9. **`settings_snapshot` 缺 `reflowModel`**（`pipeline.ts:566`/`:734` 只存 `{inferModel,reflowProvider}`），而 `page_context` 的 key 用 `settings.reflowModel`（`pipeline.ts:445`）⟹ 严格复现"AI 重排影响的 page_context"会缺字段。
10. **存料不存图**：marks/ai_turns 账本里 `crop_ref/vector_ref` 已剥（不变量⑥）。别期望从账本读到图；图只在本会话内存（`state.lastHmps`）。
11. **命中→原文解析仅当前页**：`state.surfaceIndex` 只有当前页对象表；非当前页的 mark 只能显条数，无法重解析命中文字。
12. **dev/build 坑**：AI 端点是 `vite.config.ts` **dev-only** 代理（非生产边界）；改 `server/*` 需重启 dev；pdfjs CMap/字体走 postinstall 拷入 `public/cmaps`,`public/standard_fonts`（gitignore，不入库）。

---

## 10. 文件地图（grep 起点）

```
capture/ink.ts          指针·笔手分流·死区·归一化·翻页
capture/session.ts      Mark/Session 累积·时间常量
capture/classify.ts     几何模板 + 特征型 + ocrWorthy 门
main.ts                 区域组装·收口时序·idle/手写触发·restoreFromLedger
core/pipeline.ts        captureMark(取证) · commitSessionDiscussion(提交) · recognizeInk · markupLooksLikeDrawing
core/contracts.ts       全局类型（本规格 §2 之源）
core/store-format.ts    持久格式 · DB/STORE_VERSION
core/transform.ts       normToPx/pxToNorm（像素↔归一化唯一入口）
evidence/target.ts      SurfaceIndex(字符级) · resolveTarget · buildHmp
evidence/focus.ts       pointInPolygon · pageText · linesInBand
evidence/ocr.ts         grabLayers(裁图) · enrichHmp(OCR兜底)
evidence/mark-graph.ts  buildMarkGraph · quadrantOf(四象限)
evidence/recall.ts      findSpatialRecall(same_row 行带)
evidence/inference-view.ts  projectInferenceView(蒸馏)
evidence/thematic.ts    findThematicRecall —— [stub]
chat/buffer.ts          每书对话薄缓存(MAX_TURNS=6)
chat/stream-client.ts   chatTurn(流式主模型)
chat/classify-client.ts classifyContext(respond/fold)
core/api.ts             postJson/postNdjson(HTTP 信封)
server/infer.ts         端点 handler + 网关 + 路由
server/prompts.ts       role 索引提示词(PROMPT_VERSION='v3')
surface/renderer.ts     PDF 渲染·抽文本层·建 index
surface/reflow.ts / reflow-provider.ts   重排 + sourceRunIds 跨视图桥
surface/reader.ts       重排面 + reader:gesture → resolveRegion + charToBlock
surface/anchor-layer.ts resolveAnchorBBox(ref→bbox→px)
local/store.ts          四件 SSoT 账本 + 折叠 + 水位线
local/vector.ts         VectorStore —— [stub]
agent/index.ts          S1–S7 冷路径 —— [stub]
mcp/index.ts            对外 MCP 边 —— [stub]
vite.config.ts          dev-only API 代理（端点注册）
```
