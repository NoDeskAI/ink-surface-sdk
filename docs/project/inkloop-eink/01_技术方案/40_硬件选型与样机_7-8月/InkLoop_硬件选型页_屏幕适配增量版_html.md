# InkLoop_硬件选型页_屏幕适配增量版

InkLoop 硬件三档方案 · 选型说明（屏幕适配增量版）

## InkLoop 硬件选型说明：三档总览后，方案 A 纯云、方案 B 端云协同（主线）、方案 C 全本地各自成章；本版增量加入 10.3 寸 Good Display 电子纸屏与 RK3588 板的适配核对。

# InkLoop 硬件三档方案 · 选型说明

面向美国 C 端的手写标注阅读一体机（彩色电子纸 + 笔）。整套硬件选型本质只取决于一个承重 bit——最终答问 LLM 跑在云端还是本地；除它之外，证据层 / OCR / 手写分类 / embedding / 向量库 / MCP 等组件全都能本地化。本版增量加入当前已购 10.3 寸黑白电子纸屏的接口适配判断；该屏用于验证屏幕链路，不代表最终彩色屏 / 专业笔规格。

本页主观判断保持不变：v1 主线仍是 RK3588-family 端云协同。 A 纯云无需专门购板；C 全本地的 Jetson 为 Linux/CUDA、非安卓平台，仅能充当本地答问质量预言机。增量修正：若同时验证当前 10.3 寸 Good Display 屏，采购不能只看 32G / NVMe / RKNN，还要看 USB、SPI、I²C、GPIO、触摸、前光与 Android 设备树；不同板商差异会直接影响屏幕闭环难度。

### 三档速览

维度A 纯云B 端云协同C 全本地

最终答问 LLM云端云端本地

答问质量云端最佳云端最佳本地 7–14B（偏弱）

代表 SoCRK3566/68RK3588(S)Jetson（量天花板）+ 安卓 SoC 储备

平台 / OS安卓（RK）安卓（RK3588-family）Jetson Linux/CUDA（非安卓）；落地→安卓 SoC

内存2–4GB8–32GB16–64GB

AI 功耗0.5–2.5W1.5–4W（模块级）10–60W

电子纸形态 可行 可行（整机续航需实测） 塞不进

算力 BOM（量产芯片级）几十~两百元两百~六百元¥6,500–19,000（模组）

定位成本下限对照首版消费主线预言机 + 安卓 SoC 储备

AI 部分功耗（模块级，非整机）

A

~1W

B

~3W

C

~30W（10–60×）

算力部分 BOM（量产芯片级，非开发板零售价）

A

~¥100

B

~¥300

C

¥6,500+（数十×）

C 不是「更高级的 B」。 它唯一独占的优势是离线 / 隐私；在 10–40W 持续本地推理下，电子纸设备会从「多日/多周」续航口径滑向「小时级连续推理」口径（最终按电池容量、占空比、散热实测确认），而答问质量反而更差（本地 7–14B ＜ 云端）。A→B 把 OCR + embedding + 向量库 拉到本地；B→C 只把答问 LLM 再拉到本地 —— 一格之差，硬件却跳一个数量级。

A纯云仅作对照

最薄、最便宜、最省电，但强依赖网络。一切 AI 在云，端侧只做采集与缓存；隐私叙事弱，断网基本无 AI 可用。

本地做笔迹采集、证据蒸馏（纯 CPU）、切页 / 缩略 / 缓存

云端做OCR / 手写 / 答问 / 检索 —— 一切模型

SoCRK3566/68（~1 TOPS）内存2–4GB功耗0.5–2.5W答问云端最佳

硬件候选

对照
任意 RK3566/68 板

2–4GB · 也是电子纸消费机现实主控档

淘宝 ~¥500

对照
现成 PC

A 路线 PC 已验证大半，不必先买板

¥0

