# InkLoop 会议纪要后处理最佳实践方案 V2

> 文档状态：已落地基线
> 版本：V2.1
> 更新日期：2026-07-22
> 适用范围：InkLoop 会议场景后处理；访谈纳入会议场景统一处理；教育场景继续保留独立业务流程
>
> **V2.1 产品决策：完整报告已下线。** 当前只生成 `meeting.summary_cards` 与由同一份 Cards 确定性渲染的 `meeting.summary`。旧 `meeting.full_report` / `report_markdown` 仅用于历史读取兼容，不生成、不展示、不产生模型费用；旧生成 API 固定返回 HTTP `410 full_report_retired`。

---

## 1. 方案摘要

本方案将当前以 `meeting.panel_summary` 为中心的“超长报告优先”链路，改造为单一快速产物链：

1. **优先生成短摘要与结构化卡片**
   - 会议结束后由后台自动触发；
   - 复用并升级现有 `meeting.summary` 链路；
   - 通过持久化 SSE 将摘要增量文本和结构化卡片实时推送到设备；
   - 默认作为 recap、Panel、L1/Obsidian 导出的主要数据源。

同时做出以下架构调整：

- **会议和访谈统一**：访谈视为会议的一种沟通形态。普通会议和访谈共用同一套短纪要基础设施，由场景模板决定结构；不再使用独立的“用户访谈研究报告”长文主链。
- **会议与教育分离**：两者继续保持独立业务流程和业务 schema，但复用采集、转写、OCR、任务编排、分块、事件流、版本管理和可观测性基础设施。
- **OCR 是摘要预处理的必要环节**：用户手写是核心事实源之一，正常情况下必须在摘要生成前完成识别；通过会中增量 OCR、区域级处理和受控并发，使 OCR 尽量在会议结束前完成，避免成为会后长尾。
- **结束即持久化 Evidence，不等待 recap**：`meeting.ended` 立即触发 OCR 收尾、证据保存和转写收敛；正式 Postprocess Run 由“模板配置已提交 + formal/明确 partial 转写已收敛”双条件触发。recap 负责模板/用户引导配置、订阅、展示和重试入口。
- **不再生成巨大 JSON 和 Markdown**：模型只生成结构化 Cards，可读摘要由代码确定性渲染。
- **不再从头截断 48k 字符**：长会议采用完整覆盖的分块事实抽取与全局归并，优先保证会议后半段的结论、行动项和风险不丢失。

---

## 2. 最新产品决策

| 议题 | 最终决策 |
|---|---|
| 会议与访谈的关系 | 访谈属于会议，两者共用同一套会议后处理模板和 Prompt，不做独立业务链路 |
| 默认产物 | 只生成结构化卡片与可读短摘要 |
| 默认展示 | recap 首屏展示 `meeting.summary` 与结构化卡片 |
| 完整报告 | 已下线；旧 schema 只读兼容，旧 API 返回 `410 full_report_retired` |
| 触发方式 | 会议结束后后台自动保存 Evidence 并收敛转写；用户提交模板与可选引导后，双条件齐备自动生成 |
| OCR | OCR 是手写预处理的一部分，正常路径下需先完成，再生成短纪要 |
| OCR 性能策略 | 会中增量识别、局部识别、受控并发；会议结束时只处理少量尾部未完成笔迹 |
| 实时反馈 | 设备直接消费持久化 SSE，实时显示摘要增量文本和已完成卡片 |
| 事实源 | 原始发言单元、用户手写信息和必要的会议元数据；Provider 官方纪要仅作辅助或降级来源 |
| 旧产物 | `meeting.panel_summary` 转为兼容读取和历史数据迁移对象，不再作为默认新产物 |

### 2.1 Prompt 与模板的具体含义

会议和访谈共用 `meeting_brief_prompt_v2` 的事实约束、输出契约和调度链路；`template_id` 决定内容组织方式。模型只输出经过 schema 校验的结构化 Cards，`meeting.summary` 由 Cards 确定性渲染，不再维护完整报告 Prompt。

---

## 3. 目标与非目标

### 3.1 目标

