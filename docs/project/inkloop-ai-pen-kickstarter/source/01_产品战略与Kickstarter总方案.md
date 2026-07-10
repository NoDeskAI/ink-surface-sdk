# InkLoop AI Pen 产品战略与 Kickstarter 总方案

版本：v0.1  
日期：2026-07-02

---

## 1. 战略结论

当前项目应从“AI 墨水屏标注设备”升级为：

# Pen-first Surface Intelligence Platform

第一款众筹产品为：

# InkLoop AI Pen

一句话定位：

> 一支真实可写的 AI 白板笔，把课堂和会议白板变成实时数字内容、结构化笔记、图解、决策和行动项。

Kickstarter 首发不应主推电子纸平板。电子纸方案继续保留为第二产品闭环，但不要让它成为 10 月底众筹的交付包袱。

---

## 2. 为什么首发必须是 AI 笔

### 2.1 需求更直观

教育和商务会议里的白板痛点非常容易被视频解释：

- 老师写公式，学生端实时看清。
- 课后自动生成步骤讲义。
- 产品 / 工程团队画架构图，远程同事同步看。
- 会后自动生成决策、风险和行动项。

这比“AI 墨水屏标注设备”更适合 Kickstarter，因为视频第一眼能懂。

### 2.2 技术可复用

原方案里最有价值的部分不是电子纸硬件本身，而是：

```text
Stroke
→ AnnotationEvent
→ HMP / Evidence Builder
→ MarkGraph
→ InferenceView
→ AI Result
→ ScreenOverlay
→ KnowledgeObject
```

新方案应把这套链路抽象为：

```text
RawPenFrame
→ Stroke
→ InkEvent
→ HMP / Evidence Builder
→ InkGraph / BoardGraph
→ SceneView / InferenceView
→ LessonGraph / MeetingGraph
→ KnowledgeObject
```

也就是说，原系统不是推倒重来，而是从“电子纸文档标注系统”上升为“笔迹事件与 Surface 智能建模平台”。

### 2.3 众筹故事更强

Kickstarter backer 不会先买复杂架构，他们先买一个能感知的改变：

> 我还是用真实白板笔写，但内容自动数字化、实时共享、会后整理。

这比“买一台新的电子纸平板”更有记忆点，也更容易拉开和 reMarkable、Supernote、Boox、Kindle Scribe 的差异。

---

## 3. 首发产品定义

## InkLoop AI Pen Starter Kit

| 模块 | 描述 |
|---|---|
| AI 白板笔 | 真实可写、可替换白板笔芯、内置定位 / IMU / MCU / BLE |
| Capture Surface | 可贴在普通白板上的轻量定位膜 / 捕捉 Surface |
| Capture Host | 手机 / 电脑 App，接收笔迹流、渲染白板、缓存 session |
| Live Board Viewer | 学生 / 远程成员通过链接实时看白板 |
| InkLoop Studio | 会后回放、编辑、AI 结果确认、导出 |
| AI Lesson Notes | 教育场景：步骤讲义、公式说明、课程回放 |
| AI Meeting Actions | 商务场景：会议纪要、决策、风险、行动项、图解 Beta |

---

## 4. 产品矩阵

| 产品 | Kickstarter 角色 | 用户 | 核心场景 | 形态 |
|---|---:|---|---|---|
| InkLoop AI Pen Starter Kit | 首发英雄产品 | 老师、培训师、会议主持人 | 白板书写实时捕捉 + AI 整理 | 智能笔 + Capture Surface + App |
| InkLoop AI Pen Meeting Kit | 高客单奖励档 / Beta | 产品、工程、设计、项目团队 | 会议白板 + 决策 + 行动项 | 多笔预留 + 大 Surface + 团队 Workspace |
| InkLoop Studio | 必须交付的软件核心 | 教育 / 商务通用 | 回放、编辑、导出、分享、AI 结果管理 | Web / Desktop / Mobile |
| InkLoop Cloud | 众筹后订阅 / 增值 | 高频用户 / 团队 | 同步、AI credits、团队空间、导出 | 云服务 |
| InkLoop Paper | 路线图，不做首发主承诺 | 学生、研究者、老师 | PDF 阅读标注、题解、知识沉淀 | 电子纸 + 笔 |

---

## 5. 目标用户

## 5.1 教育人群：第一切入口

### 用户画像

- 在线数学 / 理科老师
- 一对一 / 小班课补习老师
- 技术培训师 / 认证讲师
- 编程 / 工程类课程讲师
- 课程内容创作者

### 核心痛点

| 痛点 | 产品回应 |
|---|---|
| iPad 写课件不如站立白板自然 | 保留真实白板书写动作 |
| 文档摄像头 / 手机拍白板反光、遮挡、不清晰 | 笔迹对象流实时同步，不依赖拍照 |
| 软件白板写公式和推导摩擦大 | 真实白板笔 + Capture Surface |
| 课后资料整理耗时 | 自动生成步骤讲义、截图、PDF / Markdown |
| 历史课程难搜索 | 笔迹 + OCR + AI 结构化 |

### 首发承诺

> 像普通白板笔一样讲课，学生端实时看清，课后自动得到步骤化讲义和回放。

