# Meeting Media Phase 0 实机验收记录

状态：`blocked_on_real_device_and_provider`
更新：2026-07-23

这份记录用于冻结 macOS 首发的真实系统边界。合成测试只能证明 Core、落盘、ACK、补传和幂等契约，不得替代 Meet/Zoom、耳机/扬声器、权限、签名和真实 ASR Provider 验收。

## 当前已验证

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Core 会话状态、立即停止、弱信号拒绝 | 通过 | `packages/meeting-media-core/src/meeting-media-core.test.ts` |
| 双轨 chunk 校验、持久化后 ACK、乱序和重复 | 通过 | `server/meeting-media/meeting-media.test.ts` |
| Provider 失败不阻塞后续录制 | 通过 | `does not block a later ingest while the provider request is pending` |
| Provider 超时、持久退避与自动重试 | 通过 | ingress 强制 deadline；outbox 持久化 `attempts/next_attempt_at_ms`，单会话 single-flight 定时唤醒 |
| 45 分钟双轨合成重放 | 通过 | 90 个 30 秒 chunk/轨，共 180 个 chunk；逆序落盘、模拟离线重启、追平后 180 个稳定 utterance、零重复、尾部到 45:00 |
| formal/partial 缺片边界与自动收敛 | 通过 | sealed sequence manifest 可识别 0/2 间的 1；Provider 追平后自动重算并幂等通知 Postprocess |
| macOS Package 状态机与原子分片存储 | 通过 | 25 个 Swift tests；停止时输出跨语言 JSON `sequence-manifest.json`；回调按序 drain、失败分片重试和 stop tail 已覆盖；重启会将未封存会话按最后持久化边界标为 `interrupted_session_recovered`，补传并收敛为 partial/final；真实采集仍待授权 |
| 原始媒体本地权限与独立删除 | 通过 | 服务端目录 `0700`、文件 `0600`；session raw media 可独立删除且保留派生状态 |
| 本地真实 ASR 开发链 | 通过（明日访谈本机候选，非最终生产选型） | macOS 26.5.1 / Apple M4 Pro；同一 6.657 秒普通话样本中，`ggml-small` 用时 6.66 秒且把“实时”错成“实实”，`ggml-large-v3-turbo-q5_0` 用时 1.59 秒且整句正确，快约 4.2 倍。今晚本地链默认切到 turbo-q5；真实多人访谈仍需继续记录 CER/WER、首字延迟和长会稳定性。 |
| 7.5 分钟真实 ASR 诊断与窗口 A/B | 诊断完成，质量 Gate 未过 | 会话 `session-asr-diagnostic`（真实 ID 已脱敏）：Remote 约 450 秒且 99.79% 为零；Mic 无削波但 RMS `-28.93 dBFS`、20 ms 帧 p50 `-33.50 dBFS`。旧客户端能量 VAD/硬裁和 Sherpa 配置漂移会共同造成碎句与上下文丢失。4/8/12 秒 buffered Whisper A/B 后，本地默认冻结为 8 秒首次窗口 / 8 秒 revision / 20 秒最大上下文；首条仍约 9–11 秒。formal Whisper 273 个原始 segment 只按相邻短间隔归并为 32 个 utterance / 2,133 字，约 40 秒；无人工真值，不得称 CER/WER 通过。 |
| macOS ASR 派生 Voice Processing | 代码与自动测试通过，实机 AEC 待测 | 原始 Mic 事实轨保持连续原始 PCM，不做客户端能量 VAD、增益或硬裁；第二个 AVAudioEngine 仅为 realtime ASR 尝试 Apple Voice Processing，成功后才原子切换，失败持续 raw projection。`audio_derivation` 进入服务端 telemetry/验收报告。Companion 62 tests 通过；仍需耳机/扬声器、内置/DJI Mic 证明真实启用、回声残留和误删率。 |
| PCM16 真实 HTTP 闭环 | 通过 | `npm run smoke:meeting-media-http` 使用 6.657 秒普通话 TTS、16 kHz mono PCM16 同时上传 Mic/Remote；turbo-q5 最新结果为注册 3 ms、ACK 5/11 ms、双轨 ASR drain 3.023 s、formalize 25 ms；2/2 Provider completed、零缺片、final、派生时间线完成跨轨重复抑制，云端 raw 自动删除，转写全文正确。 |
| 多设备/多参会者 recorder ownership | 协议与客户端通过，真实多机待测 | 同一 tenant + provider meeting occurrence 只授予一个 30 秒 recorder lease；登录会话绑定设备身份，10 秒静默续租、chunk 续租、结束释放、超时接管。明确冲突设备不启动采集；网络不可用时仅本地保真，未拿到租约不上传。服务端并发/跨用户/跨 tenant 测试与 Companion 测试通过 |
| 整场删除与离线防复活 | 通过（控制面与持久层） | command 先持久化、并发幂等、实时 ACK 状态；Runtime/Knowledge、Provider occurrence 和本地 IndexedDB 都保存墓碑。tenant 内另一用户 recorder 与从未注册的离线 Companion 可按 ref + 场次时间锚完成级联；周期会议未来场次不误删。相关 TypeScript 联合 166 tests、Companion 40 tests 通过 |
| 删除命令升级兼容 | 通过 | 旧版 user-scoped `.meeting-deletions` 会在首次删除/查询/Companion 轮询前原子迁入 tenant scope，保留 command ID；目标文件落盘后才清除旧副本，meeting doc 文件名冲突不会覆盖历史命令。Meeting Media 36 tests 通过 |
| Provider 元数据体积 | 通过 | 实测发现旧 `provider-outbox.json` 将整个 ingest 对象错误写入 identity，双轨 213,046 B PCM 会膨胀到 2.65 MB，且 raw 删除后仍残留音频副本；已收紧为 tenant/user scope，并在启动恢复时自动迁移旧 outbox，同样 smoke 收敛后为 508 B |
| AEC/跨轨去重审计链 | 实现通过，真实阈值待标定 | 对 exact-text + 高重叠候选读取 16 kHz mono PCM16 短时能量包络，允许 ±250 ms 时延并以 Remote 为参考；声学高相关才抑制 Mic 回采，矛盾样本显式 retain，原始 utterance 永久保留。判断及输入 fingerprint 在 raw 自动删除前持久化；formal artifact 暴露 suppressed/retained/rejected/external/inferred 计数，并可用人工标签计算残余重复率、误删率、precision/recall。固定扬声器回采/不同声学样本、自动 raw 删除后重放测试通过；真实耳机/扬声器阈值仍待下方矩阵。 |
| Session 性能 telemetry | 通过（旁路可观测性） | 每个会话持久记录服务端首片、ACK 持久化耗时、队列峰值、Provider 尝试/失败/超时与耗时、首个 provisional、ASR 追平、formal 时间；`accept:real-meeting-media` 输出 p50/p95 和阶段差值。telemetry 损坏或写失败严格旁路，不影响音频 ACK、ASR 或 formal。Meeting Media 38 tests 通过。 |
| Companion 首次权限编排 | 实现通过，系统授权待用户完成 | TCC 请求改为显式分项推进，不再在窗口加载时串行阻塞；App 以 foreground-capable bundle 启动，未完成设置时使用 regular activation policy；每项提供系统设置恢复入口。Swift 19 tests 与本地签名 app 构建通过 |
| Google Meet Live Board | UI/连接通过，真实媒体待测 | `meeting-live-board.html` 已在 Chrome 实机打开；服务端鉴权 Live Status、Runtime InkEvent、Mic/Remote/ASR 状态与字幕 rail 正常；没有真实 chunk 时明确显示 `No active session`，不误报正在录制。OBS 投影模式只渲染 Board/字幕，由 OBS 原生 macOS 相机源叠加 PiP，避免 Chrome/Meet/OBS 争抢物理摄像头。 |
| Meet 镜像与静音字幕实机诊断 | 本机自预览边界确认；用户已用第二参会端确认远端方向正常；静音幻觉已止住 | `meet-mirror-validation`（真实会议码已脱敏）单人会议中，Meet 把包含 Live Board 的整个本机摄像头自预览左右镜像；OBS Program/场景源保持 `scaleX=1`，因此不得翻转发送流。Companion 已增加教师正向监看入口。Remote 原始 PCM 为全零，但 Whisper 曾在 `remote:0..130` 幻觉固定字幕；Provider 的确定静音拒绝生效后，至少 `remote:131..389` 连续 259 个静音分片完成 ACK/ASR drain 且零新增 Remote utterance。当前测试会话只清除了 262 条由全零 PCM 派生的 Remote 字幕，以及 4 条可复现的固定 Provider 幻觉文案；原始分片、ACK 与清理审计均保留。 |
| 82 分钟 Meet 原始事实复盘 | 真实双轨存在，但 Mic 覆盖失败 | 会话 `session-long-meeting`（真实 ID 已脱敏）共 4,926,463 ms、1,234 个 chunk：Mic 248、Remote 986。Mic 只覆盖约前 20 分 44 秒，之后约 61 分钟没有 Mic chunk，旧版也没有 `audio.track.unavailable`。本轮已增加 15 秒 callback watchdog，但尚未用新会话验证恢复和告警。 |
| Sherpa formal 历史重放 | 改善明显，质量 Gate 未过 | 同一会话 1,234 个原始 chunk 在 18,242 ms 内重放为 33 个 formal 候选；已知“中文字幕志愿者”幻觉为 0，但 Mic 246–247 仍产出可疑句“你的那个也有是这”。没有人工标注 CER/WER，不得宣称生产质量通过。 |
| 实机会话自动验收 | 通过（工具链） | `npm run accept:real-meeting-media -- --session latest` 读取本地与服务端证据，检查双轨、序列、ACK、ASR、finality 和立即停止；真实报告待 Meet 产生 session |
| OBS Virtual Camera | Camera Extension 已激活；发布证据包待补 | OBS 32.1.2 Camera Extension 当前由 `systemextensionsctl` 报告为 `activated enabled`，`InkLoop Interview` 场景与虚拟摄像头正在运行。用户已用第二参会端确认 Meet 本机自预览镜像、远端画面方向正常，因此发送流禁止固定水平翻转。仍需固化 Meet 设备枚举、选中状态、第二端截图和 Zoom 兼容证据；这不等于整个 Unit 0/6 已完成。 |

