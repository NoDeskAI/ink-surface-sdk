# AI-Annotation-demo 端侧 B 组接入方案

版本：v1.0  
日期：2026-06-22  
目标：把 `Xiaokebuyu/AI-Annotation-demo` 中当前依赖云端 VLM/LLM 的自由笔迹识别、触发判断、局部 OCR 兜底，替换为适合电子纸硬件的端侧低成本链路。

## 1. 结论

这个项目的前端采集、几何门控、HMP、MarkGraph、InferenceView 设计可沿用；但当前 `/api/interpret` 和 `/api/classify-context` 仍是云端模型路径，不能作为电子纸产品的默认主链路。

要求的接入方式是：

```text
保留：
  stroke 采集
  区域组装
  几何模板分类
  SurfaceIndex / HMP / MarkGraph / InferenceView
  append-only marks / ai_turns 账本

替换：
  /api/interpret       -> 端侧 InkInterpretProvider
  /api/ocr-vlm         -> 端侧 PP-OCRv6 / local OCR provider
  /api/classify-context -> 端侧 trigger router，必要时再交给小 LLM

兜底：
  VLM 只作为低频 fallback，不进入默认手写热路径
```

核心原则：

```text
stroke first
trigger first
local first
VLM fallback only
```

## 2. 当前项目中可复用的部分

### 2.1 采集层

对应代码：

```text
src/capture/ink.ts
src/main.ts
src/capture/session.ts
```

可复用点：

- `pen` 与 `touch` 分流：笔用于标注，手指用于导航。
- `StrokePoint = { x, y, t, pressure }` 无损保存。
- 坐标归一化 `[0,1]`，便于跨设备、跨缩放、跨视图。
- deadzone / tap 过滤 / 区域组装。
- 同一区域内连续书写聚成一个 mark，停笔或写到远处后再收口。

电子纸适配方式：

```text
Web PointerEvent
  -> 替换为电子纸 pen driver event

clientX/clientY
  -> 替换为面板坐标 / digitizer 坐标

pressure
  -> 如果硬件支持则保留；不支持则填默认值

pointerType
  -> pen / touch / eraser 由硬件输入层提供
```

### 2.2 HMP 与 SurfaceIndex

对应代码：

```text
src/core/contracts.ts
src/evidence/target.ts
src/core/store-format.ts
```

可复用点：

- `SurfaceObject` 表示屏幕上的结构对象。
- `target_object_refs` 引用对象 id，而不是让模型生成坐标。
- HMP 只保存事实与证据，不保存 AI 推断。
- AI 回复另存在 `ai_turns`，与用户原始 mark 分离。

这部分与我们的方案一致，要求作为对齐基础。

### 2.3 MarkGraph / InferenceView

对应代码：

```text
src/evidence/mark-graph.ts
src/evidence/inference-view.ts
```

可复用点：

- 多个 mark 之间建立空间边、时间边、语义边。
- 将几何和坐标蒸馏成模型可读的叙事：

```text
narrative
marked
question
page_context
anchor_refs
```

这比把原始坐标、原始 stroke、截图直接丢给模型更合适。

## 3. 当前不适合直接用于电子纸的部分

### 3.1 `/api/interpret`

当前职责：

```text
白底笔迹图
  -> 云端 VLM
  -> kind: handwriting | sketch | mixed | none
  -> reading
  -> description
```

问题：

- 输入是截图，不是 stroke-native。
- 需要云端模型。
- 只要自由笔迹过 `ocrWorthy` 门，就可能调用。
- 延迟、功耗、隐私都不适合作为端侧默认路径。

结论：保留接口形状，但替换 provider。

### 3.2 `/api/classify-context`

当前职责：

```text
手写文本 + marked + narrative + conversation
  -> 云端 LLM
  -> respond | fold
```

问题：

- 这是第二次模型调用。
- 对“why?”、“what?”、“=”这类明显触发词来说太重。
- 端侧应该先用触发词和候选列表判断，云端/大模型只处理疑难。

结论：拆成两层。

```text
Local TriggerRouter:
  cheap respond/fold/action 判断

Small LLM / cloud:
  只处理低置信、高价值或用户显式触发的 case
```

### 3.3 `/api/ocr-vlm`

当前职责：

```text
局部截图
  -> 云端 VLM OCR
  -> text
```

问题：

- 对电子纸，局部 OCR 可端侧完成。
- 如果有 SurfaceIndex 文本，根本不应 OCR。
- PP-OCRv6 应作为 image/unknown region fallback，而不是默认读取路径。

结论：替换为 `LocalRegionOcrProvider`。

## 4. 目标端侧链路

### 4.1 总链路

