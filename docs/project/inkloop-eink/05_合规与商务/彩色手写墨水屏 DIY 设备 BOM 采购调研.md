# 彩色手写墨水屏 DIY 设备 BOM 采购调研
> 目标规格参考（用户图示）


***
## 执行概要
本方案以 10.3 英寸 E Ink Kaleido 3 彩色电子纸为显示核心，叠加 Wacom/汉王 EMR 无源电磁笔触控层，搭载 Rockchip RK3568（1 TOPS NPU）四核 A55 核心板，形成一套从显示、手写、主控、通信、电源到安全的完整 DIY 手写彩色墨水屏终端方案。各单元均有明确的采购渠道，核心模块需向 B2B 或原厂开发者商店询价，部分可通过嘉立创/淘宝直接下单。

***
## 一、显示模组
### 1.1 E Ink Kaleido 3 — 10.3 英寸彩色电子纸模组
**核心规格**：
- 尺寸：10.3 英寸（A5 纸张比例）[^1]
- 黑白分辨率：300 PPI（1860×2480）；彩色分辨率：150 PPI（930×1240）[^2][^3]
- 色彩数：4096 色（RGB CFA 彩色滤光层方案）[^2]
- 前光技术：E Ink ComfortGaze™，BLR（蓝光比率）降低最高 60%，BLTF（蓝光毒性因子）降低最高 24%[^4]
- 灰阶：16 级[^1]
- 彩色饱和度较上代 Kaleido Plus 提升 30%[^4]
- 兼容波形：Carta 1200 / Carta 1250，支持局部快刷（局刷延迟更低）[^2]
- 刷新特点：底层黑白电子墨水具备快速刷新能力，可支持动画/视频播放；彩色层由于 CFA 结构较 BW 层慢，要求"笔迹即时黑白预览 + 彩色后渲染"策略[^2]

**询价/采购渠道**：
1. **E Ink 官方开发者商店（shopkits.eink.com）**：面向商业开发者，需注册企业账户。当前商店在售含驱动板套件，13.3 寸 Kaleido 3 模组（不含驱动板）单件约 **$449**；10.3 寸模组请直接在商店搜索或邮件询价。注意：购买者须以商业用途身份下单，不接受个人消费者订单。[^5][^6]
2. **DKE（香港）/ 深圳第三方屏幕供应商**：Alibaba 上有深圳华益、DKE Hong Kong 等代理商，10.3 寸量级彩色模组报价区间约 **$82–$194** 不等（取决于型号和批量），需注意确认是否为 Kaleido 3（非 Plus 或 Carta 单色）。[^7][^8]
3. **立创商城/华强北**：小批量可找屏幕代理商询价，要求携带 E Ink 型号 ED103TC2（10.3 寸 Kaleido 3 标准型）直接询价。

**询价时必须带上的规格参数**（参照图示）：
- 尺寸：10.3 英寸
- 分辨率：300 PPI（BW）/ 150 PPI（Color）
- 色彩数：4096 色（Kaleido 3 CFA）
- 刷新模式：是否支持局刷（A2/GL16 waveform）
- 前光：是否含 ComfortGaze 前光模组
- 驱动板：是否含波形授权（waveform license），或需单独配 IT8951/ITH8951 驱动板
- 接口：并口（Parallel）还是 EBC（供 RK3568 直驱）
### 1.2 驱动板方案
RK3568 原生支持 **EBC（E-Book Controller）接口**，是驱动大尺寸电子纸最直接的方式，无需额外 IT8951 桥接板。已有开源参考设计（立创开源广场 RK3568-墨水屏电子书项目）支持 4.7~13.3 寸并口墨水屏 + Android 11。若使用非 EBC 接口的模组，则需配 IT8951 或 IT8915 驱动控制板（Waveshare 有售）。[^9][^10][^11]

***
## 二、触控笔层（EMR 无源电磁手写）
### 2.1 方案选型
**确定采用 EMR（Electro-Magnetic Resonance）电磁共振方案**，而非电容触控，原因：
- 无源笔（笔内无需电池），笔尖可做到更细[^12]
- 4096 级压感，延迟最低可达 22 ms[^13]
- 笔感接近纸张书写，支持掌托识别（Palm Rejection）[^13]
- 感应板可用柔性 PCB 嵌入墨水屏背面，前盖板厚度/材质需严格管控（视差和定位偏差敏感）[^14]