1. 会议结束后无需用户操作即可开始 Evidence 收尾与转写收敛；正式生成前用户选择模板，并可选填当场结论、最深感受和关注痛点。
2. 用户先看到一屏可读、重点明确的短纪要。
3. 短摘要和卡片在生成过程中逐步可见，不再长时间停留在“正在生成”。
4. 手写内容在正常路径中完整参与摘要，而不是摘要完成后才补录。
5. 普通会议和访谈共享一套稳定的事实抽取逻辑。
6. 每场会议只产生一份 canonical Cards 与对应可读摘要，避免重复模型调用和重复内容。
7. 结果可追溯到原始发言或手写证据。
8. 同一份输入不会被重复生成；输入、Prompt 或 schema 变化时可以准确判断是否重算。
9. 会议与教育复用通用后处理能力，但不互相污染业务输出。

### 3.2 非目标

1. 本阶段不把会议和教育合并成同一套业务 Prompt。
2. 本阶段不要求使用开放式 Agent 框架。
3. 本阶段不要求替换所有 Provider 或重新实现整套语音识别。
4. 本阶段不要求设备直接解析模型产生的任意未闭合 JSON。
5. 本阶段不生成 32k token 完整文档，也不保留按需生成入口。

---

## 4. 目标产物模型

### 4.1 默认短纪要：`meeting.summary`

`meeting.summary` 继续作为兼容现有导出链路的短文本或 Markdown 结果，并升级为默认 recap 结果。

建议内容控制在一到两个电子纸屏幕内：

1. 会议主题；
2. 一句话结论；
3. 3–5 条核心要点；
4. 已确认的决策；
5. 行动项；
6. 突出事项与风险；
7. 待确认问题；
8. 用户自己的手写重点。

### 4.2 结构化卡片：`meeting.summary_cards`

短摘要旁边保存结构化数据，用于 UI、Panel、任务导出和后续自动化。

```ts
type MeetingSummaryCardsV2 = {
  schema_version: "2.0"
  artifact_state: "provisional" | "final" | "partial"

  theme: string
  overview: string

  key_points: Array<{
    id: string
    text: string
    evidence_refs: string[]
  }>

  decisions: Array<{
    id: string
    text: string
    status: "confirmed" | "tentative"
    evidence_refs: string[]
  }>

  action_items: Array<{
    id: string
    task: string
    owner: string | null
    due_at: string | null
    commitment: "explicit" | "proposed"
    evidence_refs: string[]
  }>

  highlights: Array<{
    id: string
    text: string
    evidence_refs: string[]
  }>

  risks: Array<{
    id: string
    text: string
    mitigation: string | null
    evidence_refs: string[]
  }>

  open_questions: Array<{
    id: string
    text: string
    evidence_refs: string[]
  }>

  personal_notes: Array<{
    id: string
    text: string
    kind: "thought" | "question" | "todo" | "emphasis"
    mark_refs: string[]
    supporting_utterance_refs: string[]
  }>

  coverage: {
    utterances: "complete" | "partial"
    handwriting_ocr: "complete" | "partial" | "failed"
    started_at_ms: number | null
    ended_at_ms: number | null
  }
}
```

### 4.3 历史完整报告兼容

`meeting.full_report` 与 `report_markdown` 只保留在读取 schema 中，以保证升级后仍能打开旧会议 store。当前行为是：

- scheduler 拒绝创建新的完整报告 run；
- 启动恢复时取消历史 queued/running/collecting run，并标记 `full_report_retired`；
- recap 与客户端 projection 忽略历史完整报告 artifact；
- `POST /api/meeting-postprocess/full-report` 固定返回 HTTP `410`；
- 兼容摘要 schema 会剥除模型意外返回的 `report_markdown` 等未知字段。

---

## 5. 总体架构

```text
会议进行中
  ├─ 持续采集原始发言单元 MeetingUtterance[]
  ├─ 持续采集手写 marks
  ├─ mark 停止书写 / 页面切换后增量 OCR
  └─ 持久化中间证据与处理状态

meeting.ended
  → 创建幂等 postprocess run
  → 冻结本轮 evidence snapshot
  → 检查原始发言覆盖情况
  → 等待并完成剩余手写 OCR
  → 预处理发言与手写
  → 生成短摘要与结构化卡片
      ├─ summary.text.delta
      ├─ summary.card.upsert
      └─ summary.completed
  → 写入 meeting.summary
  → 写入 meeting.summary_cards
  → 默认 recap 可用

Provider 最终工件随后到达
  → 比较 source revision / fingerprint
  → 只重算受影响分块
  → 必要时更新 provisional 版本为 final
```

