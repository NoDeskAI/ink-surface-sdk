# InkLoop AI 与 InkGraph 数据契约

版本：v0.1  
日期：2026-07-02

---

## 1. 契约目标

InkLoop AI Pen 的数据契约必须服务三个目标：

1. **实时还原书写过程。** 每一笔都有坐标、时间、设备、Surface 和状态。
2. **让 AI 看懂场景，而不是直接猜原始笔迹。** AI 消费的是 SceneView / InferenceView。
3. **所有结果可追溯。** 讲义、纪要、行动项、图解都能反查到原始笔迹、区域、时间戳和 source_refs。

---

## 2. 事件层级

```text
RawPenFrame
→ Stroke
→ InkEvent
→ HMP / Evidence
→ BoardObject
→ BoardGraph
→ SceneView
→ AI Result
→ KnowledgeObject
```

| 层级 | 真相源 | 说明 |
|---|---|---|
| RawPenFrame | 笔端 / Host | 原始硬件帧 |
| Stroke | Capture Runtime | 一次连续落笔 |
| InkEvent | Event Ledger | 标准事件，进入账本 |
| HMP / Evidence | Evidence Builder | 手势取证，不做 AI 推断 |
| BoardObject | InkGraph Runtime | 文本、公式、图形、箭头、区域等对象 |
| BoardGraph | InkGraph Runtime | 对象之间的空间和语义关系 |
| SceneView | AI Input Builder | 给模型的精简视图 |
| AI Result | AI Agent | 候选结果，需校验 |
| KnowledgeObject | 用户确认后 | 长期知识沉淀 |

---

## 3. RawPenFrame

```ts
type RawPenFrame = {
  pen_id: string;
  session_id: string;
  surface_id?: string;

  ts_device_ms: number;
  ts_host_ms?: number;

  tip_state: "down" | "hover" | "up";
  pressure?: number;

  optical?: {
    x_raw?: number;
    y_raw?: number;
    pattern_id?: string;
    quality: number;
  };

  imu?: {
    ax: number; ay: number; az: number;
    gx: number; gy: number; gz: number;
  };

  color_id?: string;
  battery?: number;
  firmware_version: string;
};
```

### 规则

- `ts_device_ms` 必填，`ts_host_ms` 由 Host 对齐。
- `tip_state` 是笔迹切分的第一依据。
- `optical.quality` 低于阈值时可使用 IMU 短时补偿，但必须降低 confidence。
- 原始帧不直接上云，除非用户启用 debug 上传。

---

## 4. Stroke

```ts
type StrokePoint = {
  x_norm: number;
  y_norm: number;
  t_ms: number;
  pressure?: number;
  quality?: number;
};

type Stroke = {
  stroke_id: string;
  session_id: string;
  surface_id: string;
  pen_id: string;
  points: StrokePoint[];
  bbox_norm: [number, number, number, number];
  ts_start_ms: number;
  ts_end_ms: number;
  source_frame_refs?: string[];
};
```

### 规则

- 坐标一律归一化到 Surface `[0,1]`。
- `bbox_norm` 是渲染、取证和 AI 锚定的基础。
- Stroke 可本地缓存，不一定全部上云。

---

## 5. InkEvent

```ts
type InkEvent = {
  event_id: string;
  trace_id: string;
  session_id: string;
  surface_id: string;
  pen_id: string;

  event_type:
    | "stroke"
    | "erase"
    | "gesture"
    | "mode_change"
    | "session_marker";

  stroke_refs: string[];
  bbox_norm: [number, number, number, number];
  ts_start_ms: number;
  ts_end_ms: number;

  source: {
    device: "ai_pen" | "epaper" | "web_demo";
    localization: "encoded_surface" | "imu_fusion" | "epaper_digitizer" | "manual_mock";
    confidence: number;
  };

  metadata?: {
    color?: string;
    tool?: "pen" | "highlighter" | "eraser";
    mode?: "teach" | "meeting" | "paper";
  };
};
```

### 规则

- `event_id` 幂等，重复上传不能生成重复卡片。
- `trace_id` 贯穿 AI 请求、结果、导出和 debug。
- `source.confidence` 低于阈值时，AI 结果必须标注低置信或待确认。

---

## 6. HMP / Evidence

HMP 是一次手势的取证记录，只保存事实，不保存 AI 推断。