```text
pen events
  -> stroke buffer
  -> region assembly
  -> geometry classifier
  -> SurfaceIndex anchor resolver
  -> HMP formal payload
  -> InkGateProvider
       ├─ store_only
       ├─ trigger_ai
       ├─ need_local_hwr
       ├─ need_local_ocr
       ├─ ask_confirm
       └─ fallback_later
  -> HMP finalized
  -> MarkGraph
  -> InferenceView
  -> local AI / small LLM / cloud fallback
  -> ai_turns
```

### 4.2 成本阶梯

```text
Level 0: stroke 记录
  成本：必须发生
  输出：raw strokes

Level 1: 几何门控
  成本：< 1ms 目标
  输出：markup / freeform / tap / noise

Level 2: 端侧手写候选识别
  成本：只对 freeform + ocrWorthy
  输出：top-k candidates

Level 3: 本地候选重排与触发路由
  成本：词典、上下文、规则、小模型
  输出：trigger_ai / store_only / ask_confirm / fallback

Level 4: 端侧局部 OCR
  成本：只对 image/unknown/background text 缺失
  输出：text_hint

Level 5: VLM fallback
  成本：最高
  触发：显式请求、低置信高价值、充电/空闲后台、开发调试
```

## 5. Provider 接口设计

要求不要让前端直接绑定云端 `/api/interpret`。抽象为 provider：

```ts
export interface InkInterpretProvider {
  interpret(input: InkInterpretInput): Promise<InkInterpretResult>;
}
```

### 5.1 输入

```ts
export interface InkInterpretInput {
  hmp_id: string;
  surface_id: string;
  language_hint: 'en-US' | 'zh-Hans' | string;

  strokes: Array<{
    tool: 'pen' | 'highlighter' | 'eraser';
    points: Array<{
      x: number;
      y: number;
      t: number;
      pressure: number;
    }>;
  }>;

  geometry: {
    bbox: [number, number, number, number];
    stroke_count: number;
    point_count: number;
    width_px?: number;
    height_px?: number;
    path_length_px?: number;
    complexity?: number;
    template_type?: string;
    template_score?: number;
    ocr_worthy: boolean;
  };

  anchor: {
    mode: 'anchored' | 'self_content' | 'mixed' | 'unknown';
    object_hint: 'text' | 'image_region' | 'ui_region' | 'blank' | 'diagram' | 'unknown';
    target_object_refs: string[];
    target_text?: string;
    nearby_text?: string;
  };

  options: {
    allow_vlm_fallback: boolean;
    allow_background_fallback: boolean;
    prefer_local_only: boolean;
  };
}
```

### 5.2 输出

保持兼容当前 `/api/interpret` 的基础字段：

```ts
export interface InkInterpretResult {
  kind: 'handwriting' | 'sketch' | 'mixed' | 'none';
  reading: string;
  description: string;
}
```

扩展端侧需要的字段：

```ts
export interface InkInterpretResultV2 extends InkInterpretResult {
  action:
 | 'store_only'
 | 'trigger_ai'
 | 'ask_confirm'
 | 'fallback_later'
 | 'ignore';

  trigger?: {
    type:
 | 'ask_why'
 | 'ask_what'
 | 'ask_how'
 | 'explain'
 | 'summarize'
 | 'derive'
 | 'translate'
 | 'rewrite'
 | 'todo'
 | 'unknown';
    text: string;
    confidence: number;
  };

  raw_candidates: Array<{
    text: string;
    score?: number;
    source: 'digital_ink' | 'ocr' | 'rule' | 'vlm';
  }>;

  reranked_candidates: Array<{
    text: string;
    score: number;
    rules: string[];
  }>;

  gate: {
    decision:
 | 'geometry_markup'
 | 'skip_tap'
 | 'skip_noise'
 | 'local_hwr'
 | 'local_ocr'
 | 'trigger_hit'
 | 'need_fallback';
    confidence: number;
    reasons: string[];
  };

  provenance: {
    recognizer: string;
    recognizer_version: string;
    reranker_version: string;
    dictionary_version?: string;
    model_downloaded_before_run?: boolean;
    latency_ms: number;
    energy_hint?: string;
  };
}
```

### 5.3 兼容当前前端

当前前端只依赖：

```ts
kind
reading
description
```

所以可先保持接口兼容，额外字段逐步接入：

```text
第一步：端侧 provider 返回 kind/reading/description
第二步：HMP 存 raw_candidates / reranked_candidates / gate
第三步：InferenceView 使用 trigger/action
第四步：禁用默认云端 /api/interpret
```

## 6. HMP 字段扩展要求

当前 HMP：