适用：成本下限体验 / 弱 AI 入门版。不必单买板：用现成 PC 即可验证，或直接在 B 的同一块 RK3588 上切 /api 配置即得 —— A = 关掉本地感知的 B，能力上 A ⊂ B。

B端云协同主线

本地把「看懂」做完，云端只接「答好」。降低云调用、弱网下感知可用、端侧脱敏减少原始上传，同时保住云端大模型的答问质量。质量与成本两头都占，是首版消费机主线。

本地做证据层 + OCR / 手写 + embedding + 向量库 + MCP + 证据蒸馏

云端做仅最终答问 LLM（吃蒸馏后的事实 + 问题，不送原图）

SoCRK3588-family（~6 TOPS）内存8–16GB（选定 32GB 裕量）功耗1.5–4W（AI 模块级）答问云端最佳形态可行，续航需整机实测

硬件定义要收紧：不是「随便一块便宜 6 TOPS 板」，而是 RK3588/RK3588S + 优先 32GB + 优先 NVMe + 跑通 PPOCR/RKNN、embedding、向量库、MCP 长驻。embedding / 向量库吃的是 RAM/NVMe/CPU，不是 NPU；32GB 与 NVMe 是降低验证噪声，不等于最终 BOM 已锁死。

隐私口径要保守：端侧只做到「减少原图 / 原始笔迹上传」；上云 payload 仍可能含原文片段、OCR 文本、用户手写 = 仍属敏感数据，需脱敏 / 最小化 / 可审计（完整上云数据策略另见隐私文档，非本页范围）。

RK3588 候选（现货实价 · 各牌子并列、不预设优劣；详见下方细选）

最便宜 32G
Orange Pi 5 Plus 32G

RK3588 32G LPDDR4X · 40-pin 便于 SPI/I²C 接屏 · M.2 NVMe 自购 · 文档/供货弱一档

单板+电源 ¥1,099

BSP 文档最全
Firefly ROC-RK3588S-PC 整版

Android BSP/RKNN/PPOCR 文档最全 · 有 32G SKU · M.2 SSD 自购；接屏需确认触摸 I²C/USB

¥2,739(8G)/¥3,749(16G)/~¥4,900(32G)

屏幕闭环较优
Radxa ROCK 5B+

32G LPDDR5+双 M.2 NVMe 顶规；40-pin SPI/I²C/GPIO 清晰，较适合屏幕闭环；32G 暂无货

8G ¥1,355 / 32G 无货

屏幕增量确认（2026-06-22）。 当前订单为 DEJA-TC103[TCON 板] + GDEP103TC2-FT11[10.3 寸电子纸屏，带触摸 + 前光]。这套屏可用于验证 10.3 寸黑白电子纸外设链路；它不是彩色屏，也不是 EMR/压感笔方案。正确接法是 RK3588 板 → USB 或 SPI → DEJA-TC103 → 屏；不是 HDMI/MIPI/DP 直接当主屏插入。

新增：10.3 寸电子纸屏适配核对（DEJA-TC103 + GDEP103TC2-FT11）

RK3588 板能否接增量判断

Radxa ROCK 5B+ 可接USB/SPI 均可；40-pin 的 SPI/I²C/GPIO/电源更清晰，最适合做屏幕 + 触摸 + 前光硬件闭环。32G 有货时作为更均衡首选。

Orange Pi 5 Plus 32G 可接40-pin 方便接 DEJA 的 SPI 与触摸 I²C，价格低、32G 现货；适合先跑屏幕链路和向量库上限，Android/BSP 文档风险仍需接受。

Firefly ROC-RK3588S-PC 可接USB/SPI 显示链路可做；软件/RKNN/BSP 仍最稳，但 20P 排针与触摸 I²C/USB 输出、前光控制要先问卖家。适合 AI 软件闭环，不一定是接屏最省事。

正点原子 RK3588 SoM + 底板 可接SoM+底板接近产品化；扩展 IO 可接 USB/SPI/I²C，但要逐项查底板引脚与设备树。16G 版不适合百万 chunks 上限验证。

