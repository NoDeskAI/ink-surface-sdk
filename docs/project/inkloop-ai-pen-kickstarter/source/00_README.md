# InkLoop AI Pen Kickstarter 文档包

版本：v0.1  
日期：2026-07-02  
目标：把“AI 笔 + 教育 + 商务会议 + 10 月底 Kickstarter 上线”的新方案落成可执行 Markdown 文档。

---

## 这包文档解决什么

这包文档把当前项目从“AI 墨水屏标注识别设备”主线，收敛为更适合 Kickstarter 首发的 **InkLoop AI Pen** 主线：

> 一支真实可写的 AI 白板笔，配合轻量 Capture Surface 和 App，把课堂与会议白板变成实时数字内容、结构化笔记、图解、决策和行动项。

核心取舍：

1. **Kickstarter 首发主角是 AI 笔，不是电子纸平板。**
2. **首发场景聚焦教育 + 商务会议。**
3. **第一硬件闭环是白板 + 真实墨水 AI 白板笔 + Capture Surface。**
4. **第二产品闭环是电子纸 + 电容笔 / EMR 笔，作为产品矩阵，不作为 10 月底众筹主承诺。**
5. **护城河不是 OCR、语音整理或普通 AI 总结，而是 InkGraph：连续笔迹事件 + Surface 坐标 + 空间关系 + 时间线 + 场景图建模 + source_refs 可追溯。**

---

## 文件目录

| 文件 | 作用 |
|---|---|
| `01_产品战略与Kickstarter总方案.md` | 产品定位、众筹主张、产品矩阵、首发范围和不承诺范围 |
| `02_系统架构设计.md` | Pen-first Surface Intelligence OS 总架构、端到端链路、现有系统复用关系 |
| `03_各模块技术方案.md` | AI 笔硬件、Capture Surface、Host/Hub、InkGraph、AI Agent、App/Cloud 等模块方案 |
| `04_AI与InkGraph数据契约.md` | RawPenFrame、InkEvent、BoardGraph、LessonGraph、MeetingGraph、KnowledgeObject 等数据契约 |
| `05_目标与里程碑_10月底Kickstarter倒排.md` | 10 月底上线倒排、Gate、KRs、周/月里程碑、验收指标 |
| `06_Kickstarter_GTM与众筹页面方案.md` | Kickstarter 页面结构、奖励档、预热、视频脚本、渠道增长和运营动作 |
| `07_风险_验收指标_降级方案.md` | 技术风险、众筹风险、供应链风险、验收指标和降级策略 |
| `08_依据与变更记录.md` | 内部文档依据、外部 Kickstarter 官方资料、从墨水屏到 AI Pen 的变更说明 |
| `InkLoop_AI_Pen_Kickstarter_方案合集.md` | 以上所有文档合并版，方便一次性阅读 |

---

## 建议阅读顺序

1. 先读 `01_产品战略与Kickstarter总方案.md`，确认方向与首发范围。
2. 再读 `02_系统架构设计.md`，确认新系统如何复用原有标注证据链。
3. 然后读 `03_各模块技术方案.md` 和 `04_AI与InkGraph数据契约.md`，给研发、硬件、AI 和前端拆任务。
4. 最后读 `05_目标与里程碑_10月底Kickstarter倒排.md`、`06_Kickstarter_GTM与众筹页面方案.md`、`07_风险_验收指标_降级方案.md`，用于执行和周会追踪。

---

## 当前版本的强制结论

### 1. 首发产品

**InkLoop AI Pen Starter Kit**

包含：

- 真实可写 AI 白板笔
- Capture Surface / 编码白板膜
- 手机 / 电脑端 Capture Host
- Live Board Viewer
- InkLoop Studio
- 教育 AI Notes
- 商务 AI Actions / Decisions / Diagrams Beta

### 2. Kickstarter 主张

英文建议标题：

> InkLoop AI Pen: Turn Real Whiteboard Writing into Live Notes, Diagrams & Action Items

副标题：

> A real dry-erase smart pen and capture surface for teachers, tutors, and hybrid teams.

### 3. 首发必须演示

| 场景 | 必须演示 |
|---|---|
| 教育 | 老师真实白板书写 → 学生端实时看清 → 课后自动讲义 / 步骤回放 |
| 商务 | 会议主持人画架构图 / 流程图 → 远程成员实时看 → 会后决策 / 行动项 / 图解导出 |

### 4. 10 月底前必须冻住的范围

必须做：

- 单笔真实书写
- A3/A2 Capture Surface 稳定捕捉
- Web / Desktop 实时白板
- Session 录制和回放
- 教育讲义生成
- 商务行动项 / 决策候选生成
- source_refs 可追溯
- Kickstarter 真实原型视频

暂不承诺：

- 任意普通白板无配置适配
- 完美多笔多色
- 深度 Zoom / Teams API 集成
- 完美公式识别
- 完整电子纸平板首发交付
- 全本地 LLM

---

## 工作口径

这包文档是 Kickstarter 倒排版，不是长期理想版。所有内容服务于一个硬目标：

> 2026 年 10 月底正式上线 Kickstarter，且页面、原型、供应链、演示、GTM 和风险披露足够可信。