### 5.1 关键原则

- **业务触发与 UI 解耦**：页面打开不触发业务，只订阅业务状态。
- **只生成用户当前需要的结果**：Cards 是 canonical 模型产物，可读摘要是其确定性投影。
- **一个事实生命周期**：同一 Evidence Snapshot 只触发一条 Cards 生成链，避免重复推理与内容漂移。
- **事实只抽取一次**：结构化卡片完成后，短文本由代码渲染；不要让模型用不同格式重复写同一事实。
- **流式可见、最终一致**：用户先看到增量内容，最终以持久化 artifact 为准。

---

## 6. 触发与任务编排

### 6.1 唯一主触发器

```text
meeting.ended
```

会议结束事件应由会议状态机或 Provider 结束事件触发，而不是由以下行为触发：

- 打开 recap；
- 打开 Panel；
- 用户点击“生成总结”；
- 页面重新加载。

手动按钮只保留为：

- 失败重试；
- 强制重新生成；
- 使用新 Prompt 或新模板生成新版本。

### 6.2 幂等键

建议：

```text
idempotency_key = meeting_id + source_snapshot_id + pipeline_version
```

同一个幂等键只能创建一个有效 run，避免 recap 多次打开、Provider 重复 webhook 或设备重连造成重复生成。

### 6.3 状态机

```text
CREATED
  → COLLECTING_EVIDENCE
  → WAITING_FOR_HANDWRITING_OCR
  → PREPROCESSING
  → SUMMARY_GENERATING
  → SUMMARY_READY
  → COMPLETED
```

异常状态：

```text
PARTIAL
FAILED_RETRYABLE
FAILED_FINAL
STALE
CANCELLED
```

`SUMMARY_READY` 是产品上的成功点；摘要 artifact 持久化并发布完成事件后进入 `COMPLETED`。

---

## 7. 输入证据与预处理

### 7.1 原始发言单元

后处理的主输入不再是拼接后的 SRT 字符串，而是结构化发言单元：

```ts
type MeetingUtterance = {
  utterance_id: string
  start_ms: number
  end_ms: number
  speaker_id: string | null
  speaker_name: string | null
  text: string
  source: "google" | "zoom" | "feishu" | "local"
  source_revision: string
  confidence?: number
}
```

这里的“原始发言”指 Provider 或本地采集层给出的原始 speaker entry / utterance，而不是先转成 SRT、再压平成超长文本。

音频仍可作为最终审计证据；文本模型的计算输入使用结构化 utterance 中的文字、时间和说话人信息。

#### 7.1.1 清洗规则

- 合并重复或重叠的 Provider 片段；
- 统一说话人名称与匿名 ID；
- 删除纯噪声、无意义重复和技术提示；
- 保留否定、数字、日期、负责人、条件和不确定性；
- 不进行会改变事实含义的激进润色；
- 保留 `utterance_id`，保证摘要结果可回溯。

### 7.2 用户手写证据

```ts
type HandwritingEvidence = {
  mark_id: string
  page_id: string
  relative_time_ms: number | null
  text: string
  text_source: "manual" | "ocr"
  ocr_confidence?: number
  kind:
    | "fact"
    | "personal_thought"
    | "question"
    | "todo"
    | "hypothesis"
    | "emphasis"
}
```

重要规则：

- 用户手写默认是“用户自己的理解或思考”，不自动视为会议共同结论；
- 只有原始发言中存在明确支持时，才可以将手写内容提升为决策或共同事实；
- “可能”“待确认”“我觉得”等不确定表达必须保留；
- 用户手动修正文本的优先级高于 OCR 文本。

### 7.3 其他上下文

可以作为辅助输入：

- 会议标题；
- 会议开始和结束时间；
- 参会者；
- 日历描述与预设议程；
- 平台信息。

