# 10.3 英寸彩色电子纸设备 BOM 采购调研 v0.1

> 目标：围绕 **10.3 英寸彩色电子纸 + 触控/笔 + 前光 + 驱动板 + 低功耗主控 + 无线 + NPU + 电池电源 + 安全存储**，梳理 EVT 阶段可采购物料、量产阶段 RFQ 方向、必须带上的规格细节和关键风险点。
>
> 备注：价格、库存、MOQ、交期变化很快，正式下单前需要重新向供应商确认。屏幕、EMR 笔、waveform 授权要求以供应商正式报价单和技术规格书为准。

---

## 1. 图片中“询价/搜索时必须带上”的规格要求

| 单元 | 询价/搜索必须带上的规格 |
|---|---|
| 屏幕 | 尺寸、分辨率、彩色 PPI、色彩数、刷新模式、前光、驱动板、波形授权 |
| 触控笔 | 笔方案、压感、报点率、视差、掌托误触、笔尖耗材、侧键 / 尾擦 |
| 主控 | CPU、RAM、存储、低功耗、接口、BSP、电子纸驱动适配 |
| 通信 | Wi‑Fi 频段、BLE 版本、天线、待机功耗、配网方式、认证资料 |
| 算力 | 是否有 NPU、TOPS、工具链、模型格式、功耗、散热要求 |
| 电源 | 电池 Wh、尺寸、厚度、保护板、fuel gauge、PMIC、充电功率 |
| 安全 | 存储容量、安全启动、TEE / 安全芯片、OTA 签名、数据擦除 |

---

## 2. 总体采购结论

### 2.1 屏幕路线

**最终产品要求走整屏 Stack RFQ：**

- 10.3 英寸 E Ink Kaleido 3 / CFA 彩色电子纸
- 前光模组
- 电容触控层
- EMR 无源电磁笔 digitizer
- 无源电磁笔
- TCON / 驱动板
- waveform 授权
- Linux / Android 驱动和 demo

不要只买裸屏。彩色电子纸真正难点在 **waveform、温度补偿、刷新残影、前光均匀性、笔校准和掌托误触**。这些如果拆开采购，后期集成风险会很高。

### 2.2 主控路线

主控锁定 **NXP i.MX 8M Plus** 生态，原因：

- 四核 Cortex-A53，符合“四核低功耗应用处理器”要求
- 可选 4GB RAM + 64GB eMMC 的核心板
- 内置轻量 NPU，约 2.3 TOPS，符合 1–3 TOPS 目标
- Linux BSP / Android BSP 资料完整
- USB、SPI、I²C、GPIO、无线模组、电源管理适配相对成熟

### 2.3 EVT 阶段要求

EVT 阶段不要等最终彩色屏全部定完，可先买 **10.3 英寸黑白电子纸 + 前光 + 电容触控 + TCON** 跑通系统：

- 主控启动
- 电子纸刷新
- 前光控制
- 电容触控
- UI 框架
- 电源路径
- OTA 和安全机制

彩色屏 + EMR 笔 + 掌托误触作为并行 RFQ 和样品验证。

---

## 3. BOM 采购总表

