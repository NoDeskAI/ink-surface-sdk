# InkLoop v1 产品化定位与三端体验

## 产品定位

InkLoop v1 是面向深度阅读和会议思考的标记系统：阅读、会议记录和标注事件本地优先，Web/电脑端外部导入先进入 Cloud Hub，再同步到墨水屏 Library。产品不做通用云盘，不做完整知识库替代品，也不把 AI 聊天框作为主入口。

v1 的核心闭环是：

```text
源文件
-> Web / 电脑端导入先进入 Cloud Hub
-> 墨水屏 Library 出现并按需下载
-> 墨水屏本机 / Wi-Fi 导入先本地可读再补上传 Cloud Hub
-> 墨水屏阅读和思考标记、会议/课堂事件标记
-> Cloud Hub 源文件库、同步、索引和设备状态
-> Obsidian 输出阅读笔记、知识对象和受控编辑状态
-> inkloop:// 回到原文现场
```

一句话定义：

> Web 负责输入，墨水屏负责阅读和思考标记，Obsidian 负责轻量知识输出和受控编辑，Cloud Hub 负责源文件库、同步、索引和设备状态。

## 设计原则

| 原则 | 含义 | v1 取舍 |
| --- | --- | --- |
| 源文件为单位 | 用户看到和管理的是一篇 PDF、EPUB、Markdown、网页或会议资料 | Library、同步、Obsidian note、回跳链接都围绕 `doc_id` |
| 标记不是涂鸦 | 每次划线、圈选、边注、会议标记都进入可追溯事件流 | 不把标注只保存在 PDF 文件里 |
| 极简阅读 | 墨水屏只保留打开、阅读、标记、回屏、同步状态 | 不做复杂文件管理和多层设置 |
| 轻量知识库 | Obsidian 承接整理后的 Reading Note、Highlight、Task、Decision、Risk | 不把 Obsidian 变成全量运行时数据库 |
| 受控回写 | Obsidian 可以改状态、备注、标签、风险等级 | 不自动解析任意 Markdown 或 PDF 涂画 |
| 本地优先 | 墨水屏已下载文件离线可读、可标、可记录，联网后补同步 | Web/电脑端外部导入先入 Cloud Hub；墨水屏本机/Wi-Fi 导入才是本地先读 |
| 会议必做 | 商务和教育场景的会议/课堂事件标记是 v1 主链路 | 不把全量音频、字幕、说话人识别作为 v1 前置依赖 |

## 三端定位

| 端 | 用户目的 | P0 能力 | 不承担的职责 |
| --- | --- | --- | --- |
| Web | 电脑上导入、整理、搜索、批量处理文件 | 拖拽导入 PDF/EPUB/Markdown/网页，管理 Library，打开原文预览，查看同步状态 | 不做沉浸式阅读主体验 |
| 墨水屏 | 阅读、思考、标记、会议/课堂记录 | 打开文档，离线阅读，划线/圈选/手写/星标，会议标记，局域网导入，自动同步 | 不做复杂云盘管理 |
| Obsidian | 长期知识沉淀和轻量编辑 | Reading Note、Highlight、Task、Decision、Risk、Meeting Note、回跳链接、受控状态回写 | 不解析任意 PDF 标注和自由 Markdown 为主标注事件 |
| Cloud Hub | 源文件库、同步、索引、设备协调 | 文档身份、对象存储、事件流、全文索引、设备 manifest、冲突状态 | 不做通用云盘，不替代用户的本地知识库和源文件管理习惯 |

## 源文件模型

源文件是 v1 的产品组织单位。用户不需要理解底层事件、bbox、OCR、sidecar，但系统内部必须稳定记录。

```ts
interface SourceFile {
  doc_id: string;
  title: string;
  mime_type: 'pdf' | 'epub' | 'markdown' | 'html' | 'image' | 'meeting_material';
  content_hash: string;
  revision: string;
  source:
    | 'web_upload'
    | 'eink_lan_drop'
    | 'obsidian_import'
    | 'meeting_attachment'
    | 'web_clip';
  cloud_state: 'local_only' | 'uploading' | 'synced' | 'conflict' | 'failed';
  local_availability: 'not_downloaded' | 'downloaded' | 'pinned';
  created_by_device_id: string;
  created_at: string;
  updated_at: string;
}
```

