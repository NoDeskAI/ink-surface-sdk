# InkLoop · 伴读架构大计划

> 一句话:把"在 PDF 上圈/划/写"做成一个**逐书伴读 agent**——
> **几何只管定位 + 截图,语义全交 LLM;一本书一个会话,一页一个记忆文件,
> 上下文靠 Claude Agent SDK 的会话 + 自动压缩 + 缓存来管理。**

本文是执行蓝图,综合了"标注优化"与"LLM/上下文架构"两条线的全部讨论与实测结论。

---

## 0. 已完成 / 已实测(P0)

| 项 | 状态 | 证据 |
|---|---|---|
| 点按/误触加固 + auto 三档门 | 已提交 `1224b7f` | `classifyScored` 改总行程+时长闸 |
| 老中文 PDF 渲染(cMap) | 已提交 `2563564` | 非嵌入 GBK CID 字体,配 `cMapUrl` |
| **Kimi 网关 prompt 缓存有效** | 实测 ✓ | 第二次相同前缀 `input_tokens=0, cache_read=3616` |
| **图片也能进缓存** | 实测 ✓ | 含图第二次 `cache_read=2718`(连图带文) |
| **图片缓存"坑"定性** | 查清 | 坑是 SDK 把图塞 `tool_result` 每轮 lift 所致;**图放 user message 不受影响** |

验证脚本留在 `scripts/probes/`(`cache-probe.mjs` / `img-cache-probe.mjs`),随时可复跑。

---

## 1. 核心决策(已论证)

1. **几何 / 语义分层。** 几何做不了语义(圈和字母 O 同形),语义靠像素+语境,交 LLM。
2. **bbox 只负责定位 + 精确截图,不再做语义匹配。** 抛弃 bbox-文本矩形相交(实测:松圈把整页 49 块全捞进来)。
3. **合成截图(墨迹叠在页面上)。** 让 LLM"看见"用户画的圈/线/字叠在原文上——这是语义交 LLM 的命门。`grabRegion` 现在只裁 `#page-layer`,**必须改成 page 层 + ink 层合成**。
4. **整页文字恒进上下文;焦点 = 形状精确指针。** 把"上下文(整页)"与"焦点(圈住哪几行)"拆开。
5. **每页一个记忆文件(compact-safe)。** 磁盘文件当持久记忆,对话消息当工作内存——压缩消息不丢知识。
6. **Agent SDK + Kimi(参照 Nodesign)。** 用 SDK 的会话/压缩/缓存,跑便宜且已验证会缓存的 Kimi。
7. **模型先走 Kimi-via-SDK**(model-spoof),需要时再切真 Claude/Bedrock。

---

## 2. 两层架构

### 2.1 几何层(本地 · 0 token)

**只剩四件活:**
1. **刻意性过滤** —— 决定"这个标注值不值得花一次 LLM 调用"。tap/误触一律拦掉。
2. **裁剪区 + overlay 落点** —— 算合成图的裁剪框、回应贴哪。
3. **时空聚簇** —— 一定时间间隔 + 空间邻近内的连续涂写 = 一个"输入单元"(现有 1.2s 组装窗 + `clusterByProximity`,形式化为"时间 AND 空间")。
4. **点在多边形内焦点提示** —— 0 token 算"圈住了哪几行",作为提示喂给 LLM(非必需,便宜的保险/兜底)。

**不再做**:形状语义分类(圈/划/箭头交 LLM 看图判)、bbox-文本匹配。
> ⚠️ 因此现有 auto 三档门(`routeAssembly` 的 mark/write/vlm 路由)**收敛为"刻意 vs 不触发"单闸**——语义统一交 LLM,不再本地分形状。tap 过滤逻辑保留。

**输入加固(借鉴 xournalpp `PenInputHandler`):**
- **tap 判据三条件**:位移 < 1mm `AND` 时长 < 150ms `AND` 距上次抬笔 > 500ms(我们缺第三条"连点抑制",trace 里"一"上 2→12 次连点正因此漏)。
- **Deadzone 1.3px,逐 `pointermove` 即时丢点**:在抖动发生时抑制,而非抬笔后用总行程事后取消。
- 阈值用**物理 mm**(1mm ≈ 3.78 CSS px)比页对角线比例更本质。

### 2.2 语义层(LLM · 全包)

每个刻意标注簇 → **一轮 agent turn**,喂:
- **合成裁剪图**(墨迹叠原文)——给形状 / 圈中什么 / 手写转写;
- **焦点段落**(point-in-polygon 命中的那几行 + 所在整行);
- **整页文字**(在会话上下文 / 当页记忆里)。

LLM 一次判完:形状、圈住内容、手写读出、意图,并给旁注。**无意义 → 返回"不打扰"。**

---

## 3. Agent SDK 架构(参照 Nodesign,1:1 可抄)

- **一本书 = 一个长驻 `query({ prompt: AsyncQueue, options })`**(streamInput 模式);每次标注 → `inputQueue.push({type:'user', message:{content:[合成图, 焦点文字]}})` = 一个 turn;`message.type==='result'` 时 emit 旁注。
- **模型 = Kimi via SDK**,抄 Nodesign `model-context.js` 的 **model-spoof**(把 `kimi-k2.6` 伪装成 `claude-opus-4-7[1m]`,让 SDK 的 auto-compact 在 ~230k 而非误判的 180k 触发)。
- **in-process MCP**(`createSdkMcpServer`, `alwaysLoad:true`):`read_page(n)`(取原文)、`get_page_memory(n)`(取某页记忆)。
- **后端升级**:从 Vite dev 中间件 → **独立 Node 服务**(像 Nodesign `server/`)。⚠️ 本计划最大工程量。
- 可复用 Nodesign:`AsyncQueue`、`session-loop.js runSession()` 骨架、`active-runs.js` registry、`canUseTool` 的 AskUserQuestion 拦截、`handleSDKMessage` 翻译层。