鲁班猫5 可接40-pin 方便；需确认具体硬件版本，部分版本 SPI 片选/引脚有差异。适合屏幕外设实验，但 RAM 偏小版本不作主线。

结论口径：所有候选基本都能把这套屏作为外设屏接入；没有一块能把 GDEP103TC2-FT11 当 HDMI/MIPI 普通显示器开箱即用。Android 主屏 / SurfaceFlinger 集成属于单独驱动或显示服务项目。

下一步：真机闭环实验（带通过线）

在所选 RK3588 板上运行 本地 OCR + embedding + 10万/100万 chunks 向量库 + MCP + `/api`，将蒸馏 payload 发往云端 Sonnet，测端到端延迟 / 云 token 成本 / payload 最小化 / 答问质量 / 屏幕刷新链路。验收线（按 32G 计；OPi 32G 可压满，16G 板仅验到几十万 chunks）：

单页 OCR p95 ≤ 1–2 秒；局部标注区域 OCR p95 ≤ 500–1000ms

10 万 chunks top-k 检索 p95 < 200ms；100 万 chunks < 1s

本地服务长跑 8 小时不降频、不崩溃；Android 后台 / 休眠唤醒后服务可恢复；32G 板常驻后空闲内存 ≥ 8GB（≥25%）

上云 payload 体积压缩率 ≥ 80–95%；另测敏感信息残留率、脱敏率与「本次发送内容」可审计性

端到端用户等待：普通问题 ≤ 5–10s、复杂问题 ≤ 20–30s

云端答问质量达产品要求（卡点在会话质量本身，非硬件）

屏幕链路先用 PC + DEJA 点亮，再接 RK3588；确认 USB/SPI 刷图、GT9110 触摸输入、前光控制、VCOM 设置与 Android 设备树

适用：首版消费产品主线。第一批仍可按 1 块 32G RK3588 收敛；但若「屏幕闭环」与「AI 软件闭环」同等紧急，要求把风险拆开：Radxa/OPi 负责 40-pin SPI/I²C 屏幕链路，Firefly 负责 Android/RKNN/PPOCR 软件链路。A 与 B 同一套代码靠 /api 切换，一块板可跑 B 闭环并切 A 对照。隐藏代价：主控从 RK3566/2–4GB 顶到 RK3588-family/≥8–16GB+NVMe，整机 BOM/电池/散热/屏幕驱动需重做规格。

C全本地储备·非 v1

含最终答问 LLM 在内全部本地，彻底离线 / 隐私。代价是算力、功耗、成本、机身全面上一个数量级，本地答问质量反而更弱。C 分两块：Jetson 只量质量天花板（Linux/CUDA·非安卓·非产品）；若全本地答问真成产品刚需，落地走安卓 SoC（优先 Qualcomm，见下）。两者均不进 v1。

本地做全部，含答问 LLM（7–14B 量化档，需真机验证）

云端做无（或仅 OTA / 同步）

SoCJetson Orin NX / AGX平台Linux/CUDA·非安卓内存16–64GB功耗10–60W答问本地 7–14B（明显偏弱）

Jetson ≠ 安卓开发机。 NVIDIA 不提供 Android BSP，Jetson 运行 Linux/CUDA（JetPack）。其价值仅在于回答一个问题——「该档算力的本地 LLM 答问质量是否达标」，CUDA/TensorRT 栈一行都不迁往安卓产品。全本地答问若要落地产品，需改用安卓 SoC（优先 Qualcomm 骁龙 / Dragonwing，其次 MediaTek；RK+RKLLM 仅离线弱回答 fallback、不算全本地主力——详见下方「安卓 SoC 路线」），而非 Jetson；Jetson 仅提供质量天花板口径。