围绕源文件形成五类派生对象：

| 对象 | 作用 | 示例 |
| --- | --- | --- |
| `DocumentRecord` | 文件身份、版本、来源、hash | 一篇 PDF 或 EPUB |
| `ReadingProgress` | 阅读位置和设备游标 | 第 12 页、最后打开时间 |
| `AnnotationEvent` | 阅读标记事件 | 划线、圈选、边注、星标 |
| `MeetingEventMark` | 会议/课堂事件标记 | 问题、风险、待办、决策 |
| `KnowledgeObject` | 可同步、可投影的知识对象 | Highlight、Task、Decision、Risk |

## Cloud Hub 源文件库

Cloud Hub 是 v1 产品架构里的源文件库和设备协调层，体验上接近 iCloud：一个源文件在云端保存一份，各端按需下载本地副本。它不是通用云盘，也不负责把 Runtime sync 变成文件传输协议。

核心对象：

| 对象 | Cloud Hub 负责 | 本地设备负责 |
| --- | --- | --- |
| `SourceBlob` | 按 `content_hash` 去重保存源文件字节 | 按需下载、校验 hash、离线缓存 |
| `LibraryItem` | 记录某个用户库里有哪些源文件、标题、归属、状态 | 展示 Library 列表、最近打开、置顶和下载状态 |
| `DocumentRecord` | 保存文档身份、版本、文本层处理状态和索引状态 | 维护阅读进度、页面缓存和本地 sidecar |
| `DeviceManifest` | 记录每台设备已有哪些本地副本、同步游标和健康状态 | 启动后拉取 manifest，自动补下载用户需要的文件 |
| `SyncCursor` | 记录事件流和对象投影的增量位置 | 离线写 outbox，联网后补 push / pull |

Library 需要直接展示源文件状态，不让用户理解底层同步机制：

| 状态 | 用户看到的含义 | 系统行为 |
| --- | --- | --- |
| `cloud_only` | 云端有，当前设备未下载 | 点击打开前先下载；也可加入下载队列 |
| `downloading` | 正在下载 | 显示进度，失败后可重试 |
| `downloaded` | 当前设备可离线阅读 | 打开不依赖网络 |
| `pinned` | 保持本地常驻 | 不被缓存淘汰策略清理 |
| `uploading` | 本地导入后正在上传 | 云端不可用时继续本地可读 |
| `conflict` | 文件身份或版本需要确认 | 不静默覆盖，提示用户选择 |
| `failed` | 同步失败 | 保留本地副本和重试入口 |

阶段取舍：

| 阶段 | 要做到 | 可以后补 |
| --- | --- | --- |
| v1 演示闭环 | Web/电脑导入后有 `SourceFile` 身份，墨水屏 Library 能看到并下载或同步到本地 | 完整云端对象存储、跨用户分享、多设备智能缓存 |
| v1 产品架构 | 固定 `SourceBlob / LibraryItem / DeviceManifest / SyncCursor` 契约 | 类 iCloud 的配额、回收站、版本历史和多端冲突 UI |
| 后续增强 | 电脑端 App、Web、墨水屏都围绕同一份云端源文件工作 | 第三方网盘双向同步 |

## 导入体验

### Web / 电脑端外部导入

```text
电脑浏览器打开 InkLoop Web
-> 拖入 PDF/EPUB/Markdown
-> Web 生成上传任务
-> Cloud Hub 建 SourceFile / DocumentRecord / TextLayer / PageMap
-> 墨水屏 Library 出现新文件
-> 墨水屏按需下载到本地后离线阅读
```

Web / 电脑端外部导入必须是 Cloud Hub first。电脑是输入和处理环境，不要求这台电脑先把文件落成本地可读副本；Cloud Hub 创建 `SourceFile / DocumentRecord / manifest / blob` 后，墨水屏通过 Library manifest 看到新文件，再下载到本地。

Web 导入适合文件多、文件大、需要整理标题或批量处理的场景。
网页链接不进入第一版演示闭环；后续需要经网页快照/HTML 转 PDF 服务变成 `SourceFile` 后再进入同一条链路。

### 墨水屏局域网导入

