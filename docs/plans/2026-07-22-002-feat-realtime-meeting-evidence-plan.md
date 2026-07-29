---
title: InkLoop 实时会议事实链与跨平台媒体 Core 落地计划
type: feat
status: active
date: 2026-07-22
origin: docs/brainstorms/2026-07-22-macos-owned-meeting-evidence-requirements.md
---

# InkLoop 实时会议事实链与跨平台媒体 Core 落地计划

## Overview

本计划把最新版会议接入方案落成七个可独立验证的实施单元。首发应用支持 macOS、Chrome Google Meet 与 Zoom macOS 桌面端；会话、统一时钟、双轨分片、ACK/补传、实时转写版本和 Evidence 生命周期进入跨平台 SDK。会议中并行完成本地可靠落盘与流式 ASR，确认会议结束后立即停止，会后只做缺片补传、正式收敛与现有 Postprocess V2 后处理。

## Requirements Trace

- R1. 首次设置后可自动记录受支持会议，不逐场阻塞确认，并始终提供可见状态和停止入口。
- R2. 实体白板上的 InkLoop 白板笔是主板书来源，电子纸是第二来源，两者进入统一 Session Clock。
- R3. Mic 与目标会议应用 Remote 双轨独立保存；AEC/去重只影响派生结果，不覆盖原始事实。
- R4. 已封存分片实时进入 ASR；网络失败不影响本地事实，恢复后按 sequence 补传。
- R5. 明确确认会议结束后立即停止并封存；失焦、后台、静音和短暂断网不得单独触发停止。
- R6. provisional 转写通过稳定 utterance ID 修订，会后增量收敛为 final 或 partial formal Artifact。
- R7. formal Evidence Snapshot 接入 Meeting Postprocess V2，只生成快速纪要 Cards 与可读摘要；完整报告已下线，脑图产物暂缓。
- R8. Google Meet 首发必须把 Live Board、实时字幕与本机摄像头 PiP 合成为可在 Meet 设备选择器中选择的虚拟摄像头；本地预览或屏幕分享不能替代该 Gate。

## Scope Boundaries

- 首发不实现 Windows 媒体采集，但 Core 契约不能依赖 macOS API。
- 首发不训练或托管基础 ASR 模型，使用可替换流式 Provider。
- 实时转写与原始事实链不得依赖虚拟摄像头；但 Google Meet 访谈首发验收必须同时打通虚拟摄像头投影。
- Google Meet / Zoom 自带转写仅作对照或显式兜底，不作为权威事实源。

### Deferred to Separate Tasks

- Windows / Teams：以 Core SDK 的 Platform Adapter 接口作为后续接入点。

## Key Technical Decisions

- **事实与投影分离**：InkEvent、原始双轨和会话事件属于事实；转写、摘要与虚拟摄像头帧属于可重算投影。脑图恢复后也必须保持为独立投影。
- **本地落盘与实时发送双写**：实时链失败不影响事实保存，ACK 只控制发送队列回收。
- **平台 Adapter 薄层**：平台层负责检测、权限、采集与安全存储，生命周期和协议规则由 Core SDK 统一。
- **确认结束立即停止**：Core 只消费 Adapter 给出的 confirmed end evidence，不从失焦、静音等弱信号自行推断结束。
- **版本显式化**：provisional/formal/partial 是结果状态；当前只保留 brief/Cards 与其可读摘要，full report 已下线，mind map 暂缓。
- **Camera Adapter 可替换**：首发 macOS 以官方签名 OBS Camera Extension 承载 Live Board + 摄像头 PiP 合成，验证 Meet 真实设备枚举和远端画面；未来自有 CoreMediaIO Camera Extension 复用同一帧输出契约，不改变事实链。

## Output Structure

    packages/meeting-media-core/
      src/
        contracts.ts
        session-lifecycle.ts
        chunk-delivery.ts
        transcript-assembler.ts
        index.ts
      README.md
      package.json
    native/macos/InkLoopMeetingCompanion/
      README.md
      Sources/
      Tests/
    examples/ai-annotation-demo/server/meeting-media/
      streaming-ingress.ts
      transcript-finalizer.ts
      provider.ts

## Implementation Units

- [ ] **Unit 0: 技术尖峰与验收基线**

**Goal:** 冻结最低 macOS 版本、Meet/Zoom 明确开始/结束信号、目标应用音频隔离、流式 ASR Provider、延迟与重复率基线。