Provider 官方纪要不作为一级事实源。建议仅用于：

- 原始 utterance 暂时不可用时的降级；
- 质量对照；
- 遗漏检测。

不要把官方纪要与原始转写等权拼接后再次总结，否则容易放大上游模型的错误和重复表达。

---

## 8. OCR 策略：必要前置，但尽量提前完成

### 8.1 正常路径

短摘要生成前，需要完成本次会议相关手写的 OCR：

```text
remaining_handwriting_ocr == 0
  → start summary generation
```

这样可以避免先生成文字版、随后因为手写加入而大幅改写摘要。

### 8.2 避免 OCR 成为会后长尾

OCR 应从“会后整页串行任务”改成“会中增量预处理”：

- mark 停止编辑一段时间后触发局部 OCR；
- 页面切换或页面离开时提交当前页未识别区域；
- 只上传发生变化的 bbox，不重复识别整页；
- 多页采用受控并发，而不是完全串行；
- 每个 mark 保存 OCR 状态、版本和置信度；
- 同一 mark 内容未变化时直接复用缓存；
- 会议结束时只处理尾部尚未稳定的少量笔迹。

### 8.3 OCR 失败处理

不能再出现“等待 10 秒后返回空，用户稍后重新触发”的行为。

建议：

1. 单区域自动重试；
2. 单页失败不取消其他页面；
3. 达到硬性失败阈值后生成 `partial` 结果；
4. UI 明确显示“有 N 条手写未识别”；
5. 未识别部分完成后可做局部 patch；
6. 降级是异常恢复路径，不是正常产品路径。

---

## 9. 长会议处理：完整覆盖而非头部截断

禁止继续使用“只保留前 48k 字符”的策略。

### 9.1 短会议

完整输入一次完成结构化抽取。

### 9.2 长会议

采用分块事实抽取与全局归并：

```text
完整 utterances
  → 按议题变化、时间间隔和 token 上限切块
  → 并行抽取每块的：
       key points
       decisions
       action items
       highlights
       risks
       open questions
       evidence refs
  → 全局归并
       去重
       合并跨块事项
       区分提议与最终决定
       处理前后修正
       检查责任人与截止时间
  → 生成 MeetingSummaryCardsV2
  → 代码渲染 meeting.summary
```

### 9.3 分块缓存

```text
chunk_hash → extracted_facts
```

当 Provider 只修正会议最后几分钟时，只重算变化分块及最终归并，不重新处理整场会议。

---

## 10. 统一 Prompt 方案

### 10.1 短纪要 Prompt：`meeting_brief_prompt_v2`

会议和访谈共同使用，不根据“普通会议/访谈”切换模板。

#### 核心约束

1. 只基于输入证据，不补充外部事实；
2. 一条事实只表达一次；
3. 不把讨论、提议和假设误写成决定；
4. owner 和 due date 未明确时必须输出 `null`；
5. 用户手写想法与会议共同结论分开；
6. 默认短、直接、中文；
7. 每个重要结论带 `evidence_refs`；
8. 输出严格符合 schema；
9. 访谈中的问答自然归入核心要点、突出事项、风险或开放问题，不建立另一套访谈专用结构。

#### Prompt 骨架

```text
你是 InkLoop 的会议纪要后处理器。

输入包含：
1. 按时间排序的原始发言单元；
2. 用户在电子纸上的手写内容；
3. 基础会议元数据。

你的任务是提取一份精简、可信、可执行的会议纪要。

规则：
- 会议和访谈使用同一套处理规则；
- 不重复表达同一信息；
- 只有明确承诺才是行动项；
- 只有明确确认才是决定；
- 不得推测负责人或截止时间；
- 用户手写内容默认归入 personal_notes；
- 当发言能够明确支持手写内容时，才可同时进入其他栏目；
- 保留不确定性、分歧、条件和风险；
- 每个重要条目引用对应 utterance_id 或 mark_id；
- 严格输出指定 JSON schema。
```

### 10.2 输出边界

Prompt 只允许返回 Cards schema 中的字段。不得返回 `report_markdown`、完整报告章节或其他长文容器；即使模型意外返回，服务端 schema 也必须剥除。