---

## 4. 记忆与上下文管理

### 4.1 记忆存储:每页一个文件(不是内存映射表)

格式直接抄 Claude Code 自己的记忆系统:
```
memory/<book_id>/
  page-007.md      ← YAML frontmatter(索引项) + 正文(marks/摘录)
  page-008.md
  ...
```
```markdown
---
page: 7
digest: "本页讲叙述者与母亲的代际冲突,科技进步无改人情。"   # 记忆A,= 索引项
activity: "圈了第一句问含义;批注'2035年了!'"               # 记忆B,翻页/离页时更新
---
- 〔圈〕"已经是公元二零三五年了…" → (AI 旁注)
- 〔批注〕"2035年了!" → (AI 旁注)
```
- 全书所有 frontmatter 拼起来 = **全书索引**(便宜,放稳定前缀)。
- agent **每轮 / 离页时只增量更新当前页文件**。
- **compact-safe**:文件在磁盘,auto-compact 只压对话消息,文件毫发无损。

### 4.2 上下文组成
```
[稳定前缀 · 可缓存]  人格 + 全书 YAML 索引
        │
        ├─ UserPromptSubmit hook(返回 additionalContext):
        │     前后 ±2 页滑动窗(页记忆 + 原文,每页 ≤1500 字截断)
        │
        └─ message: 本次标注 turn(合成图 + 焦点段落)

auto-compact:压缩 message 历史(知识在文件里,压掉不心疼)
PostCompact hook:把 compact 摘要增量写回当页文件
```
- **缓存策略**:常驻可缓存的是 `人格 + 全书索引`;滑动窗随翻页变,不进稳定前缀;同页多标注时窗不变,缓存逐轮命中。
- **离页总结**:`forkSession` 一个轻量会话做(前缀相同,缓存命中,便宜);或一个普通 turn。
- **水位监控**(抄 Nodesign Stop hook):70% / 85% / 92% 三档警告,催 agent 落档。
- ⚠️ **hook 注入用 SDK 编程式返回值 `additionalContext`**(Nodesign `makeUserPromptSubmitHandler` 实证可行),不是 CLI 那种只能 stderr 的命令钩子。

---

## 5. 分阶段执行

| 阶段 | 内容 | 交付 / 验证 | 是否需迁移后端 |
|---|---|---|---|
| **P0** | cMap / tap 加固 / auto 门 / 缓存验证 | ✅ 已完成 | 否 |
| **P1 · 正确性** | 合成截图 + 整页文字进上下文 + 语义交 LLM + 点在多边形焦点 | **直接修"答非所问"** | 否(现栈 `/api/infer`) |
| **P2 · 几何加固** | Deadzone 逐 move + 500ms 连点抑制 + mm 阈值;auto 门简化为单闸 | 误触从源头掐死 | 否 |
| **P3 · SDK 迁移** | Node 后端 + streamInput 会话 + Kimi model-spoof + MCP 工具 | "对话式伴读"成形;累积 bug 根治 | **是(最大跳跃)** |
| **P4 · 记忆+上下文** | 每页记忆文件 + hook 滑动窗 + auto-compact/PostCompact + fork 总结 + 水位监控 | 长程稳定、上下文有界 | 是 |
| **P5 · 打磨** | 缓存优化、tool_result 裁剪(EditWriteTrim 式)、性能 | 省 token、流畅 | 是 |

> **P1–P2 在现栈即可交付**,先解决用户当前的核心抱怨,不被大迁移阻塞。P3–P5 是架构升级。

---

## 6. 风险与对策

1. **后端架构跳跃**(Vite 中间件 → 独立 Node SDK 服务)——P1/P2 先不动它,争取早交付。
2. **🔴 图进 `tool_result` 破缓存**——规避:合成图永远放在 **user message**,不放 tool_result(实测 user message 里图能缓存)。
3. **每标注一次 LLM 的成本/延迟**——用 P2 的 tap 闸当成本守门,只为刻意标注付费。
4. **YAML 索引随书变长**(~300 页 ≈ 9k token)——超长书按章节 / 窗口裁索引。

---

## 7. xournalpp 借鉴速查(几何层)

| 主题 | 关键做法 | 我们怎么用 |
|---|---|---|
| 输入·tap | 位移<1mm `&` 时长<150ms `&` 距上次>500ms | P2 三条件 tap 闸 |
| 输入·抖动 | Deadzone 1.3px,逐 move 即时丢点 | P2 移植到 Pointer Events |
| 输入·palm | 笔落 → 屏蔽触摸,抬笔后延时解禁 | 补到现有笔/触分流 |
| 套索·包含 | 射线投射 even-odd;笔画要求全点在内 | 点在多边形内 |
| 套索·文字块 | 别用"四角全包"(太严)→ **中心在内** | 焦点提示,一行修好"大圈框半页" |
| 形状 | Inertia `det()`(线≈0/圆≈1)优雅但 | 语义交 LLM,**暂不用** |
| 坐标 | 只存归一化,显示乘 zoom | 我们已是 [0,1] |

---

## 8. 待拍决策

- **(a)** 接受 P3 的"后端从 Vite 中间件升级为独立 Node SDK 服务"?(P1/P2 不依赖它)
- **(b)** 模型走 **① Kimi-via-SDK(推荐:便宜 + 已验证缓存)** 还是 **② 真 Claude/Bedrock**?