**Files:**
- Create: `docs/reviews/meeting-media-phase0-evaluation.md`
- Create: `native/macos/InkLoopMeetingCompanion/README.md`

**Test scenarios:**
- Meet 与 Zoom 各完成至少 45 分钟的耳机和扬声器测试，记录双轨覆盖、漂移与误停/漏停。
- 断网后本地继续录制，恢复后补传追平且不产生重复 utterance。

**Verification:** 不可行的系统边界有真实设备证据；Provider 与目标 SLO 有可比较数据。

**Progress 2026-07-22:** 已建立 `docs/reviews/meeting-media-phase0-evaluation.md`，并以 90 个 30 秒 chunk/轨完成 45 分钟双轨合成离线重启与补传验收。真实 Chrome Meet / Zoom 的耳机/扬声器矩阵、最低 macOS、目标音频隔离、Provider 对比、权限与签名/公证尚未执行，因此本 Unit 仍是阻塞真实采集发布的 Gate，不能标记完成。

- [x] **Unit 1: 跨平台 Meeting Media Core 契约**

**Goal:** 提供无平台依赖的会话、双轨分片、ACK/补传和 provisional→formal 契约。

**Files:**
- Create: `packages/meeting-media-core/package.json`
- Create: `packages/meeting-media-core/src/contracts.ts`
- Create: `packages/meeting-media-core/src/session-lifecycle.ts`
- Create: `packages/meeting-media-core/src/chunk-delivery.ts`
- Create: `packages/meeting-media-core/src/transcript-assembler.ts`
- Create: `packages/meeting-media-core/src/index.ts`
- Create: `packages/meeting-media-core/src/meeting-media-core.test.ts`
- Create: `packages/meeting-media-core/README.md`
- Modify: `package.json`

**Approach:** 使用可序列化纯状态与显式事件；结束必须携带 confirmed evidence；原始 chunk 不可变；ACK 绑定 session/track/sequence/chunk/checksum；formalize 复用已有稳定 utterance 并验证覆盖。

**Execution note:** 先写状态转换、幂等与缺片场景测试，再实现。

**Test scenarios:**
- 自动或手动开始后进入 recording；confirmed end 立即进入 sealed，不存在倒计时状态。
- 失焦、后台、静音等弱信号不能作为 confirmed end 事件通过校验。
- 同一 chunk 重放幂等，不同 checksum 冲突；乱序 ACK 不会丢弃未确认 chunk。
- 网络恢复后 pending 分片按 track/sequence 稳定排序。
- utterance 同 revision 重放幂等，更高 revision 替换；缺片时只能生成 partial 或拒绝 final。

**Verification:** 包可独立 typecheck；测试覆盖 happy、重复、乱序、缺片和非法状态转换。

**Implemented 2026-07-22:** 已落地纯 TypeScript Core 契约、立即停止状态机、双轨 chunk ACK/补传、sealed per-track sequence manifest 和 provisional→formal 收敛；Core 定向测试、Biome 与根 TypeScript typecheck 通过。

- [ ] **Unit 2: macOS Companion 与 Platform Adapter**

**Goal:** 落地首次设置、会议检测、双轨采集、分段安全落盘、确认结束立即停止和菜单栏状态。

**Files:**
- Create: `native/macos/InkLoopMeetingCompanion/Sources/`
- Create: `native/macos/InkLoopMeetingCompanion/Tests/`
- Modify: `packages/native-bridge/src/index.ts`

**Test scenarios:**
- 权限齐全时检测目标会议后自动开始，确认结束信号到达即停止并封存。
- 权限缺失、磁盘不足或单轨失败时显示降级并保持已封存事实可恢复。
- 崩溃恢复只损失当前未封存的最小分片。

**Verification:** Meet/Zoom 本地测试可产生符合 Unit 1 契约的 manifest 与双轨分片。

**Progress 2026-07-23:** 已创建可 `swift test` / `swift build` 的 Swift Package，落地平台 capability、检测/采集/存储协议、原子双轨分片落盘、自动/手动启动、确认结束立即停止、停止时 sequence manifest、单轨降级、菜单栏状态壳和 Native Bridge 请求。首次授权改为用户显式分项推进，不在窗口加载时叠加 TCC 请求；bundle 可作为前台 App 展示系统权限 sheet，完成后恢复菜单栏模式，并提供各隐私设置页恢复入口。音频回调已增加串行 in-flight barrier：pause/stop 会先停硬件、等待已进入回调的 Mic/Remote 帧按序完成，再封存 pending/tail；持久化失败的 sealed chunk 保留待重试，不再静默丢失。sequence manifest 固定声明 Mic/Remote 两条期望轨，`expected_last_sequence` 使用跨语言稳定的 JSON object 编码，整轨无分片会在服务端成为 `missing_track:*` partial。App 重启会先把历史 `detected/recording/paused` 会话按最后持久化事件封存为 `interrupted_session_recovered`，再补传并触发 formal/partial 收敛，不伪造平台离会证据。25 个原生测试、Core 定向测试通过。真实 Chrome Meet 的三项系统授权尚待用户完成，因而还没有真实 Mic/Remote chunk；Zoom 与 45 分钟矩阵仍后置，本 Unit 尚未完成。