| 模块 | 采购方案件 / 方案 | 采购渠道 | 必须确认的规格细节 | 阶段 | 风险等级 |
|---|---|---|---|---|---|
| 10.3 彩色电子纸整屏 | E Ink Kaleido 3 / CFA 10.3 英寸整屏 Stack：EPD + 前光 + CTP + EMR + TCON + waveform | E Ink、Good Display、BECK、电子纸模组集成商 | 10.3 英寸、黑白 PPI、彩色 PPI、4096 色、分辨率、刷新模式、前光参数、TCON 接口、waveform 授权、温度补偿 | 量产 RFQ | 高 |
| EVT 电子纸样品 | Good Display / Buy-LCD GDEP103TC2-FT11 + DEJA-TC103 / IT8951 TCON | Good Display、Buy-LCD、BuyEpaper | 10.3 英寸、1404×1872、触控、前光、TCON、接口、驱动支持 | EVT | 中 |
| 无源电磁笔 | Wacom EMR 或 Hanvon Ugee EMR digitizer + passive pen | Wacom Components、Hanvon Ugee、屏幕模组厂打包 | 无源笔、压感、报点率、hover 高度、视差、侧键、尾擦、笔尖寿命、接口、驱动 | EVT / 量产 | 高 |
| 掌托误触 | EMR proximity + 电容触控抑制 + OS 事件过滤 | 触控 / EMR / 屏幕模组供应商联合确认 | 笔靠近时 CTP 抑制策略、palm rejection SDK、笔手分离、边缘误触、demo 视频 | EVT / 量产 | 高 |
| 主控核心板 | Variscite VAR-SOM-MX8M-PLUS，要求 4GB RAM + 64GB eMMC + Wi‑Fi/BLE 配置 | Variscite 官方、代理商 | Quad Cortex-A53、4GB LPDDR4、64GB eMMC、USB、SPI/I²C/GPIO、BSP、低功耗 | EVT / 量产 | 中 |
| 主控开发板备选 | NXP FRDM-IMX8MPLUS | NXP、DigiKey、Mouser、代理商 | i.MX 8M Plus、4GB LPDDR4、eMMC、USB-C、Wi‑Fi/BT、Linux BSP | 快速验证 | 低 |
| 双频 Wi‑Fi + BLE 5.x | u-blox MAYA-W276，或 Murata Type 2EL / 2DL | DigiKey、Mouser、Arrow、Avnet、代理商 | 2.4/5GHz、BLE 5.x、SDIO/PCIe/UART、天线、认证、Linux 驱动、待机功耗 | EVT / 量产 | 中 |
| NPU | i.MX 8M Plus 内置 NPU | 随主控采购 | 1–3 TOPS、INT8、TensorFlow Lite、ONNX Runtime、功耗、散热 | EVT / 量产 | 低 |
| 电池 | 4000–5000mAh 超薄软包电池，例如 3.7V 4500mAh，3.3–4.2mm 厚度区间 | LiPoBattery、国内软包电池厂、电池方案商 | 容量、Wh、厚度、长宽、PCM 保护板、NTC、线长、连接器、UN38.3、MSDS、IEC62133 | EVT / 量产 | 中 |
| Fuel gauge | TI BQ27441-G1，或 MAX17048 类单节电池计量芯片 | TI、DigiKey、Mouser、立创 | 单节 Li-ion、SOC%、电压、剩余容量、I²C、低功耗、Linux 驱动 | EVT / 量产 | 低 |
| USB-C 充电 | TI BQ25628 / BQ25629，或 BQ25895 | TI、DigiKey、Mouser、立创 | USB-C CC、充电电流、power-path、NTC、热限制、OTG、ESD/OVP | EVT / 量产 | 中 |
| 64GB 存储与安全 | SoM 上选 64GB eMMC 5.1；系统侧做 secure boot + 加密 + 签名 OTA + 擦除 | Variscite、Kioxia / Micron / Samsung eMMC 供应链 | 64GB eMMC、RPMB、secure boot、fscrypt/dm-crypt、RAUC/AVB、factory reset、crypto erase | EVT / 量产 | 中 |

---

## 4. 屏幕与触控笔

### 4.1 最终屏幕方案

#### 采购方案

**10.3 英寸 E Ink Kaleido 3 / CFA 彩色电子纸整屏 Stack**

要求向供应商明确要求：

- 10.3 英寸彩色电子纸面板
- 前光
- 电容触控层
- EMR 无源笔 digitizer
- 无源电磁笔
- TCON / 驱动板
- waveform 授权
- 连接线 / FPC / 转接板
- Linux / Android 驱动
- 刷新 demo 和书写 demo

#### 重点规格

| 项目 | 要求 |
|---|---|
| 尺寸 | 10.3 英寸 |
| 彩色路线 | E Ink Kaleido 3 / CFA 彩色滤光层电子纸 |
| 黑白显示 | 300 PPI 级别优先 |
| 彩色显示 | 150 PPI 级别优先 |
| 色彩数 | 4096 色级别 |
| 前光 | 亮度、均匀性、色温、LED 数量、功耗必须确认 |
| 刷新模式 | 全刷、局刷、快速模式、灰阶模式、彩色刷新时间 |
| 驱动板 | TCON / controller board，确认 USB / SPI / I80 / TTL / MIPI 等接口 |
| waveform | 必须确认是否包含、是否绑定面板批次、是否支持温度补偿 |
| 软件 | Linux / Android 驱动、demo、API 文档 |
| 量产 | MOQ、样品价、1k / 5k / 10k 价格、交期、NRE |

