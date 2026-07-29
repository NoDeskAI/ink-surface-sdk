# Meeting Media 七个 Unit 真实实现审计

状态：`implementation_audited_real_e2e_pending`
审计日期：2026-07-23
审计分支：`codex/postprocess-pipeline-analysis`

## 1. 审计口径

本审计不把接口、类型、类名、Prompt、合成 fixture 或 mock 测试单独视为“功能已经落地”。

| 等级 | 判定标准 |
| --- | --- |
| 完成 | 生产路径代码、跨层测试和计划要求的真实端到端证据均存在 |
| 核心实现，未完成实测 | 真实生产路径已接线，自动测试通过，但目标 Meet/Zoom/设备/长时场景尚未达到验收条件 |
| 半实现 | 只有目标能力的一部分真实工作，仍缺关键生产者、算法或跨层接线 |
| 契约/测试桩 | 只有 schema、接口、消费者、mock 或合成测试，没有真实生产者 |
| 未实现 | 仓库中没有对应生产路径 |

当前正在运行的 Companion 和 Meeting Media 服务启动于本轮修复之前，没有加载本轮新代码。本审计因此把新链路记为“代码和自动测试通过”，不冒充当前 Meet 会话已经完成实测。

## 2. 四项实时转写修复

| 修复 | 已落地内容 | 可执行证据 | 当前边界 |
| --- | --- | --- | --- |
| 服务端噪声/幻觉门控 | Whisper `no_speech_prob`、常见字幕幻觉、病态重复、异常字速过滤；Sherpa 解码前自适应 VAD | `provider.test.ts` 的静音、底噪、字幕幻觉、重复和 decoder gate 测试 | 真实多人 CER/WER 尚无人工标注；不能仅凭规则过滤宣称质量通过 |
| Realtime ASR 默认链 | 本地默认已冻结为 Whisper Large V3 Turbo Q5 buffered projection：首次 8 秒、修订 8 秒、最大上下文 20 秒；稳定 utterance ID/revision，20 秒到点立即 flush | Provider/Ingress 的窗口、修订、静音、重复帧和 durable gap fallback 测试；7.5 分钟真实 Mic 原始 PCM 的 4/8/12 秒离线 A/B | 这是累积窗口反复调用 HTTP `/inference`，不是真正持久 decoder 的 streaming ASR；8 秒配置首条约 9–11 秒，仍不是飞书/Typeless 级实时体验 |
| macOS Mic 派生语音增强和双轨健康监控 | 原始 Mic 连续 PCM 不做客户端能量 VAD、增益或硬裁；实时 ASR 单独尝试 Apple Voice Processing IO，成功后才原子切换，失败继续 raw projection；Mic/Remote 15 秒 callback watchdog 写入 `audio_callback_stalled` | Companion 62 tests；derived projection 不进入 5 秒事实块、raw fallback 不产生 sequence gap、选择器切换、上传排序和 watchdog 均有测试；服务端 telemetry 记录 `audio_derivation` | 代码与自动测试通过，但还没有真实扬声器/耳机矩阵证明 Apple Voice Processing 实际启用、AEC 误删率可接受；DJI Mic 切换、拔插和丢轨恢复尚未实测 |
| 会后 formal 重新识别收敛 | outbox 清空后按 track/sequence 重放原始 PCM；formal Artifact 持久化后才删除云端 raw；raw 删除后 replay 直接复用已存正式 Artifact，不退回 provisional | formal converger、raw-before-delete、raw-delete replay fingerprint 测试；历史会话重放 | 历史重放仍出现可疑短句；没有人工标注 CER/WER，不能判定质量 Gate 已过 |

本轮还补上了四个跨层边界：