---

## 11. 短摘要与结构化卡片的实时流

### 11.1 推荐采用混合流式协议

用户体验需要实时生成感，但结构化数据又必须稳定。建议同时提供两类事件：

1. **文本增量**：让用户立即看到短摘要正在形成；
2. **结构化卡片 upsert**：当一个卡片对象完整、校验通过后再推送。

```text
summary.text.delta
summary.card.upsert
```

不建议设备直接解析模型逐 token 输出的任意 JSON。

### 11.2 持久化 SSE

建议接口：

```http
GET /api/meetings/:meetingId/postprocess/events
Accept: text/event-stream
Last-Event-ID: 1042
```

事件先写数据库或持久化事件日志，再推送给在线设备。

```ts
type MeetingPostprocessEvent = {
  run_id: string
  seq: number
  event_type: string
  payload: unknown
  created_at: string
}
```

推荐事件：

```text
postprocess.started
postprocess.evidence.ready
ocr.progress
ocr.completed
summary.started
summary.text.delta
summary.card.upsert
summary.completed
postprocess.partial
postprocess.failed
```

### 11.3 SSE 可靠性要求

- `seq` 单调递增；
- 支持 `Last-Event-ID` 断线续传；
- 消费端按事件 ID 幂等应用；
- 至少一次投递，UI 不依赖“恰好一次”；
- 服务端重启后事件仍可恢复；
- 完成事件中包含最终 artifact 版本和读取地址；
- token delta 按小批次合并后持久化，避免一字符一条事件；
- 卡片只在 schema 校验通过后发布。

### 11.4 UI 展示节奏

```text
正在整理手写信息
→ 正在提取会议主题
→ 一句话摘要出现
→ 核心要点卡片逐条出现
→ 行动项、风险、待确认事项出现
→ 短纪要完成
```

用户不需要一直停留在 recap 页面；重新打开时从持久化 artifact 和事件游标恢复。

---

## 12. 单一产物生命周期

```text
evidence/configuration ready
  → generate meeting.summary_cards
  → validate and persist Cards
  → deterministically render meeting.summary
  → publish terminal artifact events
```

Cards 和可读摘要必须引用同一 Evidence Snapshot 与 fingerprint。摘要渲染不调用模型；Cards 失败时允许按既有 retry policy 重试，但不能启动其他长文生成任务。历史完整报告 run 在恢复时直接取消，不占用模型配额、队列或设备带宽。

---

## 13. 存储与版本管理

### 13.1 兼容字段

```text
meeting.summary          // 默认短 Markdown，继续服务现有导出
meeting.summary_cards    // 新增结构化卡片
meeting.full_report      // 历史只读兼容；不再生成或展示
meeting.panel_summary    // 历史兼容，只读或迁移
```

中长期建议统一进入 artifact 表：

```ts
type MeetingArtifact = {
  artifact_id: string
  meeting_id: string
  type: "summary" | "summary_cards" | "full_report" // full_report 仅兼容旧数据
  status: "generating" | "completed" | "partial" | "failed" | "stale"
  payload: unknown
  source_fingerprint: string
  schema_version: string
  prompt_version: string
  model_policy_version: string
  created_at: string
  updated_at: string
}
```

### 13.2 内容指纹

```ts
sha256(canonicalJson({
  utterance_revision,
  utterance_hash,
  handwriting_revision,
  handwriting_hash,
  meeting_metadata_revision,
  prompt_version,
  schema_version,
  pipeline_version,
  model_policy_version,
}))
```

规则：

- 指纹相同：直接复用；
- 只有渲染样式变化：代码重新渲染，不调用模型；
- 只有少量 utterance 或 mark 变化：重算受影响分块；
- Prompt/schema 变化：生成新 artifact 版本；
- 用户手动编辑作为独立 patch 保存，AI 重生成不直接覆盖用户修改。

---

## 14. 会议与教育的复用边界

会议和教育继续是两条业务流程，但应共享基础设施。

### 14.1 可以复用