**Progress 2026-07-23（多设备归属）:** 已实现 tenant + provider meeting occurrence 级 recorder lease，绑定认证会话设备身份；Companion 在采集前 claim，10 秒静默续租，chunk 同时续租，formal 后释放，异常后 30 秒接管。其他用户/设备明确持有时本机不启动第二份采集，网络不可达时仅本地保真、无租约不上传。服务端 27 个 Meeting Media 测试与 Companion 38 个测试通过；生产多实例仍需把文件租约迁移到带唯一键/CAS 的协调存储。

**Progress 2026-07-23（删除与离线防复活）:** 整场删除先写 Hub command 墓碑，再级联云端 Media、Runtime Sync、Cloud Knowledge、Provider registry、本地 IndexedDB 与 Companion 原始证据。重复请求返回最新 Companion ACK 状态；并发请求只产生一个 command。Runtime/Knowledge 文档墓碑会拒绝离线设备迟到事件和正在执行的投影写入；Google/Zoom/Lark provider occurrence 墓碑阻止日历同步重建已删卡。删除按 tenant 内已授权 provider occurrence 协调，可覆盖 recorder 属于同 tenant 另一用户的场景；完全离线、从未注册的 Companion 会携带本机 sealed session 的 ref + 时间锚认领命令。相同会议号的周期会议使用六小时时间窗区分场次，删除本次不会阻止未来场次。Meeting Media 34 个测试、Companion 40 个测试与删除相关联合 166 个测试通过。

- [ ] **Unit 3: 实时 Streaming Ingress 与 ASR Provider**

**Goal:** 支持双轨分片实时上传、ACK、重连补传、Provider 路由、provisional delta 和临时媒体删除。

**Files:**
- Create: `examples/ai-annotation-demo/server/meeting-media/`
- Create: `examples/ai-annotation-demo/server/meeting-media/meeting-media.test.ts`
- Modify: `examples/ai-annotation-demo/server/standalone.ts`

**Test scenarios:**
- 分片乱序、重复与断连重放均幂等；ACK 只在服务端持久化成功后返回。
- Provider 超时不影响客户端继续落盘；恢复后增量追平。
- Provider 临时 utterance 修订使用相同稳定 ID，不追加重复文本。

**Verification:** 模拟 45 分钟双轨流可持续处理，并记录实时延迟、错误与成本指标。

**Progress 2026-07-22:** 已完成持久化后 ACK、乱序/重复/冲突、Provider 强制 timeout、持久化指数退避与自动唤醒、慢 Provider 不阻塞上传、稳定 utterance revision、Provider 结果 journal、进程重启 pending 扫描、partial→final 自动收敛和 HTTP 入口。45 分钟双轨合成测试以逆序写入 180 个 chunk，离线重启后追平为 180 个唯一 utterance，尾部覆盖到 45:00。新增隔离的 `smoke:meeting-media-http`：真实 16 kHz mono PCM16 普通话双轨完成 register→ACK→ASR→formal final→raw 自动删除，双轨 ACK 为 4/9 ms、ASR drain 约 1.01 s、formalize 24 ms。实测还发现并修复 outbox identity 错误复制原始音频的体积/隐私问题，收敛后文件由 2.65 MB 降到 508 B，启动会迁移旧数据。本机 `ggml-small` 中文仍有繁体化、错词和替换字符；真实 Meet 音频、Provider 中文质量对比仍需补测，所以保持未完成。

**Progress 2026-07-23（持久性能 telemetry）:** 每个 session 新增旁路 `telemetry.json`，记录服务端注册/首片/最后 ACK 时间、ACK 持久化耗时分布、重放数、pending 峰值、Provider 尝试/失败/超时及耗时、首个 provisional、ASR drain 和 formal 时间；HTTP 提供只读查询，实机会话验收器输出 ACK/Provider p50/p95 与阶段差值。telemetry 文件损坏或写失败不会阻断已经持久化的 raw/outbox/delivery ACK、Provider 或 formal 主链。最新相关定向 41 tests 和接入后 PCM16 smoke 通过。