1. Mic realtime 不再由客户端能量阈值判定并硬裁；连续 PCM 交给服务端 Silero VAD/Whisper，避免高底噪下裁掉句首、辅音和停顿。
2. Apple Voice Processing 只生成临时 ASR projection，原始 Mic 事实块保持未处理；实际模式通过 `audio_derivation` 进入 telemetry/验收报告。
3. callback 边界不再等于 ASR 句子边界，Whisper 在 8/8/20 秒窗口中保留上下文并修订同一 utterance。
4. Companion 在上传 5 秒事实块前等待同轨 realtime projection 完成；服务端只有在实时覆盖完整且无 frame gap 时才跳过 durable ASR 回补。

### 7.5 分钟真实会话 ASR 诊断

会话：`session-asr-diagnostic`（真实 ID 已脱敏）

- Remote 约 450 秒、99.79% 样本为零，因此本场转写质量差不是双轨重复导致。
- Mic 约 450 秒，无削波，但底噪高：RMS `-28.93 dBFS`，20 ms 帧 p10 `-40.96`、p50 `-33.50`、p90 `-25.45`。
- 旧 Sherpa realtime：98 utterances / 418 revisions / 约 1,400 字，多碎句；旧 Sherpa formal：58 utterances / 约 1,924 字。
- Whisper formal 重放：273 个原始 segment 只按短间隔与句末边界归并为 32 个 utterance / 2,133 字，约 40 秒完成；归并不改识别文字。
- 4/8/12 秒 A/B 中，8 秒窗口为当前延迟/请求数折中：首条约 9.6–11.3 秒、66 次请求、平均 3 revisions/窗口；12 秒更省请求但首条约 13.8 秒，4 秒首条约 5.6 秒但请求数 110、抖动更高。
- 没有人工逐字真值，Sherpa/Whisper disagreement 不是 CER/WER，不得据此宣称质量 Gate 通过。

### 历史真实会话重放

会话：`session-long-meeting`（真实 ID 已脱敏）

- Google Meet，封存状态，确认离会后同一 monotonic timestamp 立即停止。
- 总时长 4,926,463 ms（约 82 分 06 秒）。
- 原始双轨共 1,234 个 chunk：Mic 248、Remote 986。
- Mic 只覆盖约前 20 分 44 秒，之后约 61 分钟没有 Mic chunk，旧版也没有写 `audio.track.unavailable`；本轮 watchdog 针对的是这个可观测性缺口，但尚未用新会话验证。
- Sherpa formal replay 用时 17,250 ms，产出 33 个候选；已知“中文字幕志愿者”类幻觉为 0。
- Mic 246–247 仍产出 `你的那个也有是这`，所以真实质量结论仍是“改善明显，未达到发布质量 Gate”。

原始验收输出保存在忽略目录 `examples/ai-annotation-demo/tmp/formal-convergence-0945933E.json`，不进入 Git。

## 3. 七个 Unit 总览

| Unit | 当前状态 | 是否可对外称完成 | 核心结论 |
| --- | --- | --- | --- |
| Unit 0 技术尖峰与验收基线 | 未完成 / 发布阻塞 | 否 | 四个 45 分钟 Meet/Zoom × 耳机/扬声器矩阵、生产 Provider、最低 macOS、签名公证仍未完成 |
| Unit 1 跨平台 Core 契约 | 完成 | 是，限 Core 范围 | 纯 TypeScript 会话、双轨、ACK、补传、实时帧、formal/partial 契约和验证已落地 |
| Unit 2 macOS Companion / Adapter | 核心实现，实测未完成 | 否 | 真实 Meet 双轨曾工作，但暴露 Mic 长时间消失；新版 watchdog 和 Mic projection 尚未新会话验收，Zoom 未测 |
| Unit 3 Streaming Ingress / ASR | 核心实现，质量 Gate 未过 | 否 | ACK/outbox/retry、buffered Whisper realtime、formal raw replay 与诊断工具已接线；真实会话已离线 A/B，但新运行链尚未验收 |
| Unit 4 AEC / 去重 / formal | 半实现 | 否 | Apple Voice Processing 派生分支、formal 和声学去重真实存在；真实 AEC 矩阵与说话人聚类生产者不存在 |
| Unit 5 Evidence Snapshot / Postprocess | 后处理主体已验收，整体仍有输入缺口 | 只能称后处理主体完成 | 五场历史会议 Cards/摘要已验收；自动说话人聚类及实体板书/电子纸统一时钟 E2E 没有落地证据 |
| Unit 6 产品体验 / 隐私 / 放量 | 半实现 | 否 | 关键 UI、删除、OBS 虚拟摄像头已实现；Zoom、无障碍实测、发行和多实例生产存储未完成 |