| 能力 | 会议 | 教育 |
|---|---:|---:|
| 音频/发言采集 | 是 | 是 |
| Provider 工件发现 | 是 | 是 |
| Utterance 标准化 | 是 | 是 |
| 手写 mark 管理 | 是 | 是 |
| 增量 OCR | 是 | 是 |
| 长文本分块与缓存 | 是 | 是 |
| 工作流/队列 | 是 | 是 |
| 持久化 SSE | 是 | 是 |
| Artifact 存储与版本 | 是 | 是 |
| 内容指纹 | 是 | 是 |
| 可观测性与评测框架 | 是 | 是 |

### 14.2 不应复用

| 业务层 | 会议 | 教育 |
|---|---|---|
| 输出目标 | 决策、行动、风险、重点、待确认 | 知识点、概念、例子、疑问、复习任务 |
| Prompt | `meeting_*` | `education_*` |
| Schema | MeetingSummaryCards | EducationSummaryCards |
| 默认 UI | 会议 recap | 课程/学习 recap |
| 质量指标 | 行动项准确率、决策准确率 | 知识点覆盖、教学准确性、复习效果 |

推荐目录分层：

```text
postprocess/
  core/
    workflow/
    evidence/
    chunking/
    ocr/
    events/
    artifacts/
    observability/
  meeting/
    prompts/
    schemas/
    reducers/
    renderers/
  education/
    prompts/
    schemas/
    reducers/
    renderers/
```

---

## 15. 推荐服务端编排伪代码

```ts
async function onMeetingEnded(meetingId: string): Promise<void> {
  const run = await createIdempotentPostprocessRun(meetingId)
  await publish(run, "postprocess.started", {})

  const snapshot = await freezeEvidenceSnapshot(meetingId)

  const utterancesPromise = prepareUtterances(snapshot)
  const handwritingPromise = finishOutstandingHandwritingOcr(snapshot, {
    incrementalCache: true,
    controlledConcurrency: true,
  })

  const [utterances, handwriting] = await Promise.all([
    utterancesPromise,
    handwritingPromise,
  ])

  await publish(run, "postprocess.evidence.ready", {
    utteranceCount: utterances.length,
    handwritingCount: handwriting.length,
  })

  const preparedEvidence = await preprocessMeetingEvidence({
    meetingId,
    utterances,
    handwriting,
  })

  const cards = await generateMeetingBriefStream(preparedEvidence, {
    onTextDelta: async (delta) => {
      await persistAndPublish(run, "summary.text.delta", { delta })
    },
    onCard: async (card) => {
      await validateCard(card)
      await persistAndPublish(run, "summary.card.upsert", { card })
    },
  })

  const summaryMarkdown = renderMeetingSummary(cards)

  await saveMeetingSummary(meetingId, summaryMarkdown)
  await saveMeetingSummaryCards(meetingId, cards)
  await persistAndPublish(run, "summary.completed", {
    summaryArtifactVersion: cards.schema_version,
  })
}
```

---

## 16. 对现有代码的建议改动

### 16.1 `meeting-recap.ts`

当前职责调整为：

- 不再在 recap 打开时启动总结；
- 首先读取本地 `meeting.summary` 和 `meeting.summary_cards`；
- 订阅持久化 SSE；
- 根据事件更新摘要文本与卡片状态；
- 支持断线续传；
- 提供失败重试和强制重生成入口。

### 16.2 `infer.ts`

建议拆分：

- `generateMeetingBriefStream()`；
- 结构化卡片 schema 校验；
- 文本 delta 微批处理；
- 持久化事件发布；
- 不再累积 32k token 后一次返回巨大 JSON。

### 16.3 `prompts.ts`

移除默认“用户访谈研究报告”强制模板，只保留：

```text
meeting_brief_prompt_v2
```

会议和访谈共同使用该基础 Prompt 与各自场景模板。

### 16.4 `meeting-summary-handwriting.ts`

调整为通用手写证据装配模块：

- 读取已完成 OCR 的 marks；
- 分类为事实、思考、问题、todo、假设、强调；
- 保留 mark ID、页面与相对时间；
- 不再简单只按会前/会中/会后拼接 8000 字符；
- 为结构化结果提供 evidence refs。

### 16.5 `board-ocr.ts`

重点改造：