```ts
export interface HMP {
  hmp_id: string;
  surface_id: string;
  mode: HmpMode;
  action: MarkShape;
  target_region: NormBBox;
  target_object_refs: string[];
  object_hint: HmpObjectHint;
  text_hint?: string;
  crop_ref?: string;
  vector_ref?: string;
  confidence: number;
  version: string;
}
```

要求新增：

```ts
export interface HmpRecognitionEvidence {
  recognizer_source:
 | 'none'
 | 'geometry'
 | 'digital_ink'
 | 'ppocrv6'
 | 'local_classifier'
 | 'local_llm'
 | 'vlm_fallback';

  gate_decision:
 | 'store_only'
 | 'trigger_ai'
 | 'ask_confirm'
 | 'fallback_later'
 | 'ignore';

  raw_candidates?: Array<{ text: string; score?: number; source: string }>;
  reranked_candidates?: Array<{ text: string; score: number; rules: string[] }>;

  selected_text?: string;
  selected_score?: number;

  trigger_type?: string;
  fallback_reason?: string;

  recognizer_version?: string;
  reranker_version?: string;
  dictionary_version?: string;

  latency_ms?: number;
}
```

落入 HMP 后的形态：

```ts
export interface HMP {
  // existing fields...
  recognition?: HmpRecognitionEvidence;
}
```

注意：`recognition` 仍然是证据，不是 AI 推断。  
例如 `trigger_type='ask_why'` 是对用户手写触发词的分类，不是对原文含义的解释。

## 7. `/api/interpret` 替换方式

### 7.1 当前代码位置

前端调用点：

```text
src/core/pipeline.ts
  recognizeInk()
  captureMark()
```

当前逻辑：

```text
feature.type !== markup
  && feature.raw.ocrWorthy
  && layers.ink
    -> POST /api/interpret
```

### 7.2 要求替换点

把：

```ts
async function recognizeInk(inkData: string)
```

替换为：

```ts
async function interpretInkMark(input: InkInterpretInput): Promise<InkInterpretResultV2>
```

然后根据 provider 类型选择：

```text
web demo:
  /api/interpret-v2

Android / electronic paper:
  local InkInterpretProvider

debug:
  local first, then /api/interpret fallback
```

### 7.3 Provider 路由

```ts
export type InkProviderMode =
 | 'mock'
 | 'cloud_vlm'
 | 'local_android'
 | 'local_board'
 | 'hybrid_debug';
```

策略：

```text
mock:
  仅用于前端 UI 开发

cloud_vlm:
  只允许 demo / debug

local_android:
  ML Kit Digital Ink + PP-OCRv6 + reranker

local_board:
  真实电子纸硬件输入 + 端侧模型

hybrid_debug:
  local 失败后显式 fallback，记录 fallback_reason
```

## 8. 触发器定义

端侧优先识别少量高价值触发词，而不是理解所有手写。

### 8.1 英文优先触发词

默认用户：英文母语者。

```text
?
why?
what?
how?
explain
summarize
sum
translate
rewrite
fix
todo
=
```

### 8.2 中文可选触发词

```text
为什么
这是啥
怎么做
解释
总结
翻译
改写
待办
```

### 8.3 `=` 的语义

不要固定成数学计算。

```text
=
  -> derive / complete / infer / conclude
```

例子：

```text
用户在一句话后写 "="
  意图可能是：等价解释、补结论、推导结果、概括成一句话
```

### 8.4 误触发控制

触发 AI 需要满足至少一条：

```text
1. top-1 明确命中触发词，置信度高
2. top-k 包含触发词，且 anchor 高价值
3. 用户在已有 mark 附近写触发词
4. 用户停笔等待，且候选为疑问/命令
5. 用户显式确认
```

低置信时不要直接打扰，返回：

```text
ask_confirm
```

或者：

```text
store_only
```

## 9. VLM fallback 规则

默认不允许：

```text
每次自由笔迹 -> crop -> VLM
```

允许的 fallback：

```text
1. 用户显式点击“理解这处”
2. trigger top-k 模糊，但 anchor 很重要
3. 背景非文本，SurfaceIndex 无对象
4. 端侧识别连续失败
5. 设备充电 + 空闲后台批处理
6. debug 模式采样评估
```

fallback 必须写入 HMP：

```ts
recognizer_source: 'vlm_fallback'
fallback_reason: string
latency_ms: number
```

产品红线：

```text
VLM 不做第一分类器。
VLM 不进入默认手写热路径。
VLM 不能改变原始 HMP 事实，只能补 evidence。
```

## 10. Android / 电子纸端侧实现映射

我们当前 Android PoC 已有：

```text
ML Kit Digital Ink Recognition
PP-OCRv6 tiny ONNX
English full dictionary reranker
candidate list storage
SQLite HMP storage
```

要求模块化为：