```ts
type HmpEvidence = {
  hmp_id: string;
  event_refs: string[];
  session_id: string;
  surface_id: string;

  mode: "anchored" | "self_content" | "mixed" | "unknown";
  action:
    | "underline"
    | "circle"
    | "arrow"
    | "freehand"
    | "erase"
    | "tap"
    | "write";

  target_region: [number, number, number, number];
  target_object_refs: string[];

  object_hint:
    | "text"
    | "formula"
    | "diagram"
    | "image_region"
    | "blank"
    | "unknown";

  text_hint?: string;
  crop_ref?: string;
  vector_ref?: string;
  confidence: number;

  recognition?: {
    recognizer_source:
      | "none"
      | "geometry"
      | "digital_ink"
      | "local_ocr"
      | "local_classifier"
      | "cloud_vlm_fallback";

    gate_decision:
      | "store_only"
      | "trigger_ai"
      | "ask_confirm"
      | "fallback_later"
      | "ignore";

    raw_candidates?: Array<{ text: string; score?: number; source: string }>;
    selected_text?: string;
    selected_score?: number;
    trigger_type?: string;
    fallback_reason?: string;
    latency_ms?: number;
  };
};
```

---

## 7. BoardObject

```ts
type BoardObject = {
  object_id: string;
  session_id: string;
  surface_id: string;

  type:
    | "text"
    | "formula"
    | "shape"
    | "arrow"
    | "diagram_node"
    | "diagram_edge"
    | "region"
    | "decision"
    | "risk"
    | "action_item"
    | "question";

  bbox_norm: [number, number, number, number];
  stroke_refs: string[];
  hmp_refs: string[];

  text_candidate?: string;
  normalized_text?: string;
  confidence: number;

  created_at_ms: number;
  updated_at_ms: number;
};
```

---

## 8. BoardGraph

```ts
type BoardGraph = {
  graph_id: string;
  session_id: string;
  surface_id: string;
  version: string;

  nodes: BoardObject[];

  edges: Array<{
    edge_id: string;
    from: string;
    to: string;
    relation:
      | "contains"
      | "points_to"
      | "next_step"
      | "depends_on"
      | "contrasts_with"
      | "assigned_to"
      | "causes"
      | "supports"
      | "replaces"
      | "nearby";
    evidence_refs: string[];
    confidence: number;
  }>;

  updated_at_ms: number;
};
```

---

## 9. SceneView / InferenceView

AI 不直接读取 RawPenFrame、Stroke 和内部几何分数，而读取经过蒸馏的 SceneView。

```ts
type SceneView = {
  scene_id: string;
  session_id: string;
  mode: "teach" | "meeting" | "paper";

  narrative: string;

  anchors: Array<{
    anchor_id: string;
    object_refs: string[];
    bbox_norm: [number, number, number, number];
    label?: string;
  }>;

  marked: Array<{
    object_ref: string;
    text?: string;
    object_type: string;
    confidence: number;
  }>;

  graph_summary: {
    node_count: number;
    edge_count: number;
    key_relations: string[];
  };

  time_window: {
    start_ms: number;
    end_ms: number;
  };

  recall?: Array<{
    source: "session" | "course_history" | "project_memory";
    title: string;
    snippet: string;
    source_ref: string;
  }>;

  source_refs: InkLoopSourceRef[];
};
```

---

## 10. LessonGraph

```ts
type LessonGraph = {
  lesson_id: string;
  session_id: string;
  title?: string;

  steps: Array<{
    step_id: string;
    order: number;
    kind: "definition" | "example" | "derivation" | "formula" | "diagram" | "conclusion";
    content: string;
    latex?: string;
    board_object_refs: string[];
    source_refs: InkLoopSourceRef[];
    confidence: number;
  }>;

  concepts: Array<{
    concept_id: string;
    name: string;
    explanation: string;
    source_refs: InkLoopSourceRef[];
  }>;

  exports: {
    markdown?: string;
    pdf_ref?: string;
  };
};
```

### 教育输出规则

- 每个 step 必须引用至少一个 board object 或 ink event。
- 公式识别低置信时，输出应标为 “needs_review”。
- 课后讲义默认可编辑，不直接写死为最终答案。

---

## 11. MeetingGraph

```ts
type MeetingGraph = {
  meeting_id: string;
  session_id: string;
  title?: string;

  decisions: Array<{
    decision_id: string;
    content: string;
    alternatives?: string[];
    rationale?: string;
    source_refs: InkLoopSourceRef[];
    confidence: number;
  }>;

  actions: Array<{
    action_id: string;
    content: string;
    owner?: string;
    due_date?: string;
    status: "candidate" | "confirmed" | "dismissed";
    source_refs: InkLoopSourceRef[];
    confidence: number;
  }>;

  risks: Array<{
    risk_id: string;
    content: string;
    severity?: "low" | "medium" | "high";
    source_refs: InkLoopSourceRef[];
    confidence: number;
  }>;

  diagrams: Array<{
    diagram_id: string;
    type: "architecture" | "flowchart" | "timeline" | "unknown";
    mermaid?: string;
    svg_ref?: string;
    source_refs: InkLoopSourceRef[];
    confidence: number;
  }>;
};
```

### 会议输出规则

- 行动项默认是 `candidate`，需要用户确认后再进入任务系统。
- 不能只有语音 source_ref；白板场景至少应有 ink / board source_ref。
- 图解导出 Beta 必须显式标注置信度。