## 4. Unit 逐项证据

### Unit 0：技术尖峰与验收基线

结论：**未完成，仍是发布阻塞 Gate。**

已经真实发生：

- OBS Camera Extension 当前为 `activated enabled`。
- OBS `InkLoop Interview` 场景和虚拟摄像头正在运行。
- 用户已经用第二参会端确认：Meet 本机自预览镜像，但远端收到正向画面。仍应把截图/设备枚举状态固化为发布证据包。
- 已有一场约 82 分钟 Google Meet 原始双轨会话，可用于故障复盘和 formal replay。

仍未完成：

- Chrome Meet：耳机 45 分钟、扬声器 45 分钟。
- Zoom macOS：耳机 45 分钟、扬声器 45 分钟；本机当前未安装 Zoom。
- 每格的 Mic/Remote 覆盖、长期漂移、误停/漏停、重复率、误删率。
- 最低 macOS 真实发布验证；`Package.swift` 的 macOS 13 只是编译下限。
- 至少两种生产 Streaming ASR/diarization Provider 的中文、英文、中英混合、多人和噪声 CER/WER 对比。
- Developer ID 签名、公证、升级、权限保留和撤销恢复。当前 App 是 `AhaKey Local Dev`，`TeamIdentifier=not set`。

### Unit 1：跨平台 Meeting Media Core

结论：**完成，限平台无关 Core 范围。**

真实代码：

- `packages/meeting-media-core/src/contracts.ts`
- `session-lifecycle.ts`
- `chunk-delivery.ts`
- `session-manifest.ts`
- `transcript-assembler.ts`

覆盖能力：

- confirmed end 立即封存，弱信号拒绝；
- 不可变双轨 chunk、checksum 冲突、ACK、pending/replay；
- sealed sequence manifest 与 partial 缺片；
- provisional stable ID/revision 和 formal 状态；
- realtime frame 明确区分 speech、silent coverage 和 server-VAD projection。

证据：Core 19 tests、根 TypeScript check 和 Biome 通过。

### Unit 2：macOS Companion 与 Platform Adapter

结论：**核心实现，未通过目标实机矩阵。**

真实生产路径：

- Chrome Meet / Zoom 窗口检测和弱结束信号拒绝；
- AVAudioEngine Mic 独立轨；
- ScreenCaptureKit 目标应用 Remote 轨；
- 16 kHz mono PCM16、5 秒不可变事实 chunk、原子本地落盘；
- 低延迟 realtime frame 派生；
- ASR 派生 Mic 可使用 Apple Voice Processing，失败时保持连续 raw fallback，原始事实轨不被覆盖；
- pause/stop in-flight barrier、崩溃恢复、ACK sidecar；
- recorder lease、离线本地保真、后台补传；
- 菜单栏状态、权限向导、暂停和紧急停止。

实测缺口：

- 82 分钟历史会话中 Mic 在 248 个 chunk 后消失约 61 分钟；旧版没有 unavailable event。
- 新 watchdog 能报告 callback stall，但没有自动重建 AVAudioEngine 或完成设备切换恢复。
- 外置 DJI Mic、运行中拔插、默认输入设备变化尚未测试。
- Zoom 未安装、未采集过真实 Zoom Remote 轨。
- 磁盘不足、权限运行中撤销、睡眠/唤醒仍缺真实故障注入证据。

证据：Companion 62 tests 通过；历史会话不是新版质量通过证明。

### Unit 3：Streaming Ingress 与 ASR Provider

结论：**核心实现，新 realtime 链尚未在真实会议中验收。**

真实生产路径：