```text
InkGateClassifier.java
  输入 stroke features
  输出 cheap gate decision

DigitalInkRecognizerProvider.kt
  输入 Ink strokes
  输出 raw candidates

HandwritingReranker.java
  输入 raw candidates + context + dictionary
  输出 reranked candidates

TriggerRouter.java
  输入 reranked candidates + anchor
  输出 trigger/action

RegionOcrProvider.kt
  输入 crop bitmap
  输出 OCR text blocks

HmpAssembler.java
  合并 geometry / recognition / anchor / provenance
```

## 11. 测试与验收指标

不要只测单次延迟，要测“每 100 次落笔会触发多少重处理”。

### 11.1 三组对比实验

```text
A. 当前方案
   freeform ocrWorthy -> VLM /api/interpret

B. 端侧 gate 方案
   stroke gate -> local HWR -> trigger router -> fallback only if needed

C. trigger-only 方案
   只识别短触发词和符号，其余 store_only
```

### 11.2 指标

```text
gate p50 / p95 latency
digital ink p50 / p95 latency
rerank p50 / p95 latency
PP-OCR p50 / p95 latency
VLM fallback rate per 100 marks
false trigger rate
missed trigger rate
candidate-hit rate
raw top-1 accuracy
reranked top-1 accuracy
store_only correctness
ask_confirm rate
30 min reading+annotation power drain
temperature rise
```

### 11.3 目标门槛

初版要求目标：

```text
geometry gate      p95 < 5 ms
reranker           p95 < 5 ms
local HWR          p95 < 200 ms
PP-OCR fallback    p95 < 300 ms
VLM fallback rate  < 5 / 100 marks
false trigger      < 2%
missed trigger     < 10% for explicit triggers
```

真实门槛要用目标电子纸硬件重测，模拟器数据只能用于链路回归。

## 12. 分阶段落地

### Phase 1：接口兼容替换

目标：不大改前端，先把 `/api/interpret` 的返回扩展出来。

交付：

```text
InkInterpretResultV2 schema
/api/interpret-v2 mock
HMP.recognition 字段
前端 pipeline 接入额外字段但不改变 UI
```

### Phase 2：Android local provider

目标：用现有 Android PoC 提供真实端侧能力。

交付：

```text
Digital Ink top-k
candidate rerank
trigger router
HMP recognition evidence
benchmark report
```

### Phase 3：禁用默认 VLM

目标：VLM 从默认链路降级成 fallback。

交付：

```text
allow_vlm_fallback=false 默认
debug 模式可开
fallback_reason 全量记录
每 100 marks fallback rate 报告
```

### Phase 4：电子纸真机验证

目标：验证真实延迟、功耗、笔迹数据质量。

交付：

```text
真实 pen event replay corpus
30 min 功耗测试
触发词准确率测试
真实英文用户手写样本
```

### Phase 5：端侧小模型 / 本地记忆

目标：把 `InferenceView -> reply` 也尽量端侧化。

交付：

```text
1-3B local model consuming HMP / InferenceView
local vector store
local long-term memory
cloud fallback policy
```

## 13. 给对方的对齐口径

直接这样对齐：

> 我们认可当前 demo 的前端采集、HMP、MarkGraph、InferenceView 设计，尤其是“模型引用对象 id，不吐坐标”和“取证与 AI 结果分离”。  
> 但 `/api/interpret` 现在仍是云端 VLM 做自由笔迹分类和转写，这部分不能作为电子纸硬件的主链路。  
> 我们要求把它定义成 provider 接缝：Web demo 可继续用云端 VLM 跑通体验，生产版由端侧 stroke-native gate、Digital Ink、PP-OCRv6、候选重排和 trigger router 替换。VLM 只做 fallback，并且必须记录 fallback_reason、latency 和 provenance。  
> 这样前端数据契约不推倒重来，B 组也能独立验证准确率、延迟和功耗。

## 14. 待锁定问题

需要团队确认：

```text
1. HMP_SCHEMA_VERSION 是否从 2 bump 到 3？
2. /api/interpret 是否保留兼容字段，并新增 v2 字段？
3. 默认用户语言是否改为 en-US？
4. VLM fallback 默认是否关闭？
5. 端侧 provider 是浏览器调用 Android bridge，还是设备系统服务直接写 HMP？
6. 真实电子纸 pen event 的字段是否包含 pressure / tilt / eraser？
7. 是否允许后台充电时批处理低置信 mark？
```

## 15. 最小可执行下一步

要求下一步只做一件事：

```text
把 /api/interpret 的 provider contract 固化成 InkInterpretResultV2，
并在 Android PoC 中输出同构 JSON。
```

这样 Web demo、Android PoC、电子纸系统可先对齐同一份数据，不必立刻统一运行时。