TOPS 与大参数易误导。 C 可运行 7B/8B、部分 14B/20B+、低位量化 MoE 乃至更大参数（Orin NX 16G 官方 7B/8B ~22 tok/s）；但在可接受质量/内存/功耗/延迟下，产品可用答问应按 7–14B 级别实测验证——「参数装得下」≠「获得 35B 云端质量」（「Jetson 能跑 35B」多为 IQ2_M 二位量化、质量已塌）。全本地所得并非「更强答案」，而是「明显弱于云端、但不出网的答案」。

C·质量预言机：Jetson（Linux/CUDA · 只量天花板、非产品；Seeed 天猫实拍）

C1 验证机
Jetson Orin NX 16G Super

157 TOPS · 16G LPDDR5 · 7B/8B ~22 tok/s · 另配 1TB NVMe（128G 偏小）

¥6,137（无壳256G）/ ¥7,037（带壳128G）

C0 低价 baseline
Jetson Orin Nano Super 8G

67 TOPS · 8G · 仅熟悉工具链；全栈常驻易挤爆，不作主力

¥2,569（256G 套件）

C2 上限·不先买
Jetson AGX Orin 64G

275 TOPS · 64G · 204.8GB/s · NX 不够再上 · 偏实验室

¥18,877（原装+1TB）

若全本地答问成刚需 → 安卓 SoC 路线（C 补充研究 · 储备，非 v1）

Jetson 只量质量天花板、做不了安卓产品；真要把全本地答问做进安卓机，落地走安卓 SoC，优先级 Qualcomm > MediaTek > RK / CIX。承重闸门仍是质量：先用现成骁龙旗舰手机跑 Qualcomm Genie / AI Hub 的 Llama-8B + InkLoop 3K spike，量质量 / tok/s / 温度 / 电量；8B 过线再谈 SoM/HDK 投入，过不了就改产品定义（全本地只做摘要 / 短答 / 离线 fallback，高质量仍走云）。

路线（优先级）代表 / 现货实价判断（C 储备 · 非 v1）

① Qualcomm 旗舰移动 SoCSnapdragon 8 Elite/Gen5（8 Gen2 HDK 淘宝 ¥18,654 / Lantronix HDK $1,499；或现成旗舰手机）最像未来安卓全本地消费机；Llama 8B w4a16 ~14–16 tok/s（4096 ctx）。落地坑：旗舰配额/NRE、HDK 无 buildable BSP、贵

② Qualcomm Dragonwing SoMThundercomm C8750 / C8550（€1,490+）、研华 QCS6490 SoM ¥6,300最像可产品化 SoM（Android/Linux + 厂商支持）；高端偏贵偏热，依赖厂商支持

③ Qualcomm 中端 IoTQCS6490：Radxa Dragon Q6A 12G ¥1,305 / RB3 Gen2 Vision ¥6,861便宜、安卓友好；12 TOPS 对 8B 主答问偏紧，宜学生态 / OCR / 小模型 / embedding，不扛主答问

④ MediaTek（观察）Dimensity 9400/9500 手机、Genio 1200/700 EVK手机端侧 GenAI 强，但可买的开发板 / SoM 产品化路线不如 Qualcomm 清晰；Genio 4 TOPS 撑不住 8B

⑤ RK+RKLLM · CIX P1RK3588/RK3576（同 B 主线）/ CIX P1 = OPi 6 Plus ¥2,860（45 TOPS · 可 64G）RK-RKLLM 仅离线弱回答 fallback、非全本地主力；CIX P1 纸面强但软件早期、高风险观察

C 闸门（C 路线验证项）

真实 InkLoop 3K 上下文本地答问：p95 总延迟 ≤ 30–45 秒 且质量可接受 → C1 有戏

同时 OCR/emb/向量/MCP 占位常驻：不 swap、不 OOM，空闲 ≥ 1.5–2GB

须为 Super / 支持 JetPack 6.2 MAXN；避开 Seeed J4012 Classic 旧款（标「Super Mode NOT Supported」）