---

## 12. SourceRefs

```ts
type InkLoopSourceRef =
  | {
      type: "ink_event";
      session_id: string;
      event_id: string;
      ts_start_ms: number;
      ts_end_ms: number;
      bbox_norm?: [number, number, number, number];
    }
  | {
      type: "board_object";
      session_id: string;
      object_id: string;
      object_type: string;
      bbox_norm: [number, number, number, number];
    }
  | {
      type: "audio_segment";
      session_id: string;
      start_ms: number;
      end_ms: number;
      speaker?: string;
      transcript_ref?: string;
    }
  | {
      type: "project_memory";
      memory_id: string;
      kind: string;
      title: string;
    };
```

### 校验规则

| 结果类型 | 最低 source_refs 要求 |
|---|---|
| Lesson step | 至少 1 个 ink_event 或 board_object |
| Formula explanation | 至少 1 个 formula / text / ink_event |
| Meeting decision | 至少 1 个 board_object 或 ink_event；有语音则可补 audio_segment |
| Action item | 至少 1 个 ink_event / board_object；owner / due_date 低置信时需用户确认 |
| Diagram export | 至少 2 个 diagram_node / arrow / shape 或对应 ink_event |

---

## 13. KnowledgeObject

```ts
type KnowledgeObject = {
  ko_id: string;
  workspace_id?: string;
  session_id: string;

  kind:
    | "lesson_note"
    | "formula_step"
    | "meeting_action"
    | "meeting_decision"
    | "meeting_risk"
    | "diagram"
    | "summary"
    | "question";

  title: string;
  content: string;
  status: "accepted" | "edited" | "follow_up" | "dismissed";

  source_refs: InkLoopSourceRef[];

  created_at_ms: number;
  updated_at_ms: number;
  created_by: "user" | "ai" | "system";

  export_refs?: Array<{
    target: "markdown" | "pdf" | "notion" | "jira" | "slack" | "miro";
    external_id?: string;
    url?: string;
  }>;
};
```

### 沉淀规则

- `dismissed` 不进入长期知识库。
- `accepted`、`edited`、`follow_up` 可以进入长期知识库。
- source_refs 无法反查的结果只能进入 debug，不进入可信 KnowledgeObject。

---

## 14. Result Validator

```ts
type ValidationResult = {
  ok: boolean;
  result_id: string;
  errors: Array<{
    code:
      | "missing_source_refs"
      | "broken_source_ref"
      | "low_confidence"
      | "unsupported_export"
      | "schema_mismatch"
      | "unsafe_action";
    message: string;
  }>;
  display_state: "trusted" | "needs_review" | "debug_only" | "hidden";
};
```

### 验证策略

1. schema 必须通过。
2. source_refs 必须可反查。
3. 低置信但可用的结果进入 `needs_review`。
4. 行动项、外部任务创建等必须用户确认。
5. AI 不能覆盖原始事件账本。

---

## 15. AI Prompt 输入原则

模型输入应该长这样：

```json
{
  "mode": "teach",
  "narrative": "用户在左上写了二次方程，并在下方连续推导配方步骤...",
  "marked": [
    {"object_ref": "obj_formula_12", "text": "x^2 + 2x + 1", "object_type": "formula"}
  ],
  "graph_summary": {
    "key_relations": ["formula_step", "next_step", "boxed_conclusion"]
  },
  "source_refs": [
    {"type": "ink_event", "event_id": "evt_001", "ts_start_ms": 1200, "ts_end_ms": 2500}
  ],
  "output_schema": "LessonGraph.v1"
}
```

模型不应该拿到：

- 全量原始坐标点
- 未脱敏调试日志
- 不必要的完整课程 / 会议内容
- 内部置信算法细节
- 设备密钥或用户私密配置

---

## 16. 隐私与数据边界

| 数据 | 默认处理 |
|---|---|
| RawPenFrame | 本地保存 / debug 可选上传 |
| Stroke | 本地保存，必要时摘要上云 |
| InkEvent | 本地账本，云同步可选 |
| SceneView | 可上云推理，最小化上下文 |
| OCR / HWR 结果 | 本地优先，云 fallback 需用户授权 |
| 语音 | 非首发主链路，可选接入 |
| AI 结果 | 用户空间内保存，可删除 |
| KnowledgeObject | 用户确认后沉淀，可导出 / 删除 |

---

## 17. 指标

| 指标 | 目标 |
|---|---:|
| source_refs 可追溯率 | ≥ 90% |
| AI 结果 schema 通过率 | ≥ 95% |
| AI 有用性：接受 / 编辑 / 二次追问率 | ≥ 30% |
| 行动项误触发率 | < 5% |
| 公式步骤 needs_review 标注率 | 100% 覆盖低置信结果 |
| 断网后事件补传成功率 | ≥ 99% |