### 2026-07-23 当前事实更新

- 早先“Camera Extension 尚未注册/待批准”的记录已经过时；当前扩展为 `activated enabled`。
- 早先“MeetingEvidence 目录为空、没有真实 Mic/Remote chunk”的记录已经过时；现有约 82 分钟 Meet 会话包含真实双轨原始数据，但暴露 Mic 后 61 分钟缺失。
- 当前 Companion、OBS 和 Meeting Media 进程均未因本轮 ASR 修复重启；现有运行链仍是旧代码，新 VAD/realtime frame/watchdog/formal replay 必须通过新会话验收。
- 早先文档中“Mic 生产上传使用 20 ms 高通、自适应噪声底、客户端 VAD、增益和静音覆盖帧”的描述已经过时。当前生产上传保留连续原始 PCM；模型 VAD 在服务端执行，Apple Voice Processing 只作用于可丢弃的 realtime ASR 派生分支。
- 当前本地 App 签名仍是 `AhaKey Local Dev`，`TeamIdentifier=not set`；Zoom.app 仍未安装。

### Google Meet 访谈虚拟摄像头 Gate（2026-07-23 提升为首发必做）

- 虚拟摄像头不属于音频/转写事实源；即使投影失败，Mic/Remote、InkEvent、ACK/补传和 formal 仍应独立工作。
- 但明日访谈体验要求受访者在 Meet 内直接看到 Live Board + 字幕 + 摄像头 PiP，因此“本地 Live Board 正常”或“能够共享屏幕”都不算完成。
- 首发 Camera Adapter 使用已安装的官方 OBS 32.1.2 Camera Extension。完成证据必须同时包含：`systemextensionsctl` 已激活、OBS `InkLoop Interview` 场景、Meet 设备选择器出现并选中 OBS Virtual Camera、第二端实际看到合成画面。
- Meet 的本机摄像头自预览会镜像，包括 Live Board 上的文字；这不是发送流方向证据。OBS / Camera Adapter 必须保持正向输出，教师使用 Companion 的正向监看入口；只有第二个登录账号/设备看到正向板书，才算远端方向通过。
- 旧测试会议 `meet-validation-old` 已不在 Chrome 标签中。2026-07-23 新建真实验收会议 `meet-validation-current`（真实会议码均已脱敏），登录账号已加入并保持在线；主端 Mic/Camera 已主动关闭，避免在 OBS/Companion 接管前争抢硬件。未邀请外部人员，所以本 Gate 保持 `pending`。
- 本机隔离浏览器已尝试以匿名访客 `InkLoop Remote QA` 申请加入；Google 个人账号会议安全策略在主持人出现批准控件前直接返回“你无法加入此视频通话”，因此这次尝试不能作为第二参与端证据。后续需改用已登录的第二账号/设备，不能用同账号“在此处切换”替代双端验收。
- OBS 的临时控制面只允许 `127.0.0.1`、使用随机临时密码；场景持久化后会原样恢复用户此前配置。当前未留下 WebSocket 配置文件或监听端口。