- raw、delivery、outbox 持久化后才 ACK；
- 重复、乱序、checksum 冲突、Provider timeout/backoff/restart recovery；
- per-track realtime endpoint 与 recorder lease；
- 本地默认 buffered Whisper Large V3 Turbo Q5 的 8/8/20 秒窗口、stable utterance revision；
- Sherpa Streaming Paraformer 持续 decoder 仍作为真正 streaming 的可替换开发 Provider，而非当前质量默认；
- realtime coverage 和 durable gap fallback；
- telemetry、formal replay、raw 删除生命周期。

没有完成：

- 当前运行服务未加载本轮代码。
- 新运行进程的真实首字延迟、稳定文本延迟、frame loss 和恢复追平没有数据；离线 A/B 首条仍约 9–11 秒。
- 生产 Provider 没有冻结；本地 buffered Whisper 只是质量开发候选。
- 文件 outbox/transcript 是多个原子文件，不是跨文件事务；只支持单 active writer/worker。
- 生产多实例缺数据库唯一约束、CAS/lease 和事务。

证据：Provider + Meeting Media/诊断定向 72 tests；45 分钟双轨合成恢复测试通过。合成测试不替代实机。

### Unit 4：AEC、跨轨去重与 formal 收敛

结论：**半实现。**

已经真实实现：

- 原始 utterance 永久保留，抑制只作用于 derived timeline；
- exact-text、高时间重叠、PCM 能量包络和 ±250 ms 延迟的声学相似度判断；
- 低置信冲突保留；
- formal raw replay、final/partial、missing track/chunk；
- raw 删除前持久化 duplicate assessment 和 fingerprint；
- raw 删除后 formal replay 幂等。

只有契约/消费者、没有真实生产者：

- `speaker_cluster_id` 可以被 Provider 输入并被后处理消费；
- `speaker_identity_matches` 可以应用高置信姓名；
- **仓库里没有对原始 Remote 音频执行 diarization / speaker embedding / clustering 的生产实现**。

代码已实现、实机未通过：

- macOS realtime Mic 派生分支启用 Apple Voice Processing IO，系统不支持或启动失败时回退 raw；原始 Mic 事实轨不变。尚未在扬声器/耳机与多种输入设备下证明 AEC/降噪效果和误删率，所以仍不能对外称 AEC 完成。
- 当前 formal“声学 AEC”仍只是 ASR 后 exact-text 候选的跨轨去重，不等于波形 AEC。
- 真实耳机/扬声器阈值、误删率和残余重复率没有人工标签。
- 真实 speaker 聚类错误率不可测，因为聚类生产者不存在。
- 历史 formal replay 仍有可疑短句，CER/WER Gate 未过。

### Unit 5：Evidence Snapshot 与 Postprocess V2

结论：**后处理主体已由用户验收，但整个 Unit 不能按原目标标记完全完成。**

已完成并有真实历史数据：

- formal/partial Transcript → Evidence Snapshot；
- 模板和用户会后引导进入 fingerprint；
- 配置已提交 + 转写已收敛后自动运行；
- Cards + 确定性可读摘要；
- 完整报告下线，旧 API 返回 `410 full_report_retired`；
- 文本树脑图撤下；
- 五份历史会议冷启动成功率 5/5、重试率 0%，证据引用全部有效；
- 365 条和 161 条长会在生产预算下分别约 45.2 秒和 44.9 秒。

需纠正的计划陈述：

- 原计划写“说话人由系统自动聚类”，实际只有 identity match 应用和稳定匿名标签，缺少聚类生产者。
- Evidence Snapshot 可以接收 handwriting/OCR，但还没有一场“实体白板笔 InkEvent + 电子纸 InkEvent + 双轨音频”在同一 Session Clock 下贯穿 formal 和后处理的真实 E2E 证据。
- 会议手写证据当前主要通过 meeting note mark/OCR 汇入；这不等于实体白板硬件事实链已经验证。

已知非本轮阻塞：

- Interview Archive 当前规范和实现均为八章，测试也期待“八、归档说明”；这是已对齐状态，不再是 8/9 章漂移。