#### 询价对象

| 供应商 / 渠道 | 角色 | 备注 |
|---|---|---|
| E Ink | 原厂 / 技术源头 | 适合确认 Kaleido 3、waveform、授权边界 |
| Good Display | 电子纸模组供应商 | 适合拿样品、TCON、前光触控方案 |
| BECK | E Ink 分销 / 集成支持 | 可询驱动板、光学贴合、前光组合、技术支持 |
| 电子纸模组集成商 | 整屏 Stack 集成 | 适合定制“EPD + 前光 + CTP + EMR + TCON”完整方案 |

---

### 4.2 EVT 屏幕替代件

#### 采购方案

**Good Display / Buy-LCD GDEP103TC2-FT11 + DEJA-TC103 / IT8951 TCON**

这套更适合做 EVT，不直接当最终彩色量产屏：

- 优点：10.3 英寸、前光、触控、驱动板路径清晰，适合先跑系统
- 缺点：不是最终彩色屏，不能验证 Kaleido 彩色刷新、色彩残影和色彩显示效果

#### 用途

| 用途 | 说明 |
|---|---|
| 电子纸刷新 | 验证 TCON、驱动、局刷、全刷、UI 刷新策略 |
| 前光 | 验证亮度调节、PWM、功耗、均匀性初步体验 |
| 触控 | 验证触摸事件、边缘误触、UI 手势 |
| 主控接口 | 验证 USB / SPI / GPIO / I²C 等控制链路 |
| 电源 | 验证电子纸峰值功耗、前光功耗、电源路径 |

---

### 4.3 无源电磁笔 + 触控层

#### 采购方案

- Wacom EMR digitizer + passive pen
- Hanvon Ugee EMR digitizer + passive pen
- 或由屏幕模组厂直接打包提供：EPD + CTP + EMR + pen

#### 必须确认的规格

| 项目 | 需要确认 |
|---|---|
| 笔类型 | 无源电磁笔 / passive pen / battery-free pen |
| 压感 | 压感等级，最好提供实际曲线 |
| 报点率 | 书写报点率，要求供应商提供 demo 数据 |
| hover | 笔悬停高度，关系到掌托误触策略 |
| 视差 | 电子纸面板 + 前光 + 触控 + EMR 叠层后的实际视差 |
| 延迟 | 从落笔到显示墨迹的系统端到端延迟 |
| 侧键 / 尾擦 | 是否支持侧键、橡皮擦、快捷键 |
| 笔尖耗材 | 笔尖材质、寿命、替换成本 |
| 接口 | USB / I²C / UART / HID 等 |
| 驱动 | Linux / Android 驱动、SDK、校准工具 |

---

### 4.4 掌托误触

掌托误触不采用当成一个单独 BOM 物料采购，而应该作为 **屏幕 + 触控 + EMR + 系统驱动** 的联合指标。

执行策略：

1. EMR 检测到笔 hover 后，系统进入“书写优先模式”
2. 电容触控短时间降权或屏蔽大面积触摸
3. OS 输入层区分 pen / finger / palm 事件
4. 应用层只接收有效笔迹和必要手势
5. 边缘区域单独做误触过滤

#### RFQ 中必须要求供应商提供

- 掌托误触 demo 视频
- 笔靠近时 CTP 抑制策略
- Linux / Android 驱动说明
- 笔手分离 API
- 校准工具
- 延迟测试结果
- 大面积手掌覆盖时的书写测试结果

---

## 5. 主控、无线与 NPU

### 5.1 主控核心板

#### 首选

**Variscite VAR-SOM-MX8M-PLUS**

配置：

| 项目 | 配置 |
|---|---|
| SoC | NXP i.MX 8M Plus |
| CPU | Quad Cortex-A53 |
| RAM | 4GB LPDDR4 |
| 存储 | 64GB eMMC |
| NPU | 内置，约 2.3 TOPS |
| 无线 | 选择带 Wi‑Fi / BLE 的配置，或外接无线模块 |
| USB | USB-C / USB 3.0 / USB 2.0 视载板实现 |
| BSP | Linux BSP / Android BSP |
| 外设 | SPI、I²C、GPIO、UART、PWM，用于电子纸、触控、前光、电源管理 |

