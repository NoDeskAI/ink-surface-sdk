# InkLoop · AI 标注阅读 demo

在原文上**圈、划、写**，停笔片刻，AI 以低打扰的旁注在标注旁/页边轻声指路；翻页后还记得你前面读过什么。

> A 组（实时闭环组）验证工程。第一周定位：用 Web 验证「标注 → 理解 → 回屏」的交互与数据闭环（决策 D2：脚手架运行时可换，设计语言与契约迁移到硬件电子纸）。

---

## 快速开始

```bash
npm install
cp .env.example .env      # 然后填入网关 Key（见下「团队上手」）
npm run dev               # http://localhost:8765
```

- `?dev=1` 或按 `d` 唤出**开发面板**（provider 切换 / 行为设置 / 坐标自测 / 延迟 / trace）。
- `npm run check` 跑 TS 严格类型检查；`npm run build` 类型检查 + 生产构建。
- 导入**数字版 PDF**（有文本层的）效果最佳——扫描版要等 B 组 OCR。

---

## 核心交互

### 1. 手势集（符号 = 意图，纯几何识别，0 OCR）

笔迹无损采集（Pointer Events，决策 D3），`classifyScored` 按几何给每笔打**相似度分**——画得像范例才算手势，随手涂、半截笔画被忽略（门槛 `GESTURE_MIN_SCORE`）。

| 手势 | 含义 | AI 行为 |
|---|---|---|
| **圈** ◯ | 这是什么 | 解释圈住的概念 |
| **划线** ‾ | 重点 | 提炼要点 + 为什么重要 |
| **圈 + 记号(问号)** | 提问 | 针对圈住的内容直接作答 |
| **写字（页边批注）** | 自由批注 | 把手写当想法，结合附近正文呼应（手写内容读取待 B 组 OCR） |

「圈住了什么字」靠**标注 bbox 与 PDF 文本层几何相交**取得（数字版免 OCR）——不是看截图。

### 2. 段落讨论触发（防打扰 + 原地更新）

同一段上的连续手势聚成一次**讨论**；**停笔 `pauseSeconds`（默认 5s）后才生成**（避免边画边弹）；同段继续画 → **原地刷新同一条**（按 `discId` upsert），不每段各占空间。

### 3. AI 注的落点

- **页面模式**：右侧留白（gutter），按标注 y 对齐、多条防重叠下推；或切「贴正文浮动」。
- **重排模式**：绝对定位进右侧留白、与所属段同行对齐、斜体 + 半透明、不进文档流（**零排版变动**）。
- 全局开关在开发面板「输出落点」。

### 4. 重排阅读（reader mode）

顶栏「重排」切换 **原版 PDF ⇄ 重排**。把文本层重排成干净单栏版心，**重排可圈画**（手势命中哪一段就用该段的原页 bbox 入管线）。三档引擎（开发面板「重排引擎」）：

- `local`：纯几何启发式，离线即时、保 bbox。
- `hybrid`：几何打骨架 + 模型逐块精修（纯文字），保 bbox。
- `vision`：几何打骨架 + **Kimi 看页面图**重判角色/阅读顺序（多栏/标题更准），按 id 重排不合并拆分 → 原页 bbox 原样保留。

> 重排只保留**逻辑结构**（标题/段落/顺序），不保留视觉版式；想要原版式就用「原版 PDF」。

### 5. 跨页阅读记忆（让 AI 读懂全书而非一页）

- 每段讨论记一条标注记忆（符号 + 原文 + AI 回应，逐页存）。
- **翻页时**把上一页压成一句摘要（`/api/summarize`）。
- 答题时模型**按需 `recall_page(n)`** 回看相关前页来综合（Kimi 工具循环）；回看了哪些页在开发面板可见。

---

## 架构