```text
墨水屏打开“Wi-Fi 传文件”
-> 屏幕显示二维码和局域网地址
-> 电脑浏览器打开 http://inkloop.local:8787/?token=...
-> 拖入 PDF/EPUB/Markdown
-> 文件先进入墨水屏本地 Library
-> 后台上传 Cloud Hub
-> Web 和 Obsidian 后续可见
```

墨水屏本机文件选择和 Wi-Fi 局域网导入是 local-first：文件必须先本地可读，云端不可用也不影响阅读和标记；联网后用同一个 `doc_id` 补上传 Cloud Hub。

局域网导入必须满足：

| 要求 | 验收 |
| --- | --- |
| 固定入口 | 同一 Wi-Fi 下通过固定 `http://设备IP:8787/?token=...` 传文件，端口不漂移 |
| 本地授权 | 上传地址必须带设备本地 token，未带 token 或 token 错误不能上传 |
| 不依赖数据线 | 同一 Wi-Fi 下浏览器可传 PDF/EPUB/Markdown |
| 不依赖云端可用 | 云端不可用时仍能导入并阅读 |
| 后台补同步 | 网络恢复后自动上传 Cloud Hub |
| 源文件一致 | 后台上传后使用同一个 `doc_id`，不产生重复文件 |
| 状态极简 | 用户只看到“本地可读 / 同步中 / 已同步 / 失败重试” |

### 两类导入的边界

| 导入入口 | 第一落点 | 用户立即可做 | 后台行为 |
| --- | --- | --- | --- |
| Web / 电脑端外部导入 | Cloud Hub `SourceFile` | 电脑可预览；墨水屏 Library 出现云端文件 | 生成 manifest，墨水屏按需下载本地副本 |
| 墨水屏本机文件导入 | 墨水屏本地 Library | 立即阅读和标记 | 后台上传 Cloud Hub |
| 墨水屏 Wi-Fi 局域网导入 | 墨水屏本地 Library | 立即阅读和标记 | 后台上传 Cloud Hub |

## 同步链路边界

v1 必须把三条链路分开，不能用 Runtime sync 代替文件导入或 Cloud Hub 源文件库。

| 链路 | 处理对象 | 入口 | 不处理 |
| --- | --- | --- | --- |
| Wi-Fi 文件导入 | PDF/EPUB/Markdown 源文件字节 | 墨水屏本机 `InkLoopLanImport`，固定端口 `8787` | 标注事件、Obsidian 回写事件 |
| Runtime sync | 标注事件、阅读进度、会议事件、受控 Obsidian 回写事件 | `/v1/runtime/events:push` 和 `/v1/runtime/events:pull` | 新源文件自动导入、文件字节传输 |
| Cloud Hub 文档同步 | `SourceFile`、`DocumentRecord`、对象存储、设备 manifest | 受用户 session 保护的云端 API | 墨水屏局域网临时上传页 |

当前 demo 代码里的最小 Cloud Hub 落地：

| 能力 | 当前实现 |
| --- | --- |
| SourceFile 上传 | `POST /v1/library/source-files`；Web 外部导入先上传 Cloud Hub，墨水屏 Wi-Fi/本机导入先落本地再后台上传 |
| 设备 Library manifest | `GET /v1/library/manifest`，按 `tenant_id + user_id` 或本地 demo namespace 分桶 |
| 源文件下载 | `GET /v1/library/source-files/:doc_id/blob`，墨水屏点击云端未下载文件后落回本地 Library |
| 本地状态 | IndexedDB `library_sync` 表，只显示“本地可读 / 同步中 / 已同步 / 失败重试”，云端未下载文件显示为待下载 |
| 本地书架收敛 | `pullCloudLibraryManifest()` 会删除云端 manifest 已不存在、且不是本地待上传/失败/同步中的旧 Library 记录，避免测试文件或已移除文件长期留在书架 |
| 重启不丢 | dev/standalone 默认写入 `.inkloop/library`；Runtime sync 写入 `.inkloop/runtime-events.jsonl` |

Runtime sync 的产品级要求：