#### 为什么适合

- 满足四核低功耗应用处理器要求
- 可配置 4GB RAM + 64GB eMMC
- 内置轻量 NPU，符合 1–3 TOPS 目标
- 工业核心板路线，适合从 EVT 过渡到量产
- 生态和 BSP 成熟度较高

---

### 5.2 快速验证开发板备选

#### 备选

**NXP FRDM-IMX8MPLUS**

适合快速验证：

- i.MX 8M Plus
- Linux BSP
- NPU 工具链
- USB-C
- Wi‑Fi / BT
- 应用层软件

注意：该板常见配置不一定满足最终 64GB 存储要求，因此更适合前期软件和 NPU 验证，不采用作为最终 BOM 直接照搬。

---

### 5.3 双频 Wi‑Fi + BLE 5.x

#### 采购方案

优先级：

1. 若主控核心板已有认证 Wi‑Fi / BLE 模组，优先使用 SoM 原配无线
2. 若需要外接，选 u-blox / Murata 这类有认证和 Linux 驱动资料的模组

#### 方向

| 模组 | 说明 |
|---|---|
| u-blox MAYA-W276 | 双频 Wi‑Fi + BLE 5.x，资料和认证较完整 |
| Murata Type 2EL / 2DL | 常见于 NXP / Linux 生态，适合量产项目 |

#### 必须确认

| 项目 | 说明 |
|---|---|
| 频段 | 2.4GHz + 5GHz 双频 |
| BLE | BLE 5.x，要求 BLE 5.2 / 5.3 / 5.4 优先 |
| 接口 | SDIO / PCIe / UART / PCM，需匹配主控 |
| 天线 | PCB 天线 / 外接天线 / 天线座 / 净空区要求 |
| 功耗 | 待机功耗、联网功耗、BLE 广播功耗 |
| 认证 | FCC / CE / SRRC / TELEC 等目标市场认证资料 |
| 驱动 | Linux 驱动、firmware、蓝牙协议栈兼容性 |
| 配网 | BLE 配网、SoftAP 配网、二维码配网等 |

---

### 5.4 轻量 NPU

#### 方案

直接使用 **i.MX 8M Plus 内置 NPU**。

#### 目标规格

| 项目 | 要求 |
|---|---|
| 算力 | 1–3 TOPS |
| 精度 | INT8 优先 |
| 模型格式 | TensorFlow Lite、ONNX Runtime 优先 |
| 工具链 | NXP eIQ、TFLite delegate、ONNX Runtime、OpenCV |
| 场景 | OCR、手写识别、关键词提取、离线轻量分类、版面识别 |
| 功耗 | 需要测 NPU 推理时整机功耗和温升 |
| 散热 | 电子纸设备一般无风扇，需要确认长时间推理温升 |

---

## 6. 电池、电源与充电

### 6.1 电池

#### 采购方案

4000–5000mAh 超薄软包电池，先买两种尺寸做结构堆叠：

| 方案 | 示例规格 | 适用情况 |
|---|---|---|
| 窄长型 | 3.7V 4500mAh，约 4.2 × 63 × 134mm | 适合内部有窄长空间的结构 |
| 薄片型 | 3.7V 4500mAh，约 3.3 × 100 × 108mm | 适合大面积但厚度受限的结构 |

#### 必须确认

| 项目 | 说明 |
|---|---|
| 容量 | 4000–5000mAh |
| 能量 | Wh，4500mAh × 3.7V 约 16.65Wh |
| 厚度 | 3.3–4.2mm 级别优先，看结构堆叠 |
| 保护板 | PCM / protection board 是否已带 |
| NTC | 是否带温度检测 |
| 连接器 | JST / Molex / 定制线束 |
| 线长 | 按结构位置定制 |
| 认证 | UN38.3、MSDS、IEC62133、运输资料 |
| 充放电电流 | 满足前光、主控峰值、电源路径需求 |

---

### 6.2 Fuel gauge

#### 器件

| 器件 | 说明 |
|---|---|
| TI BQ27441-G1 | 单节锂电 fuel gauge，I²C，适合电子纸类低功耗设备 |
| MAX17048 | 常见单节锂电 fuel gauge，集成简单 |

#### 必须确认