### 2026-07-23 Google Meet 实机续测（锁屏 Gate）

- 系统会话持续返回 `IOConsoleLocked = Yes` / `CGSSessionScreenIsLocked = Yes`；`caffeinate -dimsu` 保持运行。主 Meet `meet-validation-current`（真实会议码已脱敏）在单人、Mic/Camera 均关闭约 18 分钟后由 Google 自动退回 landing；这不是 Companion 捕获到的 confirmed-leave 事件，不能作为立即停止验收证据。Camera 授权完成后必须新建会议并立即接入第二端重测。
- OBS 日志的真实权限矩阵为：audio device `granted`、input monitoring `granted`、screen capture `granted`、video device `denied`。已用 `tccutil reset Camera com.obsproject.obs-studio` 把 Camera 恢复为可重新询问状态，并预先打开“隐私与安全 → 摄像头”；锁屏下系统仍不能展示/批准授权 sheet。
- 一键启动器实测覆盖了两个此前测试未暴露的 OBS 边界：活动虚拟摄像头会让 AppleScript/SIGTERM 等待退出确认；强制结束控制实例会留下 `run_*` sentinel，若未在最终重启前归档，会再次触发安全模式对话框。修复后只对完整 OBS 可执行路径解析出的 PID 操作，重新解析 PID 后才允许最后降级；无 OBS 进程时仅移动 `run_*` 到 `.sentinel/inkloop-recovered`，不删除证据；控制实例未确认停止时禁止启动第二实例。
- 失败尝试均在临时配置写入前退出，或在 `finally` 中恢复了原状态。该机器原本没有 `obs-websocket/config.json`，续测后仍保持不存在；无 `4455` 监听，异常 sentinel 保留在审计备份目录。
- 最新回归：示例仓库 `962/962`、根仓库 `110/110`、全仓 TypeScript check 通过；这些只证明代码回归，不替代 Camera Extension 激活、Meet 设备枚举、第二端画面、真实双轨和离会收敛证据。