| 要求 | 验收 |
| --- | --- |
| 地址固定 | 本地局域网 Cloud Hub 固定 `8731`；Web UI 可继续跑 `8765`，但文件库、Runtime sync 和 AI/API 流量默认都打到 `http://<电脑局域网IP>:8731` |
| 用户隔离 | 每次 push/pull 必须带设备 session；服务端按 `tenant_id + user_id` 分桶，A 用户不能拉到 B 用户事件 |
| 设备身份稳定 | 设备已有登录态时使用 session `device_id`；无登录态的 dev 演示才允许本地 stable fallback |
| 后台守护 | Android 启动后保活服务运行，传输/同步期间不依赖用户反复手动打开 APP |
| 本地优先 | 离线标记先写本地 outbox，联网后重试；服务端不可用不能阻断阅读和标记 |
| 不传源文件 | Runtime sync payload 不包含 PDF/EPUB/Markdown 字节 |

## 阅读和思考标记

墨水屏阅读界面只保留最小操作：

| 操作 | 语义 | 结果 |
| --- | --- | --- |
| 划线 | 重点 | `Highlight` 候选 |
| 圈选 | 对象或区域 | `AnnotationEvent` + bbox |
| 手写边注 | 想法、问题、风险 | `note/question/risk` 候选 |
| 星标 | 稍后处理 | `review_later` |
| 一键类型 | Task / Decision / Risk / Question | 直接进入对应 KnowledgeObject 候选 |

阅读体验的关键不是按钮多，而是：

- 打开快。
- 翻页稳定。
- 笔迹低延迟。
- 标记后不打断阅读。
- AI 结果只在需要时出现。
- 离线状态下标记不丢。

### 阅读重排与翻页性能

v1 当前实现可以保留 per-page 本地规则重排作为演示 fallback，但产品级阅读体验不能长期停留在“打开当前 PDF 原页后实时重排，再把这一页拆成 1-2 个阅读页”的结构。这个结构会导致每个原 PDF 页末尾都可能出现空白，翻页时也容易触发布局重算。

目标架构应改为导入/同步阶段预处理：

```text
SourceFile
-> TextLayer / PageMap
-> 规则化 ReflowBlocks（保留 source page / bbox / run ids）
-> 全书连续 VirtualPages 缓存
-> 墨水屏只渲染当前 VirtualPage + 邻近预取页
```

开源参考方向：

| 参考 | 可借鉴点 | 不直接照搬的点 |
| --- | --- | --- |
| KOReader | PDF/电子纸阅读器成熟的页面缓存、PDF reflow、低刷新 UI 取舍；内置 K2pdfopt library 处理扫描 PDF/DjVu 重排 | Lua/C++ 栈较重，不直接进入 WebView 主链路；更适合作为算法和体验参考 |
| libk2pdfopt / K2pdfopt | 面向小屏阅读器的 PDF/DjVu 预处理、裁切、重排、OCR layer；适合导入阶段生成设备友好的派生 PDF 或页面图 | 不是 EPUB/HTML 阅读引擎；输出会成为新的派生文件，必须保存原文 hash、source page / bbox 映射，避免破坏 InkLoop 回跳 |
| MuPDF | 轻量 PDF/XPS/e-book 渲染和转换底座，可作为 PDF 渲染、抽取、页面图生成候选 | AGPL/商业授权要提前评估；直接替换 PDF.js 成本高，先作为 Cloud Hub / Android 端预处理候选 |
| Readium Kotlin Toolkit | Android EPUB/PDF publication 模型、Navigator、分页、搜索、高亮 Decoration API；适合 EPUB/HTML 正统阅读器路线 | 主要是 Kotlin/Android toolkit，不解决 Web 端 PDF.js 当前 UI bug；InkLoop 仍要维护 mark ledger、source bbox、Obsidian 回跳 |
| foliate-js / Readest | Web 技术栈下的 EPUB/HTML 阅读、分页、位置持久化 | 主要面向 reflowable ebook，PDF bbox 标注锚点仍需 InkLoop 自己维护 |
| epub.js | 浏览器内章节渲染、分页和 CFI/位置模型 | 只解决 EPUB/HTML，不解决 PDF 原页坐标和手写回跳 |

当前工程决策：

