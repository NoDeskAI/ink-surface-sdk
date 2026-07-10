# AI 墨水屏标注识别智能设备：PRD + 软件/硬件完整方案 v0.3

> 生成日期：2026-06-12。基于用户上传的“PDF 标注实时闭环第一周验证”计划，并结合公开竞品/技术资料整理。

## 0. 结论先行：要求做“AI 贴片式研究助手”，不是通用电子纸平板

你的第一周计划已经抓住了最重要的技术闭环：PDF 上传 → 屏幕打开 → 实时监听标注 → 本地 OCR → 云端结构化推理 → 结果回屏 overlay → 用户继续修正。这个闭环是产品差异化的根，不是一个普通“PDF 阅读器 + AI 聊天框”。

本方案要求把产品定义为：面向研究、产品、投资、法律、学习场景的 AI 墨水屏标注识别设备。它的核心卖点不是屏幕参数，而是“用户在材料上动笔的瞬间，系统能理解标注意图，并把可追溯、可接受/拒绝、可沉淀的 AI 反馈贴回原文现场”。

MVP 不做完整知识库、不做模板市场、不做工业设计、不冻结自研硬件。第一阶段应该先用开发板/模拟器/SOM carrier 证明 P0 闭环，然后再进入硬件 EVT。真正的壁垒来自四件事：实时 annotation event contract、局部 OCR + nearby text builder、结构化推理 result + source_refs、电子纸友好的 overlay 交互。

## 1. 竞品研究：谁强在哪里，哪里给我们留了缝

竞品可分成四类：

1. reMarkable：极强的纸感、低干扰、文档/笔记体验，但 AI 能力相对克制，主要是手写转文本、组织和云同步。Paper Pro 已把 color + front light 带入高端线；2026 年 Paper Pure 则继续押注黑白纯写作。
2. Supernote：更像“长期写作与知识组织工具”。Manta 的模块化、可换电池、microSD 和软膜笔感很强，适合强调拥有感和长寿命的用户。
3. BOOX：更像 Android e-paper 平板。开放生态、性能、格式兼容、第三方 App 是优势，但分心、系统复杂、AI 标注闭环不够“研究现场”。
4. Kindle Scribe：阅读内容生态最强，PDF/文档标注和 AI 笔记工具逐渐增强，但设备更服务 Amazon 内容生态，不是开放研究工作流。

机会窗口：目前多数竞品的 AI 仍偏“笔记整理/摘要/搜索”。我们的切口应是 annotation-aware AI：AI 不是等用户离开阅读现场后再总结，而是在圈、划、写、点区域之后，基于局部 OCR、页面上下文和标注几何，给出问题、灵感、关联和下一步动作。

## 2. 竞品对比表

| 产品 | 当前公开强项 | 关键规格/能力 | 对我们的启发 | 我们避免什么 |
| --- | --- | --- | --- | --- |
| reMarkable Paper Pro | 纸感、低干扰、颜色标注、前光 | 11.8 inch color display、adjustable reading light；支持页显示 NXP i.MX8 Mini、2GB RAM、64GB storage | 高端用户愿意为“专注 + 纸感”付费；AI 不应破坏书写心流 | 不做花哨 App 平板，不做通知中心 |
| reMarkable 2 / Paper Pure | 黑白手写体验和极简系统 | reMarkable 2 老硬件为 1GB RAM/8GB storage；Paper Pure 是新黑白线 | 黑白设备仍有市场；续航、低重量、低干扰很重要 | 不把彩色当首版刚需 |
| Supernote Manta | 长写作、组织、模块化、可维修 | 10.7 inch 300 PPI flexible E Ink、32GB + microSD、replaceable battery | 可维修和本地数据拥有感能成为差异化 | 不把云端绑定做得太重 |
| BOOX Note Air4 C | Android 开放生态、性能、格式兼容、颜色 | 10.3 inch Kaleido 3、Android 13、6GB/64GB、frontlight、4096 pressure stylus | 开放性有吸引力；专业用户需要导入/导出灵活 | 不把复杂 Android 体验暴露给主流程 |
| Kindle Scribe | Kindle 内容生态、阅读、前光、AI 笔记工具 | 10.2 inch 300ppi、PDF markup、Active Canvas、notebook summarization | 内容生态和 Active Canvas 说明“原文现场笔记”有价值 | 不被单一内容生态锁死 |