## 必须补做的实机矩阵

每个格至少连续运行 45 分钟，并保留脱敏 manifest、分片统计、Provider 指标和停止审计事件。

| 客户端 | 输出方式 | Mic | Remote | 开始信号 | 结束信号 | 漂移 | 重复率 | 误停/漏停 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chrome Google Meet | 耳机 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | pending |
| Chrome Google Meet | 扬声器 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | pending |
| Zoom macOS | 耳机 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | pending |
| Zoom macOS | 扬声器 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | pending |

### 2026-07-22 Google Meet 冒烟测试阻塞记录

> 以下为当时的历史阻塞记录，已被上方“2026-07-23 当前事实更新”部分更新；保留用于说明权限和采集链如何演进，不能作为当前状态。

- 实机：MacBook Pro `Mac16,8`，Apple M4 Pro，macOS 26.5.1（25F80）。
- Chrome 已实际加入一场 Google Meet，Live Board 标签也已打开；旧测试会议之后已退出到 Meet landing，尚未形成真实录制证据。
- Companion 以 `AhaKey Local Dev` 稳定本地身份签名，Info.plist 含麦克风和屏幕录制用途说明；这不等同于 Developer ID / Team ID / 公证发行链。
- macOS TCC 日志确认麦克风请求已到达且处于 `AUTHREQ_PROMPTING`，系统随后记录 `Delaying prompt`。授权编排死锁已修复，但用户尚未在系统隐私界面完成允许，因此 `MeetingEvidence` 目录、服务端 session 和 Mic/Remote chunk 仍为空。
- Companion 代码侧已补齐两个真实链失真边界：整轨无分片必须显式成为 `missing_track:*` partial；音频回调持久化失败或 stop 瞬间存在 in-flight 帧时，必须保留/按序 drain 后再封存，不能静默丢失。
- 在三项系统权限真正显示为已授权、至少一个 5 秒 Mic chunk 与一个 Remote chunk 完成落盘/ACK/ASR、离会产生 sealed manifest 之前，Google Meet 实机格保持 `pending`，不得以本地 HTTP 连通或合成音频替代。首发候选默认 16 kHz 单声道 PCM16；5 秒分片是否继续收紧，必须由真实中文首字延迟与字错率共同决定。