**已验证方案参考**：
- E Ink 官方 Digital Paper Tablet 平台（10.3 寸）采用 Wacom EMR 传感器 + 电容触控，4096 级压感[^12]
- Pine64 PineNote（10.3 寸）采用 Wacom EMR 层 + 前光[^15]
- Seekink H103NPL 10.3 寸平板 Wacom EMR，延迟 22 ms，4096 压感[^13]
### 2.2 采购渠道
| 供应商 | 产品 | 联系/采购方式 |
|--------|------|---------------|
| **汉王友基（Hanvon Ugee）** | EMR 笔触控模组（含感应天线板、控制板、无源笔），官方明确支持嵌入墨水屏[^14][^16] | business.hanvonugee.com → "EMR Pen Touch Module"，需商务询价 |
| **Morgan Touch（台湾/东莞）** | EMR 多笔解决方案，5 寸至 86+ 寸可定制[^17] | inquiry@morgan-touch.com 或 +86-769-2161-1663 |
| **Wacom（商用 B2B）** | EMR OEM 模组，专利期已届满，国产替代方案价格大幅降低[^18] | 主要通过 Wacom for Business 渠道或 OEM 合作 |

**询价时必须带上的规格参数**（参照图示）：
- 笔方案：EMR（电磁共振），无源笔
- 压感：≥ 4096 级
- 报点率：≥ 200 RPS（要求 256 RPS）
- 视差：要求感应板贴合后，前盖板厚度容差（通常 ≤ 1.5 mm 盖板）
- 掌托误触：Palm Rejection 支持（硬件层），区分笔/掌
- 笔尖耗材：标准笔尖直径，备用笔尖是否可采购
- 侧键/尾擦：是否支持笔杆侧键（前进/后退）和尾端橡皮擦逻辑

***
## 三、主控核心板
### 3.1 主控芯片：Rockchip RK3568
RK3568 是当前最适合电子纸手写设备 DIY 的国产 SoC，关键优势：

| 参数 | 规格 | 备注 |
|------|------|------|
| CPU | 四核 Cortex-A55，最高 2.0 GHz[^19] | 64 位，22nm 工艺 |
| GPU | ARM Mali G52 2EE | OpenGL ES 3.2，OpenCL 2.0[^20] |
| NPU | **1 TOPS @ INT8**[^19][^20] | 支持 INT8/INT16/FP16/BFP16 |
| NPU 框架 | TensorFlow / Caffe / PyTorch / ONNX / Android NN[^19] | RKNN-Toolkit 工具链 |
| EBC 接口 | **原生支持**，最高 2200×1650[^11] | 直驱大尺寸并口墨水屏，无需桥接 |
| RAM | LPDDR4/DDR4，最高 8 GB[^11] | 选定 4 GB |
| 存储 | eMMC 5.1，最高 128 GB[^11] | 选定 64 GB |
| 安全 | ARM TrustZone + OP-TEE OS，支持安全启动[^21] | BL1→BL2→BL31→BL32 签名链 |
| Wi-Fi/BT | 通常由核心板外挂 Wi-Fi 6 / BT5.0 模组 | AW-CM358SM 或 AP6275P 常见方案[^22] |
| USB | USB 3.0 OTG + USB 2.0[^22] | 支持 USB-C |