适用：离线高端 / 企业 / 隐私储备，均不进 v1。两步走：① Jetson 量本地答问质量天花板（Linux/CUDA·非产品，Orin NX 16G ¥6,137 起 + 1TB NVMe）；② 若 8B 质量达标且全本地成刚需，产品落地走安卓 SoC（优先 Qualcomm，先用现成骁龙手机 spike、再谈 SoM/HDK）。Jetson 回答「质量行不行」，安卓 SoC 才回答「能不能落地安卓」。

### 采购事实清单（品牌按取舍确定）

主线判断：现阶段第一块主控仍要求 RK3588 32G（B 档安卓开发板）；若优先屏幕闭环，40-pin SPI/I²C 清晰的板更顺；若优先 Android/RKNN/PPOCR，Firefly 更稳。所有板的 M.2 NVMe SSD（1TB ¥400–700）通常需自购，全套 = 板价 + SSD。

类别采购项RAM关键事实现货实价

B·RK3588Orange Pi 5 Plus 32G32G LPDDR4X最便宜 32G；40-pin 适合屏幕链路；文档/供货弱¥1,099（+SSD）

B·RK3588Firefly ROC-RK3588S-PC 整版8–32GAndroid BSP/RKNN/PPOCR 文档最全；有 32G SKU；屏幕触摸 I²C/USB 需确认¥2,739–4,900（+SSD）

B·RK3588Radxa ROCK 5B+32G LPDDR5LPDDR5+双 M.2 NVMe；40-pin SPI/I²C/GPIO 清晰，屏幕闭环较优；32G 暂无货8G ¥1,355 / 32G —

B·RK3588正点原子 16+128G 核心板+底板16GSoM+底板（近产品化形态）；IO 可接屏但需查底板；仅 16G¥2,875

B·RK3588鲁班猫5 8+64G / 4+32G8G / 4G一体板；RAM 偏小、注定再升级¥1,879 / ¥1,379

＋必配M.2 NVMe SSD 1TB（所有板自购）—向量库 / OCR 缓存 / 日志 / 评测集；开发阶段优先，最终 BOM 复测¥400–700

＋当前屏DEJA-TC103 + GDEP103TC2-FT11—10.3 寸黑白电子纸，触摸+前光；经 TCON 以 USB/SPI 接入 RK 板，非 HDMI/MIPI 主屏¥499+¥794；实付 ¥1,316（含运费）

A·对照现成 PC / 任意 RK3566 板—纯云不必专门买板（PC 已验证大半）¥0 / ~¥500

C·储备Jetson Orin NX 16G（非安卓）16G仅离线答问质量预言机；Linux/CUDA 非安卓、不进 v1¥6,137（+NVMe）

二阶段RK3576 ROCK 4D / 鲁班猫3—降本（B 跑通后再评估）¥760 / ¥869

二阶段Radxa Dragon Q6A 12G（QCS6490）12GQualcomm 安卓 SoC 路线评估¥1,305

取舍各异：最便宜 32G 为 OPi（¥1,099，全套 ≈¥1,500–1,800）；软件/文档最全为 Firefly（¥2,739 起）；屏幕闭环更看重 40-pin SPI/I²C/GPIO，Radxa ROCK 5B+（32G 待补货）和 OPi 更顺；近产品化的核心板+底板形态为正点 SoM。A 用 PC 即可、无需单购；C/Jetson 仅在确需离线答问时作预言机采购、且不可落地安卓产品。M.2 SSD 与屏幕外设预算需单列。

### 下单须知

M.2 NVMe SSD 基本均需额外自购。 板载存储多为 eMMC 或选配；开发阶段要求另配一块 M.2 SSD（1TB 约 ¥400–700），下单前确认 M.2 槽、M-Key、PCIe 代数与 lane、支持盘长。预算须将 SSD 单列 —— 如 Orange Pi 5 Plus 32G 单板+电源 ¥1,099 + 1TB NVMe ≈¥1,500–1,800。