- [ ] **Unit 4: AEC、跨轨去重与 formal 收敛**

**Goal:** 保留原始双轨，生成可审计的回声/重复派生结果，完成说话人和覆盖校验并产出 formal/partial Transcript Artifact。

**Files:**
- Create: `examples/ai-annotation-demo/server/meeting-media/transcript-finalizer.ts`
- Test: `examples/ai-annotation-demo/server/meeting-media/transcript-finalizer.test.ts`

**Test scenarios:**
- 耳机模式不误删相邻但不同发言；扬声器回采重复只在派生时间线上抑制。
- 低置信冲突保留并标记；原始 chunk 引用始终可回放。
- 覆盖完整生成 final，缺轨或缺片生成 partial 并暴露区间。

**Verification:** 固定双轨样本的残余重复率、误删率、聚类错误率和 provisional→formal 差异可测。

**Progress 2026-07-22:** 已完成原始 utterance 保留、只在 derived timeline 应用外部 assessment、低置信冲突保留、same-track suppression 拒绝、服务端按 sealed sequence manifest 推导内部缺片、缺轨/缺片 partial、finalize fingerprint 幂等与收敛后自动通知。服务端允许“期望轨存在、但整轨没有 sequence 边界”的合法降级 manifest，并输出 `missing_track:*`；若实际已有分片却缺 sequence 边界则拒绝非法 manifest，防止错误 final。真实 AEC/DSP assessment producer、阈值和耳机/扬声器误删率仍待 Unit 0 样本，因此保持未完成。

**Progress 2026-07-23（声学判断与量化验收）:** 已接入 PCM16 声学 assessment producer：只针对 exact-text + 高时间重叠的跨轨候选，比较 50 Hz 短时能量包络并容忍 ±250 ms 延迟；高相关时保留 Remote、仅在 derived timeline 抑制 Mic 回采，声学证据矛盾时显式 retain。判断、来源及输入 fingerprint 在服务端 raw 自动删除前持久化，转写/分片 revision 变化会在原始证据仍在时重算，raw 删除后重放不漂移。formal artifact 新增 dedupe 操作计数；独立标签评估器与实机会话验收器可计算残余重复率、误删率、precision/recall。固定扬声器回采、声学冲突、PCM 缺失、自动删除后重放及 53 项相关 TypeScript tests 通过；真实 Meet/Zoom 耳机/扬声器标签仍是完成 Gate。

- [ ] **Unit 5: Evidence Snapshot 与 Postprocess V2 接通**

**Goal:** 把 formal Transcript、实体白板/电子纸 InkEvent、用户重点和缺失区间接入现有后处理，并增加场景模板版本。

**Files:**
- Modify: `examples/ai-annotation-demo/server/meeting-postprocess/contracts.ts`
- Modify: `examples/ai-annotation-demo/server/meeting-postprocess/evidence-snapshot.ts`
- Modify: `examples/ai-annotation-demo/server/meeting-postprocess/scheduler.ts`
- Test: `examples/ai-annotation-demo/server/meeting-postprocess/*.test.ts`

**Test scenarios:**
- formal Evidence 自动触发 brief；partial Evidence 不伪装完整。
- 自动身份映射、模板或用户引导变化生成新 revision 并使旧报告 stale。
- 脑图暂缓；文本树只保留为历史数据兼容，不再作为可视化脑图生成或展示。
- 旧 full report API 返回 `410 full_report_retired`；历史 queued/running report run 在恢复时取消且不调用模型。

**Verification:** 五份历史会议加双轨样本全部生成可追溯快速结果，零无效 source ref。