已有 RK3568 + 大尺寸 EBC 并口墨水屏方案在立创开源广场和 Rockchip 教育展上展出，搭载 RK3566/3568 的 10.3 寸电子纸手写本已有量产参考。[^23]
### 3.2 核心板产品
**飞凌嵌入式 FET3568-C**（首推）：
- CPU：RK3568，四核 Cortex-A55，2.0 GHz
- RAM：1/2/4/8 GB DDR4 可选
- ROM：8/16/32/**64 GB** eMMC 可选[^24]
- NPU：1 TOPS，支持 RKNN-Toolkit，TensorFlow/PyTorch/ONNX[^19]
- 显示接口：HDMI2.0、**EBC**、eDP、LVDS、MIPI-DSI（三屏异显）[^22]
- 系统：Android 11/12，Linux Buildroot/Debian[^22]
- 采购：飞凌官网（forlinx.net）、淘宝（飞凌嵌入式旗舰店，956 元/片含税参考价）；Alibaba 国际版（FET3568-C）[^25][^26]

其他可选：
- 立创 MIPI 核心板、瑞芯微 RK3568 OEM 核心板（华强北多家供货）
- 如需更强 NPU（6 TOPS），可升级至 **RK3576**，但功耗和散热要求随之上升[^27][^28]

**询价时必须带上的规格参数**（参照图示）：
- CPU：四核低功耗 A55，≥ 1.8 GHz
- RAM：4 GB LPDDR4
- 存储：64 GB eMMC（或扩展至 128 GB）
- 接口：USB-C（OTG），**EBC 接口**（用于墨水屏直驱）
- BSP：是否提供 Android/Linux BSP，是否有 EBC 驱动支持
- 电子纸驱动适配：是否有针对 10.3 寸并口屏的驱动 Demo

***
## 四、通信模组
### 4.1 Wi-Fi + BT 方案
RK3568 核心板通常不内置无线，需外挂 Wi-Fi/BT 模组，主流方案：

| 芯片型号 | 规格 | 采购来源 |
|---------|------|---------|
| **AW-CM358SM**（正基科技） | 2.4/5 GHz 双频 Wi-Fi 5，BT 5.0[^22] | 飞凌 OK3568-C 开发板默认配置，可单独采购 |
| **AP6275P**（瑞昱/正基） | Wi-Fi 6（802.11ax），BT 5.0 | 立创商城、华强北现货 |
| **RTL8852BE**（瑞昱） | Wi-Fi 6，BT 5.0，PCIe/SDIO 接口 | 立创商城现货，价格亲民 |
| **BL-M8812EU2**（博通） | Wi-Fi 6，BT 5.3，双天线 | Alibaba 批发 |

**询价时必须带上的规格参数**（参照图示）：
- Wi-Fi 频段：双频（2.4 GHz + 5 GHz），Wi-Fi 5 至少，Wi-Fi 6 优先
- BLE 版本：BT 5.x（5.0 以上）
- 天线：是否含板载天线或需外接 FPC 天线
- 待机功耗：深度休眠电流（目标 < 1 mA）
- 配网方式：支持 BLE 辅助配网（蓝牙 provisioning）
- 认证资料：是否有 FCC/CE/SRRC 认证（若后续量产或出口）

***
## 五、算力（NPU）
### 5.1 方案确认
RK3568 片上 NPU **1 TOPS @ INT8**，恰好落在你需求的 1–3 TOPS 轻量区间。支持：[^20][^29][^19]
- 框架：TensorFlow、Caffe、TFLite、PyTorch、ONNX[^19]
- 模型格式：通过 RKNN-Toolkit 转换为 .rknn 格式部署[^19]
- 精度：INT4/INT8/INT16/FP16/BFP16 混合量化[^19]
- 典型应用：手写体 OCR、笔画识别、草图分类、边缘 LLM 小模型推理

若需要更高算力（3–6 TOPS），可升级至 **RK3576**（6 TOPS，支持双核 NPU 协作），但功耗散热和成本相应增加。[^27][^28]

**询价时必须带上的规格参数**（参照图示）：
- NPU 算力：1–3 TOPS（RK3568 满足）
- 工具链：RKNN-Toolkit 版本，是否支持 ONNX/PyTorch 导入
- 模型格式：.rknn 部署
- 功耗：NPU 激活时功耗（参考 RK3568 典型 2–3 W 整机）
- 散热：无风扇被动散热是否满足（10.3 寸平板无风扇需求）

***
## 六、电源模组
### 6.1 软包锂电池
目标规格：4000–5000 mAh，超薄软包（Lipo），适合 10 寸平板形态。

参考型号和尺寸：
- **LP955060**（3.7 V，4000 mAh，14.8 Wh）：尺寸约 9.5×50×61 mm，IEC62133 认证[^30]
- **105573**（3.7 V，5000 mAh，18.5 Wh）：尺寸 10×55×73 mm[^31]
- 墨水屏设备典型实测：4000 mAh 在轻度使用场景下可用 3 周，重度使用约 5 天（参考 E Ink 官方数字纸平台数据）[^12]

**采购渠道**：
- 深圳软包电池厂（惠州/东莞），最低起订 1 片可定制：可搜索 `超薄软包锂电 4000mAh 10mm以内` 或联系深圳电池厂直接定制尺寸
- **sz-battery.com**、lipobatteries.net 等有规格现货[^31][^30]
- 立创商城 / 淘宝也有 3.7 V 4000 mAh 软包现货，但需自行确认厚度和尺寸
### 6.2 保护板 + Fuel Gauge + 充电管理
| 芯片 | 功能 | 型号 | 采购 |
|------|------|---------|------|
| 保护 IC | 过充/过放/短路保护 | DW01 + 8205（入门）；**BQ2980**（TI，精确保护）[^32] | 立创商城现货 |
| Fuel Gauge | 精确 SOC 计量，I2C 输出 | **BQ27Z561**（TI，1S 单节，Impedance Track™）[^32] | TI 官网 / 立创商城 |
| PMIC / 充电 IC | USB-C 输入充电管理 | **BQ25896**（TI，5 V/9 V QC 支持）；或 **SC8886**（南芯，国产替代，带 NVDC） | 立创商城现货 |
| 升压/降压 | 5 V 输出给主控 | **TPS63020** 或 **SY8127** | 立创商城 |

**询价时必须带上的规格参数**（参照图示）：
- 电池容量：4000–5000 mAh
- 尺寸约束：厚度 < 10 mm（超薄软包），适配 10.3 寸机身
- 保护板：DW01+8205 或 BQ2980，含过流保护
- Fuel Gauge：I2C 接口，精度 ±1% SOC，支持 Android 集成
- USB-C 充电功率：≥ 10 W（5 V/2 A 或 9 V/2 A PD）
- PMIC：是否含 NVDC（即插即用，不依赖电池供电）

***
## 七、存储与安全
### 7.1 存储
64 GB eMMC 通常已集成在 RK3568 核心板上（FET3568-C 可选 64 GB 配置）。[^24]
要求额外预留 MicroSD 卡槽（SDIO 3.0），方便调试期间刷写固件和文档扩容。
### 7.2 安全框架（RK3568 + OP-TEE）
RK3568 基于 ARM TrustZone，Rockchip 官方 BSP 包含完整 **ARM Trusted Firmware + OP-TEE OS** 安全世界实现：[^21]

| 安全特性 | 实现方式 | 说明 |
|---------|---------|------|
| 安全启动（Secure Boot） | BL1→BL2→BL31→BL32 签名链[^21] | 每级 bootloader 均被前一级签名验证，固件无法被任意替换 |
| TEE（可信执行环境） | OP-TEE OS（Secure EL1）[^21][^33] | 隔离敏感数据（密钥、笔记加密）与普通 Android 世界 |
| OTA 签名校验 | Android Verified Boot（AVB）+ OP-TEE TA | Recovery 验签，防刷机攻击 |
| 系统级文件加密 | Android FBE（File-Based Encryption）或 Linux dm-crypt | 用户数据分区加密，密钥由 TEE 管理 |
| 数据擦除 | Android Factory Reset Protection（FRP）或 `dm-crypt` wipe | 远程或本地触发，密钥销毁即不可恢复 |
| 安全存储 | OP-TEE Secure Storage（加密签名后存文件系统）[^34] | TA 在安全世界内加密并签名持久化数据 |

如需更强硬件安全根（HSM/eSE），纳入后续评估外挂 **NXP EdgeLock SE05x** 安全元件，通过 I2C 与 OP-TEE 集成，提供硬件级密钥存储和加密协处理器。[^35]

**询价时必须带上的规格参数**（参照图示）：
- 存储容量：64 GB eMMC（核心板集成）
- 安全启动：是否已烧录 Rockchip OTP，支持 secure boot 签名链
- TEE：OP-TEE 版本（要求 3.x），是否提供 TA SDK
- OTA 签名：Android AVB2.0 或等效，是否提供 OTA 工具链
- 数据擦除：支持 Android FRP 或 dm-crypt 密钥销毁
- 核心板厂商是否提供 OP-TEE BSP 源码（飞凌嵌入式官方提供）

***
## 八、BOM 总览与采购渠道速查
| 单元 | 关键规格 | 型号/方案 | 采购渠道 | 价格参考 |
|------|---------|--------------|---------|---------|
| 彩色电子纸模组 | 10.3″，Kaleido 3，300/150 PPI，ComfortGaze 前光 | E Ink ED103TC2 | shopkits.eink.com（B2B）/ DKE HK / 深圳代理 | 单件约 $200–$449，需询价[^6][^7] |
| EMR 触控层 | 10.3″ 感应板，无源笔，4096 压感，22 ms 延迟 | 汉王友基 EMR 模组 | business.hanvonugee.com | 商务询价[^14][^16] |
| 主控核心板 | RK3568，4 GB，64 GB eMMC，EBC 接口，1 TOPS NPU | 飞凌 FET3568-C | forlinx.net / 淘宝飞凌旗舰店 | ≈ 400–600 元（4+32 GB）；64 GB 版本询价[^36][^26] |
| Wi-Fi/BT | 双频 2.4/5 GHz，BLE 5.x | AP6275P 或 RTL8852BE | 立创商城 / 华强北 | 20–80 元/片 |
| NPU | 1 TOPS，RKNN，ONNX | 已含于 RK3568 片上 | — | — |
| 软包锂电 | 4000–5000 mAh，< 10 mm 厚，3.7 V | LP955060 / 105573 或定制 | sz-battery.com / 深圳电池厂 / 立创 | 30–80 元/片[^31][^30] |
| 保护板 + FG | BQ2980 保护 + BQ27Z561 Fuel Gauge | TI BQ27Z561 + BQ2980 | 立创商城 / TI 官网 | FG 约 30–50 元，保护板 5–20 元[^32] |
| USB-C 充电 IC | 10 W+，USB PD，NVDC | BQ25896 / SC8886 | 立创商城 | 15–40 元 |
| 安全 | OP-TEE + AVB + FBE | RK3568 + Rockchip BSP 内置 | 随核心板 BSP 提供 | 含于核心板授权[^21] |

***
## 九、关键风险与注意事项
### 9.1 显示层
- **Kaleido 3 模组波形授权**：E Ink 对波形文件（waveform）有许可控制，商用产品需单独申请 waveform license，DIY 原型期间可参考开源 EPDiy 项目或使用 IT8951 驱动板自带 waveform[^37]
- **局刷策略**：彩色模式刷新慢（约 500 ms–1 s），要求前台笔迹用黑白快刷（A2 模式 < 120 ms），后台空闲时再做彩色合成刷新[^2][^38]
- **全刷维护**：每 50 次局刷后触发一次全刷（GC16），避免残影积累[^38]
### 9.2 EMR 层
- **堆叠视差**：EMR 感应板和前盖板厚度直接影响笔尖偏移，要求前盖板 ≤ 1.5 mm，光学贴合（OCA 胶）而非气隙
- **EMR 与触控共存**：若同时要多点电容触控 + EMR，需注意信号干扰，要求时分复用或选成熟的带双层（EMRT + 电容）一体方案
### 9.3 主控/电源
- **EBC 接口驱动**：RK3568 EBC 最高支持 2200×1650，已覆盖 10.3 寸 1860×2480；但需确认核心板厂商是否提供成熟的 EBC + waveform controller BSP[^11]
- **供电噪声**：墨水屏刷新瞬时电流（通常 50–200 mA 峰值）会造成电压跌落，要求主控和屏驱分独立 LDO/DC-DC，加充足去耦电容
### 9.4 安全层
- **OP-TEE 版本**：Rockchip 官方 BSP 默认集成，但源码对外部开发者可能有延迟，要求选用飞凌等提供完整 BSP 源码的板卡厂商[^21]
- **OTA 签名链**：若后期做 OTA 升级，需在量产前烧录 OTP 密钥，一旦烧录无法回退

---

## References

1. [E Ink Kaleido™ 3｜E Ink Brand](https://www.eink.com/brand/detail/Kaleido3) - The E Ink Kaleido 3 module is available in various panel sizes, including 7.8-inch, 10.3-inch, and 1...

2. [BOOX ePaper with Kaleido 3: The Duet of Efficiency and Color](https://shop.boox.com/blogs/news/kaleido-3-color-epaper) - Kaleido 3 is E Ink's latest generation of print color display technology for ePaper products. Compar...

3. [Bigme inkNote Color+ promises first 10.3-inch Kaleido 3 color E Ink ...](https://www.notebookcheck.net/Bigme-inkNote-Color-promises-first-10-3-inch-Kaleido-3-color-E-Ink-display.697454.0.html) - The tablet has a 10.3-inch Kaleido 3 E Ink display that supports 1860 x 2480 (300 PPI) using greysca...

4. [E Ink Kaleido 3彩色印刷電子紙](https://tw.eink.com/brand/detail/Kaleido3) - E Ink元太科技為全球電泳式電子紙顯示技術的領導開發商與供應商。以最先進的技術，提供全球知名品牌及製造商耐用、低耗電的電子紙模組，協助客戶開發新產品、創造新市場，並持續拓展電子紙的多元應用。

5. [Kaleido - E Ink Online Shop - ePaper Display Kits](https://shopkits.eink.com/en/product?cate=Kaleido+Plus) - E Ink Online Shop provides the best ePaper display evaluation kits for developers. Offering a wide r...

6. [It has 229 pixels per inch based on the E in Gallery 3 display. On E ...](https://news.ycombinator.com/item?id=41445650)

7. [7 8 e ink kaleido 3 color epaper display - Accio](https://www.accio.ai/find-product/7-8-e-ink-kaleido-3-color-epaper-display) - Discover the 7.8-inch E-Ink Kaleido 3 color epaper display for superior readability. Ideal for e-rea...

8. [E ink display 10 inch](https://www.alibaba.com/showroom/e-ink-display-10-inch.html) - E ink display 10 inch - High-quality electronic paper for ereaders and tablets. Enjoy clear, sharp i...

9. [RK3568-墨水屏电子书](https://oshwhub.com/eda_cflrsmlad/rk3568-mo-shui-ping-dian-zi-shu) - RK3568的EINK demo板，支持4.7到13.3大部分并口墨水屏，安卓11系统

10. [RK3568](https://www.rock-chips.com/a/cn/product/RK35xilie/2021/0113/1275.html) - 瑞芯微专注于移动互联网、数字多媒体芯片设计，是专业的个人移动信息终端SOC解决方案供应商。瑞芯微在移动互联网领域有多个较完整的自主创新的知识产权群，为中国电子业发展做出积极努力。目前产品涵盖Andro...

11. [[PDF] Rockchip RK3568 Datasheet](https://dl.radxa.com/rock3/docs/hw/datasheet/Rockchip-RK3568-Datasheet-V1.0-20201210.pdf)

12. [Digital Paper Tablet Solution for Business - E Ink](https://go.eink.com/digital-paper-tablet-new) - White label tablets in two sizes: 10.3” and 13.3” · Integrated applications and development tools · ...

13. [H103NPL E Ink Android Tablet Upgrades ...](https://www.seekink.com/product/h103npl-e-ink-tablet/) - Powered by Android, the 10.3-inch e ink tablet delivers a paper-like viewing experience with no blue...

14. [EMR Pen Touch/Handwriting Module (with Screen) - Ugee signature](https://business.hanvonugee.com/en/screen/135) - (1) Inductive handwriting solution, the resolution of the original stroke reproduction is up to 5080...

15. [PineNote - PINE64](https://pine64.org/devices/pinenote/) - One of the most powerful Linux-based Eink tablets Introducing the PineNote – A new early adopter Lin...

16. [EMR Pen Touch/Handwriting Module - Ugee signature](https://business.hanvonugee.com/en/signing/59) - 10" Electronic Signature Pad. Customer Support Contact Information Company Address. Hanvon Ugee Tech...

17. [Morgan Touch l EMR multi-pen solution](https://www.morgan-touch.com/en/product_1207166.html) - EMR Modules are available from sizes 5" to 86" or larger depending on your personnal requirements. M...

18. [Repurposing old S-Pen for e-ink tablet with Wacom EMR technology](https://www.facebook.com/groups/kakirepair/posts/7999301426816744/) - Like described earlier, the Wacom layer behind the tablet screen creates a pulsing magnetic field at...

19. [OK3568-C Single Board Computer Based on Rockchip RK3568 ...](https://www.forlinx.net/single-board-computer/rk3568-sbc-126.html) - FET3568-C SoM is equipped with quad-core 64-bit Cortex-A55 processor with built in NPU based on adva...

20. [as-jackson/RK3568-Development-Board: RK3568 ... - GitHub](https://github.com/as-jackson/RK3568-Development-Board) - The ArmSoM-Sige3 features the Rockchip RK3568B2, a high-performance and low-power quad-core applicat...

21. [Trust Developer Guide](http://weike-iot.com:2211/rockchip/bsp/rk3568_linuxSDK/sdkV1.4.0_linux5.10/docs/en/Common/TRUST/Rockchip_Developer_Guide_Trust_EN.pdf)

22. [RK3568核心板+ RK3568开发板硬件规格、功耗与接口问题排查 - 飞凌](https://www.forlinx.com/article-new-c22/1474.html) - 本文全面解析瑞芯微RK3568国产高性能处理器及其配套硬件方案。内容涵盖处理器四核A55架构与1TOPS NPU算力特性，RK3568核心板的差异对比与硬件规格 ...

23. [搭载瑞芯微智慧教育方案芯品，亮相教育装备展](https://www.rock-chips.com/a/cn/news/rockchip/2021/0510/1390.html) - 本次展会上，国文展出了搭载RK3566的10.3寸智能电子纸手写本，采用电子墨水柔性屏，227ppi清晰度，支持前光多点电容触控/电磁手写，传统纸张的书写体验，支持 ...

24. [RK3568 Series - Forlinx Embedded Technology Co., Ltd.](https://www.forlinx.net/product-list-183.html) - The RK3568 System on Module (SoM) based on Rockchip features quad-core 64-bit 2.0GHz ARM Cortex-A55.

25. [FORLINX FET3568-C RK3568 Octa-Core Embedded Development ...](https://www.alibaba.com/product-detail/FORLINX-FET3568-C-RK3568-Octa-Core_1601686794256.html) - FORLINX FET3568-C RK3568 Octa-Core Embedded Development Board System on Module Linux/Android/Ubuntu ...

26. [飞凌嵌入式开发板品牌 - 淘宝逛一逛](https://guangtao.taobao.com/product-e30f84bffe83189246641d10f97a1d515d8851ecd2d308b0f6bc9ed822102f39.html) - 淘宝逛一逛为你精选飞凌嵌入式开发板的商品，基于您的喜好，对飞凌嵌入式开发板的商品销量、评价、价格趋势智能选定，助你轻松选到适合自己的飞凌嵌入式开发板。

27. [.](https://www.rockchips.net/wp-content/uploads/2025/03/Rockchip-RK3576-Datasheet-V1.5-20241216.pdf)

28. [[PDF] RK3576](https://www.rock-chips.com/uploads/pdf/2024.3.18/192/RK3576%20Brief%20Datasheet.pdf)

29. [RK3568 Industrial Panel PC | All-in-One Android Tablet - Geniatech](https://www.geniatech.com/product/rk3568-tablet/) - Rockchip RK3568 ARM Quad-core ARM Cortex-A55 processor@2.0GHz · ARM Mali-G52 GPU, support OpenGL ES1...

30. [4P 4400mAh 16.28Wh CB LiPo Batteries LP653450](https://www.lipobatteries.net/hot-selling-lipo-battery/4000mah-5000mah-hot-selling-lipo-battery/rechargeable-high-capacity-lipo-batteries-with-ntc-4p-lp653450-17600mah-65-12wh/) - Newest Longest Lasting Rechargeable High Capacity LiPo Batteries with Fast charging, High Quality an...

31. [li-ion battery 105573 3.7v 5000mah lipo battery for power bank](https://www.sz-battery.com/lithium-polymer-battery/4000mah-5000mah/288.html) - Model: 105573, Voltage: 3.7v Capacity: 5000mAh Size: T10.0*W55*H73mm with PCM Protection board: DW01...

32. [BQ27Z561EVM-011](https://www.ti.com/tool/BQ27Z561EVM-011) - View the TI BQ27Z561EVM-011 Evaluation board description, features, development resources and suppor...

33. [arXiv:2203.01025v1 [cs.CR] 2 Mar 2022](https://arxiv.org/pdf/2203.01025.pdf)

34. [The LPC Android microconference, part 2](https://lwn.net/Articles/708680/) - The Linux Plumbers Android microconference was held in Santa Fe on November 3rd; this is the se [......

35. [Embedded Recipes 2022 - Secure Elements in a Trusted Execution Environment](https://www.youtube.com/watch?v=GsMRqb6zomY) - A Secure Element is a tamper resistant device that provides secure storage and an execution environm...

36. [低至288元！飞凌嵌入式RK3568核心板「1+8GB」配置上新](https://www.forlinx.com/article-new-c22/1092.html) - 2022年，飞凌嵌入式推出了基于瑞芯微RK3568处理器打造的FET3568/3568J-C核心板，作为集高性能和低功耗于一身的全能型选手，飞凌嵌入式RK3568系列核心板产品一经问世便得到了不俗的市...

37. [asapelkin/awesome-eink: A curated list of awesome E-ink ...](https://github.com/asapelkin/awesome-eink) - A curated list of awesome E-ink links and resources. - asapelkin/awesome-eink

38. [电子纸（墨水屏）技术应用手册（精编版） - 爱上生活](https://23live.cn/iot/eink-display-manual/)