- 会中增量触发；
- bbox 级识别；
- 并发队列；
- mark 内容哈希与缓存；
- 单页独立失败与重试；
- 会议结束时提供 `awaitOutstandingOcr(meetingId)`；
- 不再以“仍有 OCR 未完成就返回空摘要”作为控制流。

### 16.6 新增建议模块

```text
server/meeting-postprocess-orchestrator.ts
server/meeting-postprocess-events.ts
server/meeting-artifacts.ts
server/meeting-evidence-preprocessor.ts
server/meeting-summary-reducer.ts
server/meeting-summary-renderer.ts
```

---

## 17. 迁移路径

### 阶段 A：切换默认产物与触发方式

1. 将现有 `meeting.summary` 改为 `meeting.ended` 自动触发；
2. recap 不再触发总结；
3. recap 默认展示 `meeting.summary`；
4. 停止自动生成新的 `meeting.panel_summary.report_markdown`；
5. 现有 L1/Obsidian 导出保持兼容。

### 阶段 B：加入结构化卡片与持久化 SSE

1. 增加 `meeting.summary_cards`；
2. 短纪要 Prompt 改为结构化输出；
3. 服务端增加事件日志；
4. 设备支持 `Last-Event-ID`；
5. 文本增量和卡片 upsert 实时显示。

### 阶段 C：OCR 前移与长会议完整覆盖

1. OCR 改为会中增量；
2. 多页受控并发；
3. 会议结束时等待剩余 OCR；
4. 移除 48k 头部截断；
5. 增加分块抽取、缓存和全局归并。

### 阶段 D：完整报告退役

1. 删除完整报告生成器、worker、调度通道和 UI；
2. legacy API 返回 `410 full_report_retired`；
3. 恢复时取消历史未完成 run，且不调用模型；
4. 保留旧 schema 的读取兼容，客户端不投影或展示；
5. 兼容摘要输出剥除 `report_markdown`。

### 阶段 E：清理旧链路

1. `meeting.panel_summary` 停止新写入；
2. 历史数据继续兼容读取；
3. 飞书 Panel 改为消费统一 artifact adapter；
4. 删除 recap 触发主链和巨大 JSON 解析逻辑；
5. 删除重复的手动总结 AI 链，只保留重试/重生成入口。

---

## 18. 验收标准

### 18.1 功能验收

- [ ] 会议结束后自动创建唯一后处理 run；
- [ ] 不打开 recap 也能生成短纪要；
- [ ] recap 不再触发新总结；
- [ ] OCR 正常完成后才开始短纪要生成；
- [ ] OCR 失败不会静默返回空结果；
- [ ] `meeting.summary` 成为默认结果；
- [ ] 结构化卡片逐项显示；
- [ ] 设备断线后能从上次事件 ID 恢复；
- [ ] 新会议不会创建完整报告任务或产生完整报告模型费用；
- [ ] 历史完整报告任务恢复后被取消，旧数据可读但不展示；
- [ ] 旧完整报告 API 返回 HTTP 410；
- [ ] 普通会议和访谈使用同一套 Prompt 和 schema；
- [ ] 长会议不再只保留前 48k 字符；
- [ ] 重要结论能够回溯到 utterance 或 mark。

### 18.2 质量验收

- [ ] 未明确负责人时不生成负责人；
- [ ] 未明确截止时间时不生成截止时间；
- [ ] 提议不会被误写成已确认决定；
- [ ] 用户个人手写想法不会被误写为全体共识；
- [ ] 会议末尾的行动项和结论不会因截断而遗漏；
- [ ] overview、key points、actions 和 risks 之间无明显重复；
- [ ] 访谈式问答可以被同一 schema 准确表达；
- [ ] 普通会议不会被强制写成用户研究报告。

---

## 19. 推荐监控指标