### Unit 6：产品体验、隐私生命周期与放量

结论：**半实现。**

已经真实实现：

- Companion 权限向导、菜单栏状态、暂停、停止、错误时保留紧急停止；
- Live Board 的 Mic/Remote/ASR/Camera 状态和 provisional 字幕；
- 模板、当场结论、最深感受、关注痛点配置；
- recap 中“仅删除原始音频”和“删除整场会议”两个独立动作；
- Hub 删除 command、离线防复活、Companion 删除 ACK；
- OBS Camera Extension、`InkLoop Interview` 场景、Live Board + Camera PiP；
- 基础 ARIA、focus ring、reduced motion 和 increased contrast。

仍未完成：

- 新实时 ASR 的网络中断、恢复、partial、错误提示没有新版实机会话验收。
- VoiceOver 阅读顺序和完整键盘遍历没有真实执行记录。
- Zoom 端到端无。
- 多设备 recorder lease 只有自动测试，没有真实两台已登录设备竞争/接管证据。
- 用户验证过 Meet 远端方向，但设备枚举、选中状态、第二端画面应形成可复用发布证据包。
- 正式签名、公证、自动更新和发布回滚未完成。
- 文件存储/单进程锁不能用于生产多实例放量。

## 5. 当前仍属“占位、契约或承诺”的功能

以下能力不得对用户或验收方称为已实现：

1. 自动说话人 diarization / 聚类。
2. 真实验证通过的 AEC；Apple Voice Processing 派生分支已有代码，仍缺耳机/扬声器误删率、回声残留和设备兼容矩阵。
3. Zoom 真实双轨录制、实时转写和结束检测。
4. 实体白板笔、电子纸、双轨音频统一 Session Clock 的真实完整闭环。
5. 生产 Streaming ASR/diarization Provider 选型及质量 SLO。
6. 真实多机 recorder ownership 与故障接管。
7. 生产多实例存储、事务和协调租约。
8. Developer ID 签名、公证与正式分发链。

以下不是占位：

- Core 契约和状态机；
- macOS AVAudioEngine / ScreenCaptureKit 双轨采集；
- 本地不可变原始 chunk 和 ACK/补传；
- Meeting Media 服务端持久 outbox；
- OBS 官方 Camera Extension 和实际虚拟摄像头；
- Postprocess V2 Cards/摘要和五场历史会议结果；
- 独立 raw 删除与整场删除控制面。

## 6. 下一阶段真实验收顺序

1. 重建并显式重启新版 Companion / Meeting Media，在一场短 Meet 中先验证：Mic `audio_derivation`、Remote server VAD、首字、稳定 revision、静音零字幕、双轨 callback watchdog。
2. 用第二账号/设备固化 Meet：设备枚举、OBS Virtual Camera 选中、远端正向文字、Mic/Remote 双轨、confirmed end 立即停止。
3. 完成 Meet 耳机和扬声器各 45 分钟，人工标注转写和跨轨重复样本。
4. 安装 Zoom，完成同样两格。
5. 再决定 AEC、diarization 和生产 Provider：不能在没有误删率、CER/WER 和聚类错误率数据时冻结算法。
6. 补实体白板笔 + 电子纸 + 双轨音频的统一 Session Clock E2E。
7. 最后处理签名、公证、多实例存储和 rollout。

## 7. 本轮验证结果

- Core：19 tests passed。
- Provider + Meeting Media/ASR 诊断定向：72 tests passed。
- macOS Companion：62 tests passed。
- 示例应用全量：992 tests passed。
- 根仓库：15 files / 112 tests passed。
- `npm run check`：passed。
- `npm run lint:ci`：passed。
- `npm run build`：passed。
- `git diff --check`：passed。
- 82 分钟历史会话 formal replay：1,234 chunks → 33 candidates，17,250 ms；固定字幕幻觉 0，仍保留 1 条需人工复核的可疑短句。

这些结果证明本轮代码回归，不替代第 6 节的真实验收。