- SOC 百分比精度
- 剩余容量估算
- 电压读取
- 温度补偿
- 休眠功耗
- Linux 驱动支持
- 电池模型配置方式

---

### 6.3 USB-C 充电 / PMIC

#### 器件

| 器件 | 定位 | 备注 |
|---|---|---|
| TI BQ25628 / BQ25629 | 2A 单节锂电开关充电器 | 适合保守充电功率，热设计压力较小 |
| TI BQ25895 | 5A 单节锂电充电管理 + power-path | 适合更高充电功率，但要认真做热设计 |

#### 必须确认

| 项目 | 说明 |
|---|---|
| USB-C CC | 是否需要独立 CC controller 或简单 Type-C Sink 识别 |
| 充电电流 | 1A / 2A / 更高，按电池和热设计决定 |
| Power-path | 插电时系统供电和电池充电路径 |
| NTC | 电池温度保护 |
| 热限制 | 充电芯片温升和降额策略 |
| OTG | 是否需要反向供电 |
| 保护 | ESD、OVP、OCP、短路保护 |

---

## 7. 64GB 存储、安全启动、加密、OTA、数据擦除

### 7.1 存储

要求在 SoM 阶段直接选 **64GB eMMC 5.1**，不要后期再外挂存储。

#### 必须确认

| 项目 | 说明 |
|---|---|
| 容量 | 64GB |
| 类型 | eMMC 5.1 优先 |
| RPMB | 用于安全计数器、密钥相关认证访问 |
| 寿命 | TBW / P/E cycle / wear leveling |
| 工业温度 | 如果目标需要，确认工业级料号 |
| 供应链 | Kioxia / Micron / Samsung / SanDisk 等多来源策略 |

---

### 7.2 系统级安全要求

| 需求 | 实现方式 |
|---|---|
| 安全启动 | i.MX secure boot / HAB / 签名启动链 |
| 系统级文件加密 | Linux fscrypt 或 dm-crypt；Android 路线用 FBE |
| 密钥保护 | SoC 安全区、TEE、RPMB、硬件唯一密钥机制 |
| OTA 签名校验 | Linux 路线可用 RAUC / SWUpdate；Android 路线用 AVB / A/B OTA |
| 回滚保护 | 结合 RPMB / bootloader rollback index |
| 数据擦除 | factory reset + crypto erase，优先销毁密钥而不是逐块擦写 |
| 维修模式 | 维修/调试口权限管控，量产禁用未授权调试 |

---

## 8. EVT 第一批采购方案

| 采购项 | 数量 | 目的 | 备注 |
|---|---:|---|---|
| 10.3 英寸电子纸 + 前光 + CTP + TCON 套件 | 1–2 套 | 验证电子纸显示、前光、触控、UI 刷新 | 可先用黑白屏替代最终彩屏 |
| Variscite VAR-SOM-MX8M-PLUS Eval Kit，4GB + 64GB | 1 套 | 验证最终主控路线 | 直接选目标配置 |
| NXP FRDM-IMX8MPLUS | 0–1 套 | 低成本快速验证 i.MX 8M Plus / NPU | 非必须 |
| Wacom / Hanvon Ugee 10.3 英寸 EMR digitizer + passive pen | 1–2 套 | 验证无源笔、压感、hover、掌托误触 | 优先找可贴合电子纸的方案 |
| 4500mAh 超薄软包电池，窄长型 | 3–5 颗 | 结构堆叠和续航测试 | 带 PCM / NTC 优先 |
| 4500mAh 超薄软包电池，薄片型 | 3–5 颗 | 结构堆叠对比 | 重点看厚度 |
| BQ27441 fuel gauge EVK / 小板 | 2–3 套 | 验证电量计 | I²C 接主控 |
| BQ25628 / BQ25895 充电 EVK / 小板 | 2–3 套 | 验证 USB-C 充电和 power-path | 注意热设计 |
| u-blox / Murata Wi‑Fi BLE EVK | 0–1 套 | 无线验证 | 若 SoM 自带无线可先不买 |

---

## 9. 屏幕整屏 Stack RFQ 模板

### 邮件标题

```text
RFQ: 10.3 inch E Ink Kaleido 3 color ePaper module with front light, touch, EMR pen digitizer, TCON and waveform
```

### 邮件正文