| 指标 | 目的 |
|---|---|
| `meeting_end_to_postprocess_start` | 检查自动触发是否及时 |
| `meeting_end_to_ocr_ready` | 衡量会中增量 OCR 是否有效 |
| `evidence_ready_to_first_delta` | 衡量用户首次可见反馈 |
| `evidence_ready_to_summary_ready` | 衡量短纪要真实处理耗时 |
| `sse_resume_success_rate` | 衡量设备断线恢复能力 |
| `duplicate_run_rate` | 检查幂等控制 |
| `summary_cache_hit_rate` | 衡量指纹复用效果 |
| `ocr_partial_rate` | 检查 OCR 异常比例 |
| `decision_false_positive_rate` | 检查决定误判 |
| `action_owner_hallucination_rate` | 检查负责人虚构 |
| `tail_content_coverage` | 检查会议后半段覆盖 |
| `summary_edit_rate` | 发现需要优化的字段 |

建议分别统计：

- Provider 工件等待时间；
- OCR 时间；
- 证据预处理时间；
- 短纪要模型时间；
- 持久化与推送时间。

不要再用一个总耗时掩盖具体瓶颈。

---

## 20. 风险与应对

### 20.1 OCR 被设为前置后重新成为关键路径

应对：

- 会中增量执行；
- bbox 级识别；
- 缓存；
- 受控并发；
- 会议结束只处理尾部增量；
- 明确失败降级，不无限等待。

### 20.2 会议和访谈共用 Prompt 后，某些访谈洞察变弱

应对：

- 保持统一 schema，不建立独立链路；
- 在同一 Prompt 中明确支持问答型沟通；
- 使用真实会议和访谈共同组成评测集；
- 通过 Prompt 版本迭代提升兼容性，而不是重新分叉业务链。

### 20.3 流式 JSON 不稳定

应对：

- 文本使用增量流；
- 卡片以完整对象 upsert；
- 服务端完成 schema 校验后再推送；
- UI 不直接解析模型原始未闭合 JSON。

### 20.4 摘要模型消耗仍然过高

应对：

- 保持单一 Cards 模型调用；
- 控制输出 token 与字段上限；
- 超长会议才分块，并复用分块缓存；
- 内容指纹缓存；
- 可读摘要由 Cards 确定性渲染，不重复调用模型。

### 20.5 Provider 最终转写迟到

应对：

- 本地或当前可用的原始 utterance 作为快速路径；
- 最终 revision 到达后只重算变化分块；
- 结果使用 `provisional` / `final` 状态；
- UI 展示“初步结果”与“最终结果”的状态，不创建两份互相冲突的文档。

---

## 21. 最终推荐流程

```text
会议进行中
  → 持续采集发言
  → 持续采集手写
  → 增量 OCR

会议结束
  → 后台自动触发
  → 冻结证据快照
  → 完成剩余 OCR
  → 清洗和分块完整发言
  → 流式生成短摘要
  → 逐个发布结构化卡片
  → 保存 meeting.summary
  → 保存 meeting.summary_cards
  → recap 默认结果完成
```

最终产品体验应当是：

> 用户结束会议后，系统立即在后台收尾 Evidence 与转写；用户先选择整理模板，并可选填当场结论、最深感受和关注痛点。模板配置与 formal/明确 partial 转写同时 ready 后，系统自动生成一份短、清晰、可执行、包含手写信息的纪要。说话人由系统自动分析，高置信使用已知身份，低置信保留匿名标签，不要求用户确认。会议与访谈共用同一套会议后处理基础设施，场景模板决定内容链路。

---

## 22. 建议优先落地的第一组改动

1. 将 `meeting.summary` 从手动触发改为 `meeting.ended` 自动触发；
2. recap 停止启动 `panel_summary` 主链；
3. 将现有 `onDelta` 接入服务端持久化 SSE；
4. recap 首屏改为消费 `meeting.summary`；
5. OCR 改为会中增量，并在摘要前完成剩余任务；
6. 增加 `meeting.summary_cards`；
7. 删除完整报告生成器、调度、请求和展示入口；旧 API 返回 410；
8. 为 run、artifact 和 event 增加幂等键、内容指纹和版本字段；
9. 保留 `meeting.panel_summary` 与旧报告字段的历史读取兼容，停止新写入。

这组改动完成后，当前最明显的四个问题会被同时解决：

- 触发太晚；
- 默认结果太长；
- 用户看不到生成进度；
- 多条摘要/报告链重复调用模型、内容漂移且增加等待时间。