结论：首版设备不需要打败所有电子纸硬件参数；它要在“研究/标注/思考闭环”上做出一眼可感的 AI 反馈。

## 3. 产品定位与目标用户

产品代号：InkLoop AI Paper（可替换）。

一句话定位：一款能理解 PDF 标注并即时回馈思考的 AI 墨水屏研究设备。

核心用户：
- 科研/论文阅读者：看论文时圈出实验、假设、结论，希望 AI 追问、关联、生成阅读卡片。
- 产品经理/创业者：读 PRD、竞品报告、用户访谈，希望 AI 抽取争议、需求、风险、下一步验证。
- 投资/咨询/战略研究：阅读招股书、行业报告，希望 AI 贴源总结、反证、列问题。
- 法律/合规/合同审阅：标注条款，AI 解释风险和相似条款，但必须可追溯。
- 学习型用户：刷教材/讲义，AI 根据标注生成问题和复习卡。

产品北极星指标：用户每 100 次标注中，有多少次 AI 反馈被接受、编辑或二次触发。不是 OCR 字数，也不是模型调用次数。

## 4. MVP PRD

版本：MVP v0.3，对齐第一周闭环验证。

目标：
- G1：PDF 能被导入、渲染、页身份稳定。
- G2：标注事件 1 秒内入库，稳定绑定 document_id + page_id + geometry。
- G3：OCR 能本地运行，输出 bbox、confidence、language、runtime、latency。
- G4：云端推理 API 能消费 OCR + annotation context，返回结构化 result。
- G5：overlay 能在正确页/区域显示，用户可接受/编辑/忽略。
- G6：trace 可复现，支持 debug viewer 和只读 MCP/CLI mock。

非目标：
- 不做完整知识库、不做模板市场、不做支付、不做工业设计、不冻结自研硬件、不做复杂云同步。
- 不做“全 PDF 问答聊天机器人”作为主入口。聊天可有，但不应喧宾夺主。

验收标准：
- 同一 PDF 重复导入 file_hash 稳定，page_id 稳定。
- stroke/highlight/circle/underline/tap_region 至少五类事件可表达。
- 一次标注后，本地 OCR job 被触发并写入 OCRResult。
- InferenceResult 必须包含 result_type、content、source_refs、confidence、model/version。
- 推理结果返回后 2 秒内进入 overlay queue；屏幕/模拟器能渲染 note/question/suggestion_card。
- 每条链路有 trace_id，能从 overlay 反查 PDF、event、OCR、request、result。

## 5. 核心用户流程

主流程：
1. 用户导入 PDF。
2. 设备生成 PDFDocument / PDFPage，并建立 page coordinate map。
3. 用户打开一页，圈、划、写、点选区域。
4. Annotation Listener 生成 AnnotationEvent。
5. OCR Scope Resolver 判断 full_page / region / stroke_neighborhood。
6. 本地 OCR Worker 输出 OCRResult。
7. Context Builder 拼装 annotation + nearby text + page context。
8. Cloud Inference API 返回结构化 insight。
9. Result Validator 校验 JSON schema 和 source_refs。
10. Overlay Renderer 在页面边栏或标注附近显示卡片。
11. 用户接受、编辑、忽略或追问。
12. Accepted result 才进入 project memory；raw OCR 不直接变成画像。

关键体验取舍：
- 书写时不弹窗打断；AI 卡片先进入侧边队列，可轻触展开。
- 电子纸减少动画，用分区刷新和稳定卡片，不做流式闪烁。
- AI 结果一定带来源，可回到 bbox/标注事件。
- 云端失败不阻断标注，保留 deterministic mock 或稍后重试。

## 6. UI 视觉稿与交互原则

已附带独立 SVG 视觉稿：ai_eink_ui_wireframes.svg。

界面原则：
- 低对比但清晰：以黑白灰、纸色背景、粗线框和大留白为主，避免高频纹理造成 ghosting。
- 触控目标大：电子纸设备上按钮不应小于 40px 等效触控高度。
- AI 不抢笔：标注时只显示轻量状态；结果进入侧边队列或 margin card。
- 卡片可追溯：每张 AI 卡片显示 source_refs 摘要，例如 Page 7 · bbox#3 · OCR 0.91。
- 接受/编辑/忽略是第一等操作：这决定数据是否沉淀为 memory。
- Debug Viewer 只在开发/研究模式出现，普通用户不被 trace 细节打扰。