```text
Hi,

We are developing a 10.3-inch color e-note device. Please quote a complete display stack, not bare panel only.

Required stack:
- 10.3" E Ink Kaleido 3 / CFA color EPD
- Front light
- Capacitive touch panel
- EMR passive pen digitizer
- Passive EMR pen
- TCON / driver board
- Cables / FPC / connector board
- Waveform license / authorization
- Linux / Android driver support

Please provide the following information:

1. Mechanical
- Active area
- Outline size
- Thickness
- Weight
- FPC position
- Connector type

2. Display
- Resolution
- B/W PPI
- Color PPI
- Color count
- Grayscale levels
- Contrast ratio
- Operating temperature
- Storage temperature

3. Refresh modes
- Full refresh time
- Partial refresh time
- A2 / fast mode support
- Grayscale mode support
- Color refresh time
- Ghosting performance
- Temperature compensation

4. Front light
- LED count
- Brightness
- Uniformity
- Color temperature
- Dimming method
- Power consumption

5. Touch
- Touch controller IC
- Interface
- Report rate
- Multi-touch support
- Edge rejection
- Glove mode if available
- Palm rejection strategy

6. EMR pen
- Passive pen support
- Pressure levels
- Report rate
- Hover height
- Side button support
- Eraser support
- Nib material and lifetime
- Pen latency test data

7. Driver / TCON
- Interface: USB / SPI / I80 / MIPI / TTL
- Supported SoC / platform
- Linux driver
- Android driver
- API documentation
- Demo application

8. Waveform
- Whether waveform is included
- Whether waveform is bound to panel lot
- License terms
- Temperature compensation support
- Mass production authorization process

9. Commercial
- Sample price
- Sample lead time
- MOQ
- NRE / tooling cost
- Price at 1k / 5k / 10k units
- Mass production lead time

10. Reliability and certification
- Reliability test report
- Front light lifetime
- Touch lifetime
- Pen digitizer lifetime
- RoHS / REACH

Thanks.
```

---

## 10. 主控核心板 RFQ 模板

### 邮件标题

```text
RFQ: i.MX 8M Plus SOM with 4GB RAM, 64GB eMMC, Wi-Fi/BLE, Linux BSP and secure boot support
```

### 邮件正文

```text
Hi,

We are developing a 10.3-inch e-note product and are evaluating an i.MX 8M Plus based SOM.

Target configuration:
- NXP i.MX 8M Plus Quad
- 4GB LPDDR4
- 64GB eMMC
- Wi-Fi 2.4/5GHz + Bluetooth / BLE 5.x
- USB-C support through carrier board
- SPI / I2C / GPIO / UART / PWM for ePaper, touch, front light and power management
- Linux BSP and Android BSP availability
- NPU support for TensorFlow Lite / ONNX Runtime
- Secure boot support
- OTA update support

Please provide:
1. Exact SOM part number for the above configuration
2. EVK price and lead time
3. SOM sample price and MOQ
4. Mass production price at 1k / 5k / 10k units
5. Power consumption data in suspend / idle / active / NPU workload
6. Wireless certification documents
7. Linux BSP version and long-term maintenance plan
8. Secure boot, RPMB and OTA reference documentation
9. Operating temperature options
10. Product longevity / availability commitment

Thanks.
```

---

## 11. 电池 RFQ 模板

### 邮件标题

```text
RFQ: 4000-5000mAh ultra-thin LiPo battery with PCM, NTC and certification documents
```

### 邮件正文

```text
Hi,

We are developing a 10.3-inch portable e-note device and are looking for an ultra-thin LiPo battery.

Target requirements:
- Capacity: 4000-5000mAh
- Nominal voltage: 3.7V
- Thickness: preferably 3.3-4.2mm
- With PCM protection board
- With NTC thermistor
- Connector and wire length can be customized
- Suitable for USB-C charging

Please provide:
1. Available standard models and dimensions
2. Capacity and Wh
3. Maximum charge current
4. Maximum discharge current
5. PCM protection specifications
6. NTC value
7. Connector options
8. Sample price and lead time
9. MOQ
10. UN38.3 / MSDS / IEC62133 documents
11. Custom size feasibility and NRE if needed

Thanks.
```

---

## 12. 关键风险与避坑清单