```
src/
  core/         纯逻辑，无 DOM
    contracts.ts   七个 v0 数据契约（D1 归一化坐标 / D3 stroke 无损 / D4 version 冻结）
    transform.ts   坐标换算唯一入口 + GUTTER 布局常量
    classify.ts    笔迹几何分类 + 相似度分（classifyScored）+ 求解意图
    gesture.ts     手势集（圈/划/问/写 → 意图）+ 形状门槛 isDeliberate
    reflow.ts      本地启发式重排（行→段→标题，保 bbox，确定性 id）
    memory.ts      逐页阅读记忆 + 跨页快照（喂 Tier2 recall）
    pipeline.ts    recordEvent（逐笔无损）+ commitDiscussion（段落讨论 upsert）+ summarizePage
    ids / trace / metrics
  providers/    可替换接缝（契约即接口，B 组在此接真实现）
    ocr.ts         textlayer(真实) / mock / vlm(stub) / local(B 组)
    inference.ts   mock / fail / cloud(→ 本地 /api/infer 代理 → 网关)
    reflow.ts      local / hybrid / vision
  ui/           DOM 层
    renderer / ink / whisper(页面留白) / reader(重排面+行内注) / insight-panel / toolbar / dev-drawer
  app/state.ts  事件总线 + 全局状态 + 行为设置(settings)
  main.ts       装配 + 手势调度（组装窗 + 停顿窗）+ 翻页总结
server/infer.ts dev 代理逻辑：runInference（单发 / Tier2 工具循环）/ runReflow / runSummarize
vite.config.ts  /api/infer · /api/reflow · /api/summarize 中间件（Key 留服务端）
```

**数据流**：笔迹 → 手势分类/门槛 → 段落聚类 → `commitDiscussion`（OCR 取圈住原文 → 推理 → overlay）→ 渲染 + 记入逐页记忆。

---

## AI 网关

- **当前底座 = 裸 `fetch` 打 NoDesk AI Gateway**（Anthropic 兼容 `/v1/messages`，body 注入 `channel/channel_url`）。**不是** `@anthropic-ai/sdk`（该包当前闲置，可清）。
- 默认模型 `kimi-k2.6`（moonshot，支持视觉 + 工具调用，已验证）。
- **切 Sonnet**：改 `.env` 的 `LLM_MODEL=claude-sonnet-4-6` 即可（channel 自动路由到 DMXAPI，需该账户有余额）。
- 三个 dev 端点（Vite 中间件，仅开发期）：`/api/infer`（旁注/讨论，可走 Tier2 工具循环）、`/api/reflow`（重排精修，可带页面图）、`/api/summarize`（翻页摘要）。
- **Key 只在服务端**（`.env` → `process.env`），绝不进前端 bundle；`source_refs` 由服务端从请求装配，不让模型编造（PRD 红线）。

---

## 配置旋钮

| 旋钮 | 默认 | 位置 |
|---|---|---|
| 形状门槛 `GESTURE_MIN_SCORE` | 0.4 | `src/core/gesture.ts` |
| 聚簇纵向间隙 `GAP` | 0.06 | `src/main.ts` |
| 停笔生成秒数 `pauseSeconds` | 5 | 开发面板 |
| 右侧留白宽 `GUTTER_W` | 300 | `src/core/transform.ts` |
| 模型 `LLM_MODEL` | kimi-k2.6 | `.env` |
| 输出落点 / 重排引擎 / 手势开关 | — | 开发面板 |

---

## 诚实边界

- `textlayer` 取文本只对**数字版 PDF**精确；扫描版 / 手写内容要 OCR（B 组 B3）。
- 多栏 / 表格 / 图 / 公式：本地启发式搞不定，用 `vision` 引擎或等 VLM 文档解析（B 组 C 档）。
- 「圈+问号」是「圈 + 任意小记号」的几何近似；精确符号意图最终靠 LLM。
- 重排圈画的命中容差 / 停顿时长仍在调手感。
- Sonnet 经 DMXAPI 当前欠费、Bedrock 在内网——故默认用 Kimi。

---

## 团队上手（同组工程师）

1. clone 本仓库，`npm install`。
2. **拿 `.env`**：网关 Key 不进仓库（已 gitignore）。向 xiaokebuyu 索取 `.env` 文件（含 `LLM_GATEWAY_URL` / `LLM_GATEWAY_KEY` / `LLM_MODEL`），放到项目根目录；或 `cp .env.example .env` 后填入 Key。
3. `npm run dev` → 打开 `http://localhost:8765/?dev=1` → 导入数字版 PDF → 圈/划/写，停 5s 看 AI 旁注；切「重排」「重排引擎」看版面理顺；翻页后在新页提问看跨页综合。

> 所有密钥/网关配置都集中在**一个文件 `.env`** 里，方便统一管理与分发。