6 个关键屏：文档工作台、PDF 阅读标注、AI Insight Overlay、接受/编辑/沉淀、Trace Debug Viewer、隐私与推理设置。

## 7. 应用层技术架构

选定应用栈：
- 设备端 UI：Qt/QML、Flutter Embedded、或轻量 WebView + Rust/Go daemon。第一周模拟器可用 Web/Canvas/React 快速验证。
- PDF 渲染：MuPDF / PDFium，输出 normalized page coordinate map。
- 事件通道：input daemon → annotation listener → event bus。第一周可用 WebSocket/gRPC stream。
- 本地存储：SQLite + JSONL trace + 文件 cache。
- 任务队列：本地 lightweight job queue；OCR、cloud inference、overlay update 分离。
- 外部读取：MCP/CLI/API 只读，基于 trace storage 暴露，不读内存临时状态。

选定目录：
- /documents：原 PDF 路径引用和 hash，不复制原件。
- /cache/pages：可清理 page image cache。
- /cache/thumbs：低像素缩略图。
- /data/inkloop.sqlite：核心元数据和结果。
- /trace/*.jsonl：开发期端到端日志。
- /models/ocr：本地 OCR 模型。

性能目标：listener P50 < 150ms，P95 < 500ms；本地 OCR region P50 < 2s，full page P50 < 6s；云端推理 P50 < 3s；回屏 render P50 < 500ms。

## 8. 数据协议 v0.3

沿用你计划中的核心协议，并增加 trace_id、schema_version、privacy_scope、checksum、normalized geometry。核心表如下：

PDFDocument：document_id、file_hash、filename、page_count、uploaded_at、source_type、local_original_path、cloud_object_key、schema_version。

PDFPage：page_id、document_id、page_index、width、height、unit、rotation、render_dpi、thumbnail_path、page_image_cache_path、coordinate_transform_version。

AnnotationEvent：event_id、trace_id、document_id、page_id、event_type、geometry、stroke_points、text_note、created_at、device_id、session_id、schema_version。

OCRResult：ocr_result_id、trace_id、event_id、page_id、scope、text_blocks、bbox、confidence、language、model_name、model_version、runtime、latency_ms、preprocess_profile。

InferenceRequest：request_id、trace_id、event_id、document_context、page_context、annotation_event、ocr_blocks、nearby_text、user_profile_stub、output_modes、privacy_scope、schema_version。

InferenceResult：result_id、trace_id、request_id、result_type、content、source_refs、confidence、created_at、model_name、model_version、validator_status。

ScreenOverlay：overlay_id、trace_id、page_id、result_id、overlay_type、geometry、display_text、style、dismissible、created_at、state。

新增关键点：
- geometry 一律存 normalized 坐标 [0,1]，渲染时再映射到设备像素。
- source_refs 不可被 AI 编造；必须来自 OCR blocks、event_id、page_id、bbox。
- accepted_memory 与 raw inference 分表；只有用户确认过的内容进入 memory。

## 9. OCR 本地推理实现

本地 OCR 分三档：

A 档：MVP/第一周
- PDF 页面渲染成 144-192 DPI 灰度图。
- 对标注 geometry 做 bbox 扩张，得到 region crop；复杂标注 fallback full_page。
- 使用 PaddleOCR PP-OCRv5 或同类轻量模型做检测 + 识别；Tesseract 作为稳定 baseline/回归测试。
- 输出 text_blocks、bbox、confidence、language、latency。

B 档：Alpha 设备
- 打印文本用轻量 OCR；手写 margin note 用 handwriting-specific recognizer 或云端 fallback。
- stroke_neighborhood 做二次 OCR：标注周边 1.2x/1.6x/2.0x 三个 crop 尺寸，选 confidence 和 nearby_text 质量最好的结果。
- 引入 layout parser：标题、段落、图表、表格、公式粗分类。

C 档：Beta/研究增强
- PaddleOCR-VL / VLM 文档解析在本地边缘服务器或云端运行，不强塞进低功耗电子纸设备。
- 用户接受/编辑过的 OCR 修正可做项目级词表和后处理，不做隐式画像。

工程 API：
POST /ocr/jobs
GET /ocr/results/{id}
POST /ocr/evaluate

本地推理框架：ONNX Runtime / Paddle Lite / vendor NPU runtime。RK3566 级别适合轻量 OCR；RK3588S/i.MX8M Plus/QCS6490 更适合复杂文档解析或更低延迟。

## 10. 云端推理实现

云端推理不是“把整篇 PDF 扔给模型”。选定只上传最小必要上下文：annotation_event、nearby_text、OCR blocks、page metadata、用户可控的 profile_stub。

推理输出必须用 JSON Schema / Structured Outputs 约束，避免 result_type、source_refs 缺失。选定 result_type：
- question：追问/质疑。
- inspiration：灵感。
- connection：关联到同文档/项目记忆。
- summary：局部总结。
- action：下一步动作。
- error：可恢复错误。

失败策略：
- API timeout：显示“稍后生成”，不阻断书写。
- Invalid JSON：重试一次；仍失败则写 error result。
- source_refs 为空或无法校验：不显示为可信卡片，只进 debug。
- 云端不可用：deterministic mock 返回固定结构，保证 demo 和回归测试。

隐私策略：
- 默认 OCR 本地；云端只收 OCR 片段和 source_refs。
- 用户可关闭云端推理。
- 敏感 PDF 可进入 local-only mode，只允许本地 summary/mock，不上传内容。
- Project profile 默认关闭；打开后必须可查看、编辑、删除，并带 profile_version。

## 11. 本地算力硬件路线

不要第一天就做全自研主板。要求三阶段：

阶段 0：开发板/模拟器验证
- 使用桌面模拟器 + 真实/模拟触控事件跑通闭环。
- 硬件只验证显示、触控、Wi-Fi、overlay 回屏，不冻结规格。

阶段 1：SOM + Carrier EVT
- 用 RK3566 / i.MX8M Plus / RK3588S SOM 做 carrier board。
- 优先 10.3 inch 黑白 E Ink，frontlight 可选，EMR/电容触控按供应链确定。
- 本地 OCR 以轻量模型为主；复杂推理在云端。

阶段 2：自研主板 DVT
- 选择最终 SoC、PMIC、DDR/eMMC、Wi-Fi/BT、EPD controller、touch/EMR、USB-C、电池充电、ESD/保护器件。
- 做功耗、热、EMC、跌落、屏幕 FPC 可靠性、OTA 恢复。

SoC 要求：
- RK3566：低成本、电子书/电子纸生态友好，1 TOPS NPU，适合 MVP 和轻量 OCR。
- i.MX8M Plus：工业可靠性和 NXP 生态更好，2.3 TOPS NPU，适合长期产品化。
- RK3588S：6 TOPS NPU，性能强但功耗/成本/板级复杂度更高，适合 Pro/Dev Kit。
- Qualcomm QCS6490：12 TOPS，高端边缘 AI/Android/Linux 生态，但供应链、授权、成本门槛高。

## 12. PCB 板子与电子元件方案

PCB 架构要求先做 carrier board，不直接挑战手机级高密主板。核心模块：

1. Compute SOM 接口
- SOM board-to-board connector。
- USB2/USB3、I2C、SPI、UART、GPIO、PWM、MIPI/eDP/LVDS/EBC 按面板控制器选择。
- 预留 debug UART、JTAG/SWD、boot mode pins。

2. E Ink 显示
- 10.3 inch 黑白 1404x1872 或 1872x1404 级别面板作为 MVP。
- EPD controller/bridge 取决于 SoC 是否带 EBC 和屏幕接口。
- VCOM、gate/source driving、temperature compensation、LUT/partial refresh 支持。
- Frontlight LED boost driver 可选，Pro SKU 开启。

3. 触控/笔
- 优先 EMR 笔输入或成熟手写 digitizer 模组；电容触控做手指导航。
- I2C/SPI touch controller；固件要输出 pressure/tilt/eraser/palm rejection 状态。
- 触控 FPC 和 EPD FPC 在结构上分层固定，减少压痕和噪声。

4. 电源
- USB-C 5V input + charger IC + battery fuel gauge。
- 3.3V、1.8V、core rails 由 SOM/PMIC 提供；EPD 需要额外高压驱动和 VCOM。
- Frontlight boost、电池 NTC、ship mode、ESD/OVP 必须预留。

5. 无线与安全
- Wi-Fi/BT 模组 + 天线 keepout。
- 安全芯片/TPM 可选，用于设备身份、密钥和 OTA。
- 扬声器/麦克风不是 MVP 必需，避免变成通用平板。

6. 量产可测性
- 工厂测试点：电池电压、主要电源 rail、USB、UART、屏幕刷新、触控事件、Wi-Fi RSSI。
- 预留 recovery button 和 bootloader 安全恢复路径。

要求层数：EVT carrier 4-6 层；若 DDR/SoC 自研板，通常进入 8 层以上并需要严格阻抗/长度匹配。

## 13. 固件与系统软件

固件/系统分层：

Boot & OS：
- U-Boot + Linux Yocto/Buildroot/Debian，或 Android AOSP（若选 BOOX 式开放生态）。MVP 选定 Linux。
- A/B OTA 分区，断电恢复，factory reset。

Driver 层：
- EPD driver：full refresh、partial refresh、区域刷新、灰阶 LUT、温度补偿。
- Input driver：EMR/capacitive touch → Linux input event。
- Power driver：battery gauge、charger、sleep/wake、frontlight PWM。
- Wi-Fi/BT、USB gadget/mass storage/adb-like debug。

Daemon 层：
- ink-renderd：PDF 页面渲染与 EPD buffer 管理。
- ink-inputd：触控/笔事件聚合，生成 stroke session。
- ink-ocrd：本地 OCR job queue。
- ink-inferd：云端 API client + retry + validator。
- ink-traced：SQLite/JSONL trace。
- ink-otad：OTA 与崩溃日志。

功耗策略：
- 标注中：CPU interactive，EPD partial refresh。
- 阅读静止：SoC 降频，Wi-Fi 可休眠，触控唤醒。
- 长时间待机：只保留 RTC/wakeup，屏幕保持最后内容。

固件验收：
- 连续 100 次标注事件不丢失。
- 断网/云端失败后本地标注不丢，恢复网络后可补推理。
- OTA 中断可恢复。
- Sleep/wake 后 page_id/session_id 不错乱。

## 14. API 与最小代码骨架

事件流 API：

POST /documents/import
GET /documents/{document_id}/pages/{page_index}
POST /events/annotation
POST /ocr/jobs
POST /inference/requests
POST /overlays
GET /traces/{trace_id}
GET /mcp/read/documents
GET /mcp/read/events
GET /mcp/read/results

InferenceRequest 示例：
```json
{
  "request_id": "req_001",
  "trace_id": "trc_001",
  "event_id": "evt_001",
  "output_modes": ["question", "connection", "action"],
  "annotation_event": {"event_type": "circle", "geometry": {"bbox": [0.08,0.15,0.71,0.62]}},
  "nearby_text": "Ablation shows annotation context improves retrieval...",
  "ocr_blocks": [{"id": "ocrb_3", "text": "evaluation misses...", "bbox": [0.1,0.18,0.62,0.29], "confidence": 0.91}],
  "privacy_scope": "cloud_minimal"
}
```

InferenceResult 示例：
```json
{
  "result_id": "res_001",
  "request_id": "req_001",
  "result_type": "question",
  "content": "这里可追问：作者是否分析了失败样本边界？",
  "source_refs": [{"page_id": "pg_007", "bbox": [0.1,0.18,0.62,0.29], "ocr_block_ids": ["ocrb_3"], "event_id": "evt_001"}],
  "confidence": 0.82,
  "model_name": "cloud_reasoner",
  "model_version": "v0.3"
}
```

## 15. 一周验证计划升级版

Day 1：协议冻结 + PDF identity + 屏幕路径
- 产出：PDFDocument/PDFPage/AnnotationEvent/OCRResult/trace schema。
- Gate：PDF 可导入，一页可显示，mock event 能绑定 page_id。

Day 2：标注监听 + 本地 OCR
- 产出：listener prototype、OCR worker、scope resolver。
- Gate：标注后 1 秒内 event 入库，OCRResult 可查询。

Day 3：推理 API + 结构化结果
- 产出：InferenceRequest/Result、context builder、deterministic mock。
- Gate：OCRResult → InferenceResult → persisted trace。

Day 4：回屏 overlay + debug viewer
- 产出：overlay renderer、retry/timeout、trace viewer。
- Gate：推理结果 2 秒内回屏或进入 overlay queue；trace 可复现。

Day 5：demo + scorecard + week-two backlog
- 产出：live/recording demo、延迟/成功率、OCR report、device path report。
- Gate：基于证据决定第二周，不提前做模板市场和完整硬件。

## 16. 第二阶段 Backlog

P0：
- 坐标系统稳定化：PDF rotation/cropbox/mediabox/zoom/page cache 一致。
- OCR 质量评估集：印刷文本、手写 margin、圈选区域、表格/公式失败样例。
- Result validator：source_refs 校验、schema 版本兼容、置信度策略。
- Overlay UX：卡片位置、侧边队列、接受/编辑/忽略状态机。

P1：
- Accepted memory：用户确认后沉淀。
- MCP/CLI read：documents/events/ocr/results/overlays/trace。
- Project glossary：项目词表帮助 OCR 后处理。
- 本地隐私模式：敏感 PDF 禁止上传。

P2：
- 研究模板：论文、PRD、合同、投资报告。
- 多文档关联：connection result 真正跨文档。
- 用户画像：只从 accepted memory 聚合。

P3：
- 模板市场。
- 自研硬件 ID/工业设计。
- 云同步/团队协作/订阅。

## 17. 主要风险与对策

| 风险 | 表现 | 对策 |
| --- | --- | --- |
| 电子纸刷新慢 | overlay 闪烁、ghosting | 卡片队列 + 局部刷新 + 减少动画 |
| OCR 对手写差 | AI 输入不稳定 | 手写 margin note 单独模型/云 fallback；记录失败样例 |
| 坐标不准 | overlay 跑偏 | normalized geometry + render transform version + debug overlay |
| 云端模型不稳定 | demo 断链 | deterministic mock + schema validator + typed error |
| 硬件过早冻结 | 返工严重 | 先 SOM carrier，再自研主板 |
| 数据隐私质疑 | 用户不敢上传 PDF | local OCR 默认、本地模式、最小上下文上传、可删除 |
| 变成 Android 平板 | 失去专注定位 | 主 UI 不暴露通用 App；外部能力通过只读 API/MCP |
| 团队跑偏 | 做模板/画像/市场 | 一周 gate 只看闭环指标和 trace 证据 |

## 18. 交付物清单

本轮交付：
- PRD/研究/软硬件方案：AI_EInk_PRD_Software_Hardware_Solution_v0.3.docx
- Markdown 版本：AI_EInk_PRD_Software_Hardware_Solution_v0.3.md
- UI 视觉稿：ai_eink_ui_wireframes.svg / .png
- 软件架构图：ai_eink_system_architecture.svg / .png
- PCB/硬件概念图：ai_eink_pcb_hardware_concept.svg / .png

下一步若进入执行，应补充：
- 真实屏幕/触控/EMR 候选供应商确认。
- OCR benchmark 数据集。
- 设备功耗预算表。
- 原理图级 BOM 和 EVT test plan。
- Figma 高保真视觉稿与交互原型。

## 参考资料

- [S1] 用户上传计划 — 2026-06-12-002-feat-pdf-annotation-closed-loop-week-one-plan.md。核心闭环、P0/P1/P2/P3 优先级、数据协议、trace、本地存储、周五 gate。
- [S2] reMarkable Paper Pro 官方/支持页 — remarkable.com / support.remarkable.com。11.8 inch color display, reading light, NXP i.MX8 Mini, 2GB RAM, 64GB storage。
- [S3] reMarkable 2 支持页 & Paper Pure 新闻 — support.remarkable.com / The Verge / TechRadar。reMarkable 2 老基线；Paper Pure 2026 新黑白线。
- [S4] Supernote Manta 官方规格 — supernote.eu。10.7 inch flexible E Ink, 1920x2560 300 PPI, microSD, replaceable battery。
- [S5] Amazon Kindle Scribe 商品页 — amazon.com。10.2 inch 300ppi, PDF markup, Active Canvas, AI notebook tools。
- [S6] BOOX Note Air4 C 官方/经销规格 — shop.boox.com / onyxboox.pl。10.3 inch color Kaleido 3, Android 13, 6GB/64GB, frontlight, 4096 pressure。
- [S7] E Ink / Good Display / Waveshare — eink.com / good-display.com / waveshare.com。Gallery 3 刷新信息、10.3 inch panel/模块规格。
- [S8] PaddleOCR / PaddleOCR-VL / Tesseract / ONNX Runtime — PaddleOCR docs/GitHub, arXiv, Tesseract, ONNX Runtime。本地/云端 OCR 和文档解析模型选型。
- [S9] Rockchip / NXP / Qualcomm — rock-chips.com, nxp.com, Qualcomm docs。RK3566/RK3588S/i.MX8M Plus/QCS6490 边缘算力指标。
- [S10] OpenAI API 官方文档 — developers.openai.com / openai.com。Structured Outputs、Responses API、API data controls。