---

## 5.2 商务会议人群：高客单扩展

### 用户画像

- 软件 / 平台工程团队
- 产品经理 / 技术项目经理
- 设计 / UX / 研究团队
- 架构师 / 技术负责人
- 咨询 / 跨职能工作坊团队

### 核心痛点

| 痛点 | 产品回应 |
|---|---|
| 远程成员看不清实体白板 | Live Board 实时共享 |
| 白板内容会后丢失 | Session 录制、回放、导出 |
| 架构图 / 流程图无法转成文档 | DiagramGraph / Mermaid / SVG Beta |
| 会议决策和行动项靠人工整理 | MeetingGraph Agent |
| 软件白板不如实体白板快 | 保留实体白板输入，软件做后处理 |

### 首发承诺

> 继续用实体白板开会，让远程成员实时看清，并在会后得到可编辑的会议纪要、决策和行动项。

---

## 6. Kickstarter 首发范围

### 6.1 Must-have

| 模块 | 必须交付能力 |
|---|---|
| AI Pen | 单笔真实书写、稳定 pen down/up、坐标流、BLE 通信、本地缓存 |
| Capture Surface | A3/A2 样片稳定定位，可擦写，可校准 |
| Live Board | 学生 / 远程成员通过链接看实时笔迹 |
| Session Replay | 按时间回放课程 / 会议白板 |
| 教育 AI | 课后步骤讲义、截图、关键词、可编辑结果 |
| 商务 AI | 行动项、风险、决策、会议摘要候选 |
| Studio | 历史 session、回放、AI 结果确认、导出 |
| Trace | AI 结果可反查笔迹、区域、时间戳、source_refs |

### 6.2 Should-have

| 模块 | 能力 |
|---|---|
| 公式识别 | 常见数学表达式转 LaTeX / 文字说明 |
| 图形识别 | 方框、箭头、流程图、架构图节点关系 |
| Markdown 导出 | 课程讲义 / 会议纪要导出 Markdown |
| PDF 导出 | 课后讲义 PDF |
| Mermaid 导出 | 商务图解 Beta |
| 云同步 | 基础账号和 session 云端备份 |

### 6.3 Could-have / Stretch

| 模块 | 能力 |
|---|---|
| 多笔多色 | Meeting Kit Beta |
| 专用 Room Hub | 商务会议室扩展 |
| Slack / Notion / Jira | 先做导出或半自动 adapter，不做深度承诺 |
| 电子纸闭环 | Roadmap / Developer Preview |
| 任意白板适配 | 后续研发路线，不作为首发承诺 |

### 6.4 明确不承诺

- 不承诺在任意普通白板上无需 Capture Surface 即可高精度定位。
- 不承诺 10 月底完成完整电子纸平板交付能力。
- 不承诺完美识别所有手写、公式、图形和语音。
- 不承诺首发即深度接入 Zoom / Teams / Google Meet API。
- 不承诺多笔多色作为基础档稳定交付。

---

## 7. 推荐 Kickstarter 标题与主张

### 标题

> InkLoop AI Pen: Turn Real Whiteboard Writing into Live Notes, Diagrams & Action Items

### 副标题

> A real dry-erase smart pen and capture surface for teachers, tutors, and hybrid teams.

### 中文内部主张

> 像普通白板笔一样写，远程实时看清，会后自动生成讲义、会议纪要、图解和待办。

### 30 秒电梯稿

InkLoop AI Pen lets teachers and teams keep using real whiteboards while capturing every stroke digitally. Write with real dry-erase ink, share the board live, replay the session, and let AI turn lessons and meetings into notes, diagrams, decisions, and action items.

---

## 8. 奖励档建议

| 档位 | 内容 | 目标 |
|---|---|---|
| Supporter | 感谢、内测社区、软件 beta 资格 | 建社区 |
| Educator Early Bird | 1 支 AI Pen + A2 Capture Surface + App + AI credits | 主销量、限量制造稀缺 |
| Educator Kit | 1 支 AI Pen + 大 Surface + 更高 AI credits | 标准档 |
| Meeting Kit Beta | 2 支 AI Pen + 大 Surface + Team Workspace | 高客单、商务场景验证 |
| Founder Edition | 限量编号、API/SDK 早期权限、Founder 社群 | 高信任用户 |
| Pilot Pack | 5-10 套试点包 | 小机构、培训团队、创业团队 |

> 定价必须用 BOM、运费、坏件率、售后 buffer、Kickstarter 平台费和 Stripe 支付处理费倒推，不能只按心理价定。

---

## 9. 成功定义

10 月底上线时，成功不是“页面写得好看”，而是同时满足：

1. **真实原型能演示。**
2. **教育和商务两个视频 demo 能看懂。**
3. **首发范围清楚，不虚假承诺。**
4. **供应链和交付计划可信。**
5. **预热受众足以支撑首日转化。**
6. **AI 输出可追溯、可编辑、可拒绝，不是黑箱总结。**

---

## 10. 一句话战略备忘

> AI Pen 是主角。Capture Surface 是可信定位底座。InkGraph 是护城河。教育是第一切入口。商务是高客单扩展。电子纸是第二闭环，不是首发包袱。