### 2026-07-22 PCM16 HTTP 与中文 Provider 记录

- 本地可复现入口为 `npm run serve:meeting-media:whisper`（启动带 Silero VAD 与 non-speech suppression 的项目自有 Whisper 开发服务）和 `npm run serve:meeting-media`（启动带本地设备认证与 `ggml-large-v3-turbo-q5_0` 中文 ASR 参数的 Hub）；隔离验收入口为 `npm run smoke:meeting-media-http`，不会写入现有会议数据。
- HTTP smoke 已覆盖 session register、双轨 chunk POST、持久化 ACK、Provider drain、provisional transcript、session seal、formal final、派生跨轨去重、云端 raw 删除收据。
- `ggml-small` 的链路延迟和中文质量均不再满足明日访谈候选：普通话样本曾输出“实实会议转写链路”，且完整 HTTP smoke 里出现繁体、错词和替换字符。同一音频经 `ggml-large-v3-turbo-q5_0` 输出完整正确句，CLI 端到端由 6.66 秒降至 1.59 秒。该结果只支持“本机首选模型”决策，生产 Provider 仍须用真实多人/噪声语料比较 CER/WER、首包/p95、修订稳定性、成本和数据地域。
- 当前 realtime Whisper HTTP 适配器是累积窗口反复调用 `/inference`，不是持久 decoder 的真正 streaming ASR。8/8/20 秒只是在现有本地链上减少 4 秒窗口的请求/抖动，同时比 12 秒窗口降低首条延迟；它不能作为最终实时架构选型。
- 实机会话完成后使用 `npm run accept:real-meeting-media -- --session latest` 查看客观 dedupe 计数；人工标注跨轨候选对后，可追加 `--dedupe-labels <labels.json>` 计算残余重复率与误删率。没有独立标签时不得把“已抑制数量”解释成质量分数。

### 2026-07-23 recorder lease 与运行环境记录

- 租约作用域为 `tenant_id + normalized provider meeting reference`，不是单用户作用域。因此同一组织里每个参会者都打开 Companion 时，只有一个设备成为事实记录者；其他设备显示待命。其他 tenant 使用同一会议号时隔离。
- 设备 ID 必须与认证会话中的 `device_id` 一致，客户端不能通过请求体冒充另一设备。lease token 只返回给持有者；session register 与每个 chunk 都校验 token，chunk 流量自动续期，完全静音时 Companion 每 10 秒显式续期。
- Companion 结束并完成 formal 后释放租约；异常退出时最长 30 秒后可接管。服务端不可达时 Companion 不牺牲本地事实记录，但不 ACK 或上传无租约音频，恢复后先重新取得 ownership 再补传。
- 升级后的隔离 HTTP smoke 已通过 `lease acquire → session register → 双轨 ACK → ASR → formal final → lease release`：注册 2 ms，ACK 4/10 ms，ASR drain 1.013 s，formal 24 ms，outbox 508 B，零缺片，云端 raw 已删除。
- 当前实机为 macOS 26.5.1（25F80）、Apple M4 Pro / 24 GB；Google Chrome 已安装。系统中未发现 Zoom.app，因此 Zoom 实机矩阵开始前必须从官方来源安装并完成一次启动。
- 2026-07-23 最新代码重建后再次通过隔离 HTTP smoke：注册 2 ms，ACK 4/10 ms，ASR drain 1.016 s，formalize 24 ms，outbox 508 B，零缺片、final、raw 自动删除。该结果仍只证明协议与本地 Provider 链，不替代真实 Meet/Zoom 媒体矩阵。
- 2026-07-23 声学判断、去重质量评估与 telemetry 接入后的最新隔离 HTTP smoke：注册 3 ms，ACK 5/14 ms，ASR drain 1.014 s，formalize 28 ms，outbox 508 B，2/2 ACK、零缺片、final、derived-only 去重与 raw 自动删除全部通过。系统三项权限已读到 Mic authorized / Screen true / Accessibility true，但实机仍锁屏且 Chrome 只在 `meet.google.com/landing`，因此没有冒充真实 Meet Gate。
- 2026-07-23 跨层 code review 后重新跑隔离 HTTP smoke：注册 2 ms，ACK 4/10 ms，ASR drain 1.012 s，formalize 28 ms，outbox 508 B；已验证收紧后的 sealed-session formalize、canonical meeting identity、Provider abort 和 lease cleanup 未破坏双轨闭环。Companion 增加了 in-flight callback/暂停/停止回归测试，并把 Meet 窗口消失从结束证据降为 unknown；这仍不替代真实 Meet post-leave UI、耳机/扬声器及 45 分钟矩阵。
- 2026-07-23 最终串行回归 smoke：注册 2 ms，ACK 4/10 ms，ASR drain 1.013 s，formalize 16 ms，outbox 508 B，全部 Gate 通过；同时确认 953 项示例测试、110 项根测试和 45 项 Companion 测试全绿。新增的离线维护循环会先应用删除命令，再补传未收敛会话；本地 receipt 防止已完成历史会话重复 formalize。