- Web V1 的“双页、适应页面、适应宽度、百分比缩放”只定义为 PDF 原版页能力；EPUB/Markdown synthetic surface 不再暴露这些 PDF 专属控件，避免用户以为 EPUB 也在走 PDF 双页布局。
- PDF 短期继续用 PDF.js，先保证原版页双页/缩放/标注锚点可用；这条链路是 V1 demo 和 Web 端调试的最小闭环。
- PDF 产品级预处理单独立项评估 K2pdfopt/libk2pdfopt 与 MuPDF：导入后生成 `PreprocessedPdfAsset / PageImage / TextLayer / PageMap / ReflowBlocks`，墨水屏只消费缓存，不在翻页时现场重排。
- EPUB/HTML 产品级阅读单独评估 Readium Kotlin Toolkit：Android 端可用 publication + navigator + decoration API 做原生阅读体验；InkLoop 的标记账本仍以 `SourceFile -> DocumentRecord -> Mark -> KnowledgeProjection` 为主线。
- 所有预处理路线必须保留原始源文件，派生文件只能作为阅读资产；每个派生块要能回到 `source_doc_id / source_page_index / source_bbox / source_run_ids`。

产品验收：

| 要求 | 验收 |
| --- | --- |
| 导入后预处理 | Web / Cloud Hub 导入完成后生成文本层、PageMap 和重排缓存，墨水屏打开时不再现场做完整重排 |
| 连续阅读页 | 重排页按全书连续 virtual page 计数，不再让每个原 PDF 页的最后一屏天然留空 |
| 原文一致性 | 重排文本必须来自规则化文本层，不用 AI 改写原文；预处理后保存文本 hash，并能对比重排前后文本一致性 |
| 翻页性能 | 墨水屏翻页只切缓存页，P50 <= 300ms，P95 <= 800ms；弱设备允许先显示文本、后补标记层 |
| 锚点可回跳 | 每个 ReflowBlock 保留 `source_page_index / source_bbox / source_run_ids`，划线、圈选、手写和 Obsidian 回跳都能回到原文现场 |

短期修复策略：

- per-page reader 只作为 fallback，继续压缩段间距、行距和保护性 spacer，减少底部浪费。
- 只保护图片等不可拆块；AI 旁注和普通段落允许跨 virtual page，避免半屏空白。
- 翻页期间不做动画和重排请求；只使用已缓存的本页 blocks，并预热下一页。
- AI/VLM 重排不得进入阅读主链路，因为它可能改变原文，最多作为诊断或辅助说明。

## Obsidian 输出和受控编辑

Obsidian 接收的是知识投影，不是运行时全量数据。

每个源文件生成一篇 Reading Note：

```text
InkLoop/
  Sources/
    doc_abc.pdf
  Reading Notes/
    某篇论文.md
  Meetings/
    2026-07-02 客户访谈.md
```

Reading Note 结构：

```md
# 某篇论文

Source: inkloop://doc/doc_abc

## Highlights
- 关键观点...
  Source: inkloop://doc/doc_abc?page=12&anchor=ann_123

## Tasks
<!-- inkloop:begin ko_task_001 -->
- [ ] 跟供应商确认刷新延迟
  source: inkloop://doc/doc_abc?page=12&anchor=ann_123
<!-- inkloop:end -->

## Decisions
- MVP 阶段先使用市面低成本墨水屏验证软件闭环

## Risks
- OCR 在低对比 PDF 上不稳定

## 我的自由笔记
这里由用户自由编辑，InkLoop 不解析、不覆盖。
```

### 编辑控制边界

| Obsidian 操作 | v1 行为 |
| --- | --- |
| 修改自由笔记区 | InkLoop 不解析、不覆盖 |
| 勾选 Task | 回写任务状态 |
| 改 Risk 状态/备注 | 回写 Risk/KnowledgeObject |
| 给 Highlight 加标签/评论 | 回写结构化字段 |
| 删除受控区块 | 记录为用户删除，需要确认是否归档 |
| 在 Obsidian PDF 插件里涂画 | v1 不反向解析为 InkLoop 主标注 |
| 任意修改 Markdown 段落 | v1 不自动猜测成新 Highlight/Decision |

这个边界让 Obsidian 变轻：它是知识工作台，不是第三套标注运行时。

## 回跳链接

`inkloop://doc/...` 指向原文现场。

| 点击位置 | 目标 |
| --- | --- |
| 桌面有 InkLoop App | 打开本地 App 到对应文档、页码、标注位置 |
| 没有 App | 打开 Web 到对应文档、页码、标注位置 |
| 墨水屏在线 | 可发送“下次打开此文档”指令 |
| Obsidian 内部 | 保留 source link，方便从知识对象回到原文 |