**Core postprocess implemented and accepted 2026-07-22:** formal/partial Transcript 已进入 Evidence Snapshot；模板 ID/version 与 `user_supplied` 会后引导参与 fingerprint；配置门持久化“模板已提交 / 转写已收敛”状态，两者齐备才启动正式 Postprocess Run，音频补传和 formal 收敛不因用户选择而暂停；空证据不会调用纪要模型，公开设备入口不能自行宣告 final 或 explicit-partial 已收敛，只有服务端 Media formalizer / Provider worker 可以跨过转写 Gate。产品只生成 Cards 与确定性可读摘要；完整报告的生成器、调度通道、客户端请求与 UI 已移除，旧 API 固定返回 `410 full_report_retired`，遗留 queued/running report run 会在恢复时取消。服务端持久化 occurrence 的 current snapshot/current configuration，模板 A→B→A 可跨重启保持，所有 artifact/run/event 读取强制 occurrence scope，旧 run 发布前做权威校验，部分落盘重试以已存 Cards 为唯一派生输入。客户端可应用高置信 known-participant identity match，低置信度保留稳定匿名标签，不设人工确认 Gate；但仓库目前没有生成 `speaker_cluster_id` 的真实 diarization/聚类生产者，因此不得声称“说话人自动聚类已落地”。历史五场会议已有 V2 真实数据验收，双轨合成 partial/final 接线测试通过；实体白板笔、电子纸和双轨音频进入同一 Session Clock 的真实 E2E 仍缺证据，所以整个 Unit 保持未完成。此前的确定性文本树因不构成真正脑图，已停止生成并从 UI 撤下；旧 report/mind-map schema 仅为历史读取兼容保留。

**Audit 2026-07-23:** 七个 Unit 的证据矩阵见 `docs/reviews/meeting-media-seven-unit-implementation-audit.md`。当前只有 Unit 1 可按完整目标标记完成；Unit 5 的后处理主体已经用户验收，但不能用它掩盖 diarization 生产者和统一板书 Session Clock E2E 的缺失。

- [ ] **Unit 6: 产品体验、隐私生命周期与放量**

**Goal:** 完成首次设置、自动记录状态、实时转写、离线追平、会后详情、删除状态和分阶段 rollout。

**Files:**
- Modify: `examples/ai-annotation-demo/src/mobile/meeting.ts`
- Modify: `examples/ai-annotation-demo/src/mobile/meeting-recap.ts`
- Modify: `examples/ai-annotation-demo/src/mobile/mobile.css`
- Test: `examples/ai-annotation-demo/src/features/meeting/*.test.ts`

**Test scenarios:**
- 自动开始、部分录制、网络中断、立即停止、formal 收敛和删除重试都有明确状态与操作。
- 删除原始音频与删除会议全部派生产物使用不同确认和级联语义。
- VoiceOver 与键盘可访问全部录制控制和模板/用户引导配置。
- OBS 专用场景把 1920×1080 Live Board 与摄像头 PiP 合成；Meet 设备选择器必须出现并选中 OBS Virtual Camera，第二参与端看到相同画面。

**Verification:** 受支持会议端到端路径可后台完成，用户无需守在页面；所有异常均可理解、可恢复或明确降级。Google Meet 还必须保留虚拟摄像头的设备枚举、选中状态和第二端可见证据。

**Progress 2026-07-22:** recap 已显示短卡片、转写 partial 状态和五种场景模板选择；首次正式后处理前展示“模板 + 当场结论 + 最深感受 + 关注痛点”配置，配置状态持久化，刷新后可继续等待后台转写；切换模板/引导基于当前 occurrence 创建新 snapshot/revision，历史结果不覆盖。五模板已升级为 v2 强约束，分别按课堂知识、课堂互动、推理链、访谈证言和可执行会议筛选内容。文本树脑图已撤下，真实可视化方案另行评估。Live Board 可显示 Mic/Remote/ASR/字幕和摄像头授权状态；新增只读实机会话验收器 `accept:real-meeting-media`，统一检查双轨、本地↔服务端序列、ACK、ASR、confirmed end 和 formal/partial。服务端已提供原始媒体独立删除接口并将媒体文件/目录收紧为 `0600/0700`；隐私删除 UI、真实录制状态、权限向导、VoiceOver/键盘实机与 Meet/Zoom 端到端仍依赖 Unit 0/2，因此保持未完成。

**Progress 2026-07-23（异常控制）:** Companion 状态快照新增显式 `captureActive`，菜单栏以真实 capture 生命周期决定是否展示暂停/停止。即使录制中的上传、检测或落盘分支把展示状态切为 error，用户仍保有紧急停止入口；无活跃采集的启动错误不会误显示停止。Swift 40 tests 与本地 app bundle 构建通过。真实 VoiceOver/键盘遍历仍待实机验收。