当前屏幕外设下单口径： DEJA-TC103 是 TCON/驱动板，GDEP103TC2-FT11 是屏幕模组；两者合起来才是一套 10.3 寸黑白电子纸验证链路。先用 PC + DEJA 官方工具点亮并确认 VCOM / 前光 / 触摸，再接 RK3588。不要把它当作 HDMI/MIPI/DP 主屏直接接入。

下单核对项（向卖家确认）

当前选项准确 RAM / eMMC？SoC 是 RK3588 还是 RK3588S，所需接口是否还在？

底板/主板有没有 M.2 NVMe 槽？M-Key、PCIe 几代几 lane、支持多长 SSD？（SSD 通常不含，需自购）

有没有 Android/Linux SDK + BSP + 镜像 + 烧录工具 + RKNN Toolkit2 + PPOCR 示例？

若接 DEJA-TC103：是否提供 Linux/Android USB 控制协议或 SDK？若走 SPI，是否提供 14-pin FPC 引脚定义、示例代码和时序？

GDEP103TC2-FT11 的 GT9110 触摸是 USB 输出还是 I²C 裸接？是否包含触摸控制小板、前光线缆 / 27V 驱动、屏幕 FPC 与转接板？

所选 RK3588 板是否有易用的 USB Host、SPI、I²C、GPIO、3.3V/5V；Android 下能否把触摸映射成标准 input event？

带不带主动散热？满载长跑要不要风扇？电源够不够（外接 NVMe / 屏要更高规格）？

核心板+底板能否买「不带 MIPI 屏」版？能否开票 / 企业采购 / 长期资料更新？

是否有 32GB SKU？（正点 / 野火渠道，可就地解决目标配置）

### 决策助手

Q1 · 离线 / 隐私状态下也必须能「回答」吗？

是（接受 7–9B 质量、成本/功耗上一档）→ 方案 C（Jetson 量天花板；非安卓、不做产品，产品全本地要换安卓 SoC）

否 → 进 Q2

Q2 · 要本地 OCR / 手写 / 向量检索吗？（离线感知、隐私脱敏、弱网可用、降云成本）

是 → 方案 B（产品主线）

否 → 方案 A（纯云）

公开资料中未见主流彩色电子纸 / 手写标注设备把最终答问 LLM 放在设备本地运行 —— AI 能力通常依赖云端，或仅限轻量本地 OCR / 手写识别。这印证了 A/B 是产品共识、C 不是。（reMarkable Paper Pro：NXP iMX8 Mini / 2GB；Kobo Libra Colour：双核 2.0GHz / 32GB，均走云端。Kindle Scribe Colorsoft 硬件/AI 细节以官方为准、待独立核验。BOOX Note Air5 C 开放 Android 可装小模型，仍非本地答问主线。）

结论：v1 主线仍是 RK3588-family 端云协同（具体品牌按风险取舍确定）；A 用现成 PC、C/Jetson 为 Linux/CUDA·非安卓、仅作本地答问质量预言机。屏幕增量口径：DEJA-TC103 + GDEP103TC2-FT11 作为 USB/SPI 外设屏接入报告中的 RK3588 板，但不能当 HDMI/MIPI 主屏开箱即用；触摸/前光/Android input 与显示服务需单独验证。价格口径 2026-06-22：OPi 5 Plus 32G ¥1,099、Firefly ROC-RK3588S-PC ¥2,739–4,900、ROCK 5B+ 8G ¥1,355 / 32G 无货、正点 16+128G ¥2,875、鲁班猫 ¥1,879/¥1,379、ROCK 4D ¥760、Dragon Q6A ¥1,305；当前屏幕订单 DEJA-TC103 ¥499 + GDEP103TC2-FT11 ¥794，实付 ¥1,316（含运费）。受优惠/套餐/是否含 NVMe·电源·散热影响，仅作量级参考、不作下单价。三档共用同一套 InkLoop 系统代码（/api/* 后端可换）。· 选型说明 屏幕适配增量版 2026-06-22