示例：

```text
inkloop://doc/doc_abc?page=12&anchor=ann_123
https://app.inkloop.ai/doc/doc_abc?page=12&anchor=ann_123
```

## 会议和课堂场景

会议/课堂是 v1 必做场景，但主链路不是全量音频和字幕。

v1 主链路：

```text
MeetingSession 建轴
-> 用户在会中标记 question/risk/action/decision/note
-> MeetingEventMark 落到时间轴
-> 与当前文档、课件、项目记忆 schema 对齐
-> 会后生成 Meeting Note、Task、Decision、Risk、KnowledgeObject
-> 投影到 Obsidian
```

首版接入 `xzq-xu/Lark-Meeting-Timeline` 的开放会议会话协议：`POST /api/meeting-session/start` 建立会议轴，`POST /api/annotations` 和 `POST /api/annotations/batch` 写入会中事件标记。InkLoop 不把 SDK 的转写/妙记能力作为 v1 主链路，只消费会议轴和标记事件，并通过 adapter 转成 `MeetingSession`、`MeetingEventMark`、`SchemaAlignedEvent` 和 `PostProcessContext`。

商务场景：

| 会中动作 | 会后产物 |
| --- | --- |
| 标记问题 | 问题清单 |
| 标记风险 | 风险列表 |
| 标记待办 | Task |
| 标记决策 | Decision |
| 手写补充 | Meeting Note 备注 |

教育场景：

| 会中/课堂动作 | 会后产物 |
| --- | --- |
| 标记不懂 | 复习问题 |
| 标记重点 | Highlights |
| 标记作业 | Task |
| 标记例题 | 知识卡片 |
| 关联课件页 | 回跳到课件原文 |

全量录音、字幕、说话人分离和自动纪要不是 v1 的前置依赖。后续可以作为增强输入进入同一条 schema 对齐链路。

## v1 P0 范围

| 编号 | 能力 | 验收标准 |
| --- | --- | --- |
| P0-1 | Web 文件导入 | 拖入 PDF/EPUB/Markdown 后，墨水屏 Library 可见 |
| P0-2 | 墨水屏局域网导入 | 同 Wi-Fi 通过固定 `8787` + token 地址可传文件，离线可读，联网后补同步 |
| P0-3 | 源文件 Library | 以源文件为单位展示阅读状态、下载状态、同步状态 |
| P0-4 | 墨水屏阅读标记 | 划线、圈选、手写边注、星标不打断阅读 |
| P0-5 | 会议/课堂事件标记 | question/risk/action/decision/note 能落到会议轴 |
| P0-6 | Runtime sync 增量同步 | 标注、阅读进度、会议事件可跨端同步，且按用户 session 隔离 |
| P0-7 | Obsidian Reading Note | 生成 Reading Note、Highlight、Task、Decision、Risk |
| P0-8 | Obsidian 受控回写 | Task 勾选、备注、标签、风险状态可回写 |
| P0-9 | 回跳原文 | Obsidian source link 能打开 Web/Desktop 原文位置 |

## v1 不做

| 不做项 | 原因 |
| --- | --- |
| 通用云盘 | 会稀释阅读和标记主体验 |
| 多云盘双向同步 | 权限、冲突和文件模型过重 |
| Obsidian 任意 Markdown 解析 | 容易误判用户自由笔记 |
| Obsidian PDF 标注反向同步 | PDF 插件格式、坐标和语义不统一 |
| 全量音频/字幕会议纪要 | 权限、隐私、延迟和质量风险高 |
| AI 聊天主入口 | 会偏离“标记即入口”的核心体验 |

## 成功标准

| 场景 | v1 目标 |
| --- | --- |
| 文件进入 | 用户能在 Web 或墨水屏 30 秒内把文件放进 Library |
| 阅读继续 | 墨水屏打开最近文档不需要用户理解同步机制 |
| 标记不中断 | 一次标记后能继续阅读，不出现复杂弹窗 |
| 知识沉淀 | Obsidian 自动出现可读的 Reading Note 和结构化对象 |
| 回到现场 | 从 Obsidian 点击 source link 能回到原文页和标记位置 |
| 会议闭环 | 会中标记能在会后变成任务、决策、风险和复习对象 |