**Progress 2026-07-23（跨层审查收敛）:** 修复暂停/停止等待 in-flight 音频回调时的 Swift actor 重入覆盖：回调可在 capture transition 中继续把已封存 chunk 写入本地事实，暂停/停止从最新 session snapshot 合并 manifest，不再丢结束边界完整 chunk。Meet 自动结束检测不再把标签切换、应用后台或窗口暂时消失当作确认离会，只接受同一 Meet occurrence 的显式 post-leave UI 状态；若该状态无法可靠识别，保持录制并保留菜单栏立即停止入口。formalize API 现在只接受已注册且 sealed 的 session，并以注册阶段解析出的 canonical `meeting_doc_id` 进入 Postprocess，避免 provider ref 创建重复 occurrence。Provider timeout 会取消底层 ASR HTTP；无 chunk 的终止、启动失败和收敛失败会停止续租并 best-effort 释放 recorder lease。服务端 raw 生命周期终止后，已 ACK chunk 的 Companion 崩溃重放只返回原 ACK，不复活音频；陌生迟到 chunk 返回 410。Companion 持久化本地 formalization receipt，30 秒维护循环会自动补传/收敛离线结束的会话，已完成历史会话不重复抢租约；session scope 注册只发生在 started/paused/resumed/sealed 边界，不再每个 5 秒 chunk 重复请求。Swift 45 tests、Meeting Media/Provider 43 tests、示例 953 tests、根 110 tests、全量 typecheck/lint/build、app bundle 和真实 PCM16 HTTP smoke 全部通过。

**Progress 2026-07-23（Live Board 无障碍基线）:** 实时录制/轨道状态使用克制的 polite live region，避免每条持续修订字幕打断用户；转写列表保留可读语义但关闭逐句 live announcement。画布增加键盘焦点与用途标签，按钮/画布增加高可见 focus ring，并支持 reduced-motion 与 increased-contrast。相关 Live Board 9 tests、TypeScript 与 Biome 通过；真实 VoiceOver 顺序、键盘全链与电纸屏对比仍待实机验收。

**Progress 2026-07-23（Google Meet Camera Adapter）:** 已新增 OBS WebSocket v5 幂等配置器：Live Board Browser Source 只负责板书、字幕和状态；`macos-avcapture` 原生输入负责实体摄像头 PiP，避免 Browser Source、Meet 和 OBS 争抢同一相机。配置器自动排除 OBS Virtual Camera 回环，优先选择指定/内建 Mac 相机和 1080p/720p preset，固定 1920×1080@30 场景层级与 PiP 位置，并在机器报告中回读 input settings、scene transforms、相机 video active 与 virtual camera active。一键 launcher 会保存用户原 OBS WebSocket 配置、用随机密码和 IPv4 localhost 临时启动控制面，配置完成后原样恢复并关闭端口，再以持久场景启动虚拟摄像头。相关 15 个定向 tests、TypeScript、Biome 与 Vite build 通过；OBS Camera Extension 系统批准、Meet 设备选择和第二端画面仍因实机锁屏为 pending，不能标记本 Unit 完成。

## System-Wide Impact

- **Interaction graph:** macOS Adapter → Core SDK → Streaming Ingress → ASR/Finalizer → Evidence Snapshot → Postprocess V2 → UI。
- **Error propagation:** 实时错误降级为本地继续记录；事实写入错误立即暴露；删除错误独立重试且不阻塞纪要。
- **State lifecycle risks:** chunk/ACK、transcript revision、snapshot fingerprint 和 Artifact revision 必须分别幂等。
- **Unchanged invariants:** SDK 根入口保持无副作用；Meeting Postprocess V2 的快速纪要、历史数据读取和用户编辑保护语义不回退。

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Chrome Meet 无法隔离单标签音频 | Phase 0 先验证应用级范围，必要时再评估浏览器扩展 |
| 双轨出现回声和重复 | Remote 作为 AEC 参考，分轨 ASR 后二次去重，原始轨不覆盖 |
| 自动结束误停 | 只接受平台 Adapter 的 confirmed end evidence，并记录信号用于评测 |
| 流式 Provider 不稳定或锁定 | Provider Adapter、ACK/补传与本地事实源解耦 |
| Core 过度抽象 | 只抽象稳定数据生命周期，平台能力通过显式 capability 声明 |

## Sources & References

- **Origin:** `docs/brainstorms/2026-07-22-macos-owned-meeting-evidence-requirements.md`
- **Technical baseline:** `docs/project/inkloop-ai-pen-kickstarter/source/InkLoop_NoDeskAI_会议接入与自有事实链技术方案_V1.md`
- **Existing postprocess:** `examples/ai-annotation-demo/server/meeting-postprocess/`
- **Runtime contracts:** `packages/runtime-schema/src/index.ts`
- **Native bridge pattern:** `packages/native-bridge/src/index.ts`