| 风险 | 说明 | 处理要求 |
|---|---|---|
| 彩色电子纸 waveform | 没有正确 waveform，残影、色彩和刷新会很差 | 必须随屏幕模组一起拿授权和驱动 |
| 彩屏交期 / MOQ | 10.3 彩色 + 前光 + EMR 的完整 Stack 公开现货少 | 早期就 RFQ，拿正式 lead time 和 MOQ |
| EMR 叠层视差 | EPD + 前光 + CTP + EMR 叠层会影响书写视差 | 要求供应商提供贴合后的实际测试数据 |
| 掌托误触 | 不是单 IC 能解决，涉及 EMR、CTP、驱动、应用 | 要求供应商提供 demo 和 SDK |
| 前光均匀性 | 10.3 英寸大面积前光容易出现亮度不均 | 要求亮度均匀性指标和实拍样张 |
| 电源峰值 | 前光、Wi‑Fi、NPU、电子纸刷新会叠加峰值 | EVT 阶段必须做功耗曲线 |
| 充电发热 | 超薄设备散热差，高电流充电容易温升 | 保守起步 1–2A，后续再评估快充 |
| 无线认证 | 换天线或结构会影响认证 | 优先用已认证模块 + 参考天线设计 |
| 安全闭环 | 只买 64GB 存储不等于安全 | secure boot、加密、OTA、擦除要系统设计 |
| 量产供货 | 核心板、屏幕、电池都可能有长交期 | 每个关键器件至少准备 second source 或替代方案 |

---

## 13. 下一步动作

1. **立刻发屏幕整屏 Stack RFQ**  
   目标是拿到 10.3 彩色电子纸 + 前光 + CTP + EMR + TCON + waveform 的正式可行性、样品价、MOQ 和交期。

2. **先买 EVT 黑白电子纸套件**  
   用于尽快验证主控、UI、刷新、前光、触控和电源。

3. **主控选 Variscite 4GB + 64GB 配置**  
   这条路线最接近最终产品需求。

4. **并行采购 EMR 样品**  
   尽早验证笔延迟、视差、hover 和掌托误触。

5. **电池按结构先买两种尺寸**  
   先验证厚度、固定方式、温升和续航，再定制最终电池。

6. **安全方案从 BSP 阶段开始做**  
   secure boot、文件加密、OTA 签名和数据擦除不要等硬件定版后再补。

---

## 14. 采购优先级

| 优先级 | 项目 | 原因 |
|---|---|---|
| P0 | 屏幕整屏 Stack RFQ | 最大风险项，决定产品形态、厚度、体验和成本 |
| P0 | 主控核心板 4GB + 64GB | 决定系统架构、BSP、NPU、安全机制 |
| P0 | EVT 电子纸套件 | 尽快开始软件和电源验证 |
| P1 | EMR digitizer + passive pen | 书写体验核心，需早期验证 |
| P1 | 电池样品 + fuel gauge + 充电 | 决定结构、续航、温升 |
| P2 | 独立 Wi‑Fi / BLE EVK | 若 SoM 自带无线，可后置 |
| P2 | 安全芯片 / TEE 扩展 | 先确认 SoC 能力，不够再加独立器件 |

---

## 15. 简化版采购清单

| 类别 | 第一批采购方案 |
|---|---|
| 屏幕 | 10.3 英寸电子纸 + 前光 + 触控 + TCON 套件，1–2 套 |
| 彩屏 RFQ | 10.3 Kaleido 3 / CFA 彩色电子纸整屏 Stack RFQ，不只买裸屏 |
| 触控笔 | Wacom / Hanvon Ugee EMR digitizer + passive pen 样品，1–2 套 |
| 主控 | Variscite VAR-SOM-MX8M-PLUS Eval Kit，4GB + 64GB，1 套 |
| 开发板 | NXP FRDM-IMX8MPLUS，0–1 套 |
| 无线 | u-blox / Murata Wi‑Fi BLE EVK，视主控配置决定 |
| 电池 | 4500mAh 超薄软包电池，两种尺寸，各 3–5 颗 |
| 电量计 | BQ27441-G1 EVK / 小板，2–3 套 |
| 充电 | BQ25628 / BQ25895 EVK / 小板，2–3 套 |
| 安全 | 先基于 i.MX secure boot + eMMC RPMB + fscrypt / RAUC 做系统方案 |