## 需要冻结的决策

- 最低 macOS 版本：当前 Swift Package 暂为 macOS 13，只是编译下限，不是已验证发行下限。
- Chrome Meet 目标音频范围：确认 ScreenCaptureKit 能稳定隔离目标窗口/应用；若不能，再评估浏览器扩展，不提前承诺“单标签隔离”。
- Zoom 应用音频：确认耳机与扬声器下均有稳定 Remote 轨，且不把 Mic 原始轨覆盖为混音。
- 明确结束信号：只把可审计的 meeting-ended evidence 标为 confirmed；失焦、后台、静音和短暂断网仍是弱信号。
- Streaming ASR Provider：至少对比首包延迟、稳定 utterance revision、语言/说话人表现、错误率、成本和数据地域。
- 权限与发行：麦克风、屏幕/系统音频权限的一次性引导，签名、公证、升级后权限保持与撤销恢复。

## 采集指标

每场记录以下原始值，不只记录一个总耗时：

- 录制持续时间、Mic/Remote chunk 数、缺失 sequence、checksum 冲突、磁盘字节；
- 首个 ACK、p50/p95 ACK，断网时本地队列峰值，恢复后追平时间；
- ASR 首个 provisional、formal 收敛时间、revision 次数、Provider 错误与重试；
- 双轨残余重复率、误删率、speaker 聚类错误率、人工抽样字错率；
- confirmed end 到最后 chunk sealed 的延迟、误停数、漏停数；
- Cards ready、可读摘要 ready、artifact bytes 与模型调用数；脑图暂缓、完整报告下线，不计入链路。

## Go / No-Go

只有四个 45 分钟格全部完成、目标音频边界明确、Provider 选型完成、权限/签名/公证可复现后，才能把 Unit 0 和 Unit 2 标记完成，并开始真实 ScreenCaptureKit/Mic adapter 的发布接线。当前状态是 **No-Go（真实媒体采集）**；Core、Ingress、Postprocess 和 UI 可以继续开发与集成。

## 当前部署约束

- Meeting Media 与 Postprocess 文件存储当前仅支持一个 active writer/worker；进程内锁不是跨进程事务。多实例放量前必须迁移到带唯一约束、CAS/租约和事务能力的持久层。
- 当前 recorder lease 是文件持久化 + 单进程锁实现，只能作为单实例开发/验收版本；生产多实例必须把同一租约语义迁移到具备 tenant + occurrence 唯一键和 CAS 的数据库/协调存储。
- Transcript 与 Provider outbox 仍是两个原子文件；Provider 结果先持久化进 outbox，崩溃恢复不必再次调用 Provider，但多文件提交仍不等价于数据库事务。
