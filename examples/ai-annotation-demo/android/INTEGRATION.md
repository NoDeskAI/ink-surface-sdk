# InkLoop 安卓壳 · 构建与集成

> 2026-07-03 V1 边界：本 Android 壳定位为 **InkLoop Paper 本地优先阅读/标记 demo / 第二产品环**。它验证 WebView、离线缓存、端侧 OCR、本机/Wi-Fi 导入、局域网收件箱、阅读/标记和未来 e-paper 刷新能力；Web/电脑端外部导入是 Cloud Hub first，Paper 端从 Library manifest 看到后再下载本地副本。它不是 2026 年 10 月 Kickstarter 基础档硬件承诺。Kickstarter 首发主线仍是 AI Pen + Capture Surface + Web/Desktop Capture Host。Android 端演示 UI 保持干净，不再常驻显示 launch gate 状态；launch readiness 由项目文档、证据记录和 Obsidian 设置边界面板承载。

把 InkLoop（Vite/TS 前端）装进原生 Kotlin WebView 壳，跑在 RK3588S 安卓板上。**侧载，不上 Google Play**。
AI 答问走托管代理（云/内网）；**端侧印刷区域 OCR** 通过 `window.InkLoopOcr` 桥本地跑徐的 PaddleOCR / ML Kit text。

> 形态（2026-06-24 定）：**我们的脚手架为主体，把徐的 `ppocr-sdk` 作为源码模块拉进来**。
> 2026-07-03 已在本机补齐 Temurin JDK 17.0.19 与 Android SDK command-line tools，并通过 `:app:assembleDebug` 构建验证。Android Studio 仍可作为日常调试入口。

## 端侧职责映射（对齐徐架构，详见记忆 inkloop-android-wrapper-branch『分类器端侧平替映射』）
- **印刷/规整文字区域 OCR → 端侧**：`ocrRegion` = ML Kit text（Latin+中文，bundled 离线、不绑 GMS、~178ms）优先，空/失败退 PP-OCRv6 兜底（~435ms）。**这是端侧唯一真正承载的活。**
- **手写「判 kind + 转写 + 画描述」→ 云端**：端侧无可用手写引擎（Digital Ink 绑 GMS、目标板多半没有；栅格读手写不可用）。`recognizeInk` 端侧恒返回 unavailable → 前端自动降级云 `/api/interpret`（VLM）。待商业 raw-stroke HWR SDK 到位再接（见下）。
- **intent（respond/fold 影子）→ 前端 TS**：`intent-rules.ts` 已权威执行，桥 `classifyIntent` 不重复。

## 版本组合（对齐徐 ppocr-sdk，已写进构建文件）
AGP 8.7.3 / Kotlin 2.1.0 / Gradle 8.9 / compileSdk 35 / minSdk 26 / targetSdk 35 / **abiFilters = arm64-v8a**。
包名 `com.inkloop.app`。模块：`:app`（壳 + OcrBridge）、`:ppocr-sdk`（徐 PaddleOCR 源码，`com.paddle.ocr`）。

---

## 构建步骤

### 1. 部署 AI 代理
前端 `/api/*` 在 `npm run build` 后不存在（dev 期是 Vite 中间件）。把 `server/standalone.ts` 跑成常驻服务（复用 `server/infer.ts` 的 9 路由 + `/api/ab/intent`，Key 只在服务端）：
```bash
LLM_GATEWAY_KEY=... LLM_MODEL=kimi-k2.6 PORT=8731 npm run serve   # = tsx server/standalone.ts
```
- 现已部署内网 `10.4.36.30:3000`（`/root/inkloop-proxy`，`nohup`）。CORS 已放行 `https://appassets.androidplatform.net`、禁 `/api/__debug/*`。
- 本地 Cloud Hub 默认同时监听 HTTP `8731` 和 HTTPS `8732`。Android debug 包从 `http://appassets.androidplatform.net/assets/mobile.html` 加载 APK 内页面，并允许 WebViewAssetLoader 的 HTTP asset origin，因此本地 `http://<Mac LAN IP>:8731` Cloud Hub 不会触发 HTTPS 页面请求 HTTP 的 Mixed Content warning。release 包仍从 `https://appassets.androidplatform.net` 加载页面并禁止 mixed content；公网请走 https。经 Nginx 关 `proxy_buffering`（保流式）。

### 2. 构建前端（注入代理地址）
```bash
VITE_API_BASE_URL=http://10.4.36.30:3000 npm run build
```
本地 V1 联调可以直接用仓库根目录的：
```bash
npm run android:assemble:debug
```
如果没有显式设置 `VITE_API_BASE_URL`，脚本会自动把当前 Mac 的 LAN IP 和固定 Cloud Hub HTTPS 端口 `8732` 烧录进 debug APK，例如 `https://172.168.20.112:8732`。这样桌面 Web 和墨水屏默认指向同一个本地 Cloud Hub；若手动指定公网或内网代理，则以显式环境变量为准。临时需要回到 HTTP 调试时可显式设置 `INKLOOP_ANDROID_HTTP_API_BASE=1`。

普通 `android:assemble:debug` 默认是产品化设备 session 模式：没有有效 session 时，墨水屏会显示二维码登录门禁，Cloud Library / Runtime Sync / Knowledge 请求依赖服务端 introspection 后的 `tenant_id + user_id + device_id`，不能静默落到 `local_demo`。只有做无人值守本地 smoke 时才显式构建 local demo 包：

```bash
npm run android:assemble:debug:local-demo
# 或
INKLOOP_ANDROID_LOCAL_DEMO_AUTH=1 npm run android:assemble:debug
```

### 3. 同步资产进安卓工程
```bash
node scripts/sync-android-assets.mjs
```
把 `dist/`（+ 端侧 `models/`、`dictionaries/`）拷进 `android/app/src/main/assets/`（gitignore，不入库）。
页面地址：debug = `http://appassets.androidplatform.net/assets/mobile.html`，release = `https://appassets.androidplatform.net/assets/mobile.html`。桌面 Web 仍用 `index.html`，AI Pen Kickstarter V1 演示仍用 `ai-pen-demo.html`；Android 默认壳承载 InkLoop Paper 本地优先阅读/标记/本机与 Wi-Fi 导入小闭环。

文件选择器按前端 `<input accept>` 放行类型：`mobile.html` 主要选择 PDF；`ai-pen-demo.html` 的 bench/QA 路径可以选择 RawPenFrame JSON/JSONL，用来验证 AI Pen 原始日志导入链路。这个能力不改变 Android/e-paper 的 V1 边界：Kickstarter 首发捕捉主路径仍是 AI Pen + Capture Surface + Web/Desktop Capture Host。

局域网上传入口：APK 内注册 `window.InkLoopLanImport`。移动端点「导入文件」会启动一个临时 `InkLoopLanImportBridge` HTTP 上传页，电脑和墨水屏在同一 Wi-Fi 时打开文件浮层显示的固定地址 `http://设备IP:8787/?token=...` 即可上传 PDF/EPUB/Markdown。端口固定为 `8787`，被占用时直接显示错误，不自动漂移；URL 里的 token 由设备本地生成，未带 token 或 token 错误的请求不能上传。上传文件进入 app 专属 `lan-inbox` 后，移动端会自动静默导入本地 Library，并在成功入库后清理临时收件箱文件；手动点收件箱文件只作为兜底。这个能力只解决墨水屏端无 USB、无系统选择器可见时的本地导入体验；它不是 Runtime sync、不是 Cloud Hub 的 Web 导入刷新入口、不是发布页证据，也不改变 Kickstarter 首发硬件范围。

Runtime sync 是另一条链路：运行时标注事件、阅读进度、会议事件和受控 Obsidian 回写走 `/v1/runtime/events:push|pull`，生产包和 Cloud Library 共用构建期固定的 `VITE_API_BASE_URL` Cloud Hub 基址，请求带设备 session 并按用户隔离；它不负责新源文件字节导入。

后台运行：`InkLoopKeepAliveService` 在 APP 启动时作为低优先级前台服务运行，并由 `InkLoopBootReceiver` 在开机/包更新后尝试拉起，用于守护 Runtime sync 和 Wi-Fi 收件箱进程。部分系统仍需要用户在系统设置里允许自启动、通知和忽略电池优化；这是 Android/厂商策略，不应假设 WebView Activity 可以在后台静默当作阅读 UI 长期运行。

M103 真机专用的 `HqHwBridge` 会把厂商 `/tmp/hqunifiedsocket` 笔尖点流交给前端。移动端现在通过 `src/capture/m103-raw-pen-adapter.ts` 把这批 CSS 视口点映射成 `inkloop.ai_pen.v1` RawPenFrame。`mobile-main.ts` 启动时会先安装 `window.InkLoopM103RawPenCapture`，原版 canvas 和重排 reader 成功接到 socket 整笔后都会缓存到这个桥：

- `getLastBatch()` 返回最近一笔 RawPenFrame 批次。
- `getAllFrames()` 返回当前采样窗口内累积的最近多批 RawPenFrame。
- `getSummary()` 返回批次数、帧数、最近批大小和设备时间范围。
- `exportJsonl()` 导出最近一笔 JSONL，保留给单笔调试。
- `exportAllJsonl()` 导出当前采样窗口内全部帧，作为硬件 prototype run log 的原始输入。
- `clear()` 清空当前采样窗口。
- 若页面也安装了 `window.InkLoopRawPen`，同一批帧会按 `android_native` source kind 推入统一 ingress bridge。

本机真机采样命令：

```bash
npm --workspace ./examples/ai-annotation-demo run smoke:m103-physical-pen-capture
```

脚本会连接 M103 WebView、清空采样桥并等待真实手写。运行窗口内必须在设备上画一笔；成功后会在 `examples/ai-annotation-demo/test-results/m103-physical-pen-capture/` 写入 RawPenFrame JSONL 和报告。若没有真实笔迹，脚本会以 `needs_physical_stroke` 失败，不能用合成 pointer 事件冒充物理笔延迟证据。

这只是 Android/Paper 真机点流进入 V1 合同的接入边界。Kickstarter 仍需要把真实导出的 JSONL、视频、延迟报告和人工 review 写入 launch evidence records，不能把 adapter 存在本身当作硬件验证完成。
> **PP-OCR 模型只由 app assets 这一份提供**（`assets/models/det|rec`）。徐 `ppocr-sdk` 自带的 models 已在拉入时删掉，避免 asset 合并冲突——`PpOcrBridge` 从 app 合并 assets 读 `models/det/inference.onnx` 等，能读到这份。

### Android runtime boundary bridge

APK 内还注册了只读 `window.InkLoopRuntime.getManifest()`。它返回 `inkloop.android_runtime_manifest.v1`：

- `product_loop`: `InkLoop Paper`
- `sync_loop`: `Web cloud-first import -> Paper local-first reading/marking -> Obsidian projection`
- `mode`: `web-cloud-first-paper-local-first`
- `entrypoint`: `mobile.html`

`mobile.html` 会读取这条 manifest 作为隐藏运行时边界，用于调试和 QA 确认当前 APK 的本地 V1 小闭环；普通浏览器预览没有原生桥时使用同等 fallback。这个桥不上传数据、不改变同步或捕捉行为，也不把 Android/e-paper 描述成 Kickstarter 基础档硬件承诺。

### 4. 构建 & 侧载
Android Studio 打开 `android/` → Gradle sync（首次下 AGP/Kotlin/OpenCV/ONNX 依赖）→ 运行 `:app` → debug APK → `adb install` 到板子。

本机命令行验证路径（仓库根目录推荐）：

```bash
npm run android:assemble:debug
```

该命令会构建 Web demo、验证 Android assets、自动使用本机项目 JDK，然后运行 `:app:assembleDebug`。

手工路径：

```bash
cd examples/ai-annotation-demo
node scripts/sync-android-assets.mjs
cd android
JAVA_HOME=/Users/ethan/.cache/inkloop-tools/jdks/temurin17/Contents/Home \
ANDROID_HOME=/Users/ethan/Library/Android/sdk \
ANDROID_SDK_ROOT=/Users/ethan/Library/Android/sdk \
JAVA_TOOL_OPTIONS='-Djava.net.preferIPv4Stack=true' \
./gradlew :app:assembleDebug --no-daemon
```

输出：

```text
app/build/outputs/apk/debug/app-debug.apk
```

> **abiFilters=arm64-v8a**：APK 只含 arm64 native（OpenCV/ONNX/ML Kit），2026-07-03 构建产物约 58MB。**只能装 arm64 设备/模拟器**（真板，或 Apple Silicon 上的 arm64 系统镜像）。要在 x86_64 模拟器快速验套壳，临时去掉 `app/build.gradle.kts` 的 `abiFilters` 即可（包体会显著增大）。

### 5. 验收
- **套壳通路**：SAF 导入 PDF；笔采集+压感；圈/划/写停笔出 AI 旁注（经 `10.4.36.30` 往返）；重排切换；关 App 重开最近文档仍在（IndexedDB）；断网阅读不崩、AI 不可用降级不白屏。
- **端侧 OCR**：圈选印刷文字区域 → 前端开发面板/遥测 `ocr_fallback` 阶段应显示本地读出（不再打云端 `/api/ocr-vlm`）。手写仍走云（`recognize` 阶段 `识别源=cloud`），符合预期。

---

## 端侧 OCR 桥怎么工作（`OcrBridge.kt`）
`MainActivity` 在 `loadUrl` 前 `OcrBridge.attach(webView, this)` 注册 `window.InkLoopOcr`。RPC 契约见 `src/evidence/ondevice.ts`：
```
REQ  {"id","method","args"}   method ∈ ocrRegion | recognizeInk | classifyIntent | capabilities
RES  {"id","ok":true,"result":{...}}  或  {"id","ok":false,"error":"..."}
```
- `ocrRegion(imagePng)` → `MlKitTextOcrBridge.recognizeLatinChinese` 优先；空/失败 → `PpOcrBridge.recognize` 兜底 → `{text}`。
- `recognizeInk` → `ok:false`（端侧无手写引擎）→ 前端降级云 `/api/interpret`。
- `classifyIntent` → `ok:false`（前端 TS 已做）。
- `capabilities` → `{ocr:true, gms:<反射探测 Play 服务>}`。
> 要纯套壳（全部走云）：注释 `MainActivity` 里的 `OcrBridge.attach` 那一行即可，`window.InkLoopOcr` 不存在 → 前端 `ondevice.available()=false` → 一切走云。

## 手写真引擎槽位（待接）
拿到**商业 raw-stroke HWR SDK**（汉王/Onyx 厂商 SDK / MyScript iink / SELVAS）后，在 `OcrBridge.recognizeInk` 里接：`args.strokes` 笔迹点序 → SDK 识别取候选+重排 → `{kind:"handwriting", reading, description:""}`。在此之前恒走云，不阻塞。
> ML Kit Digital Ink 绑 GMS，徐汉王 T10CPlus 实测 `requires the Google Play Store` 初始化失败、已禁用；目标 RK3588 板多半无 GMS。**故不把 Digital Ink 作为默认手写实现**——它是"dev 能跑、prod 死"的陷阱。

## intent A/B 影子对照（Seam C）
前端每次手写触发：除云端 `classifyContext`（respond/fold，**权威**）外，并行用 `intent-rules.ts`（徐 IntentClassifier 的 TS 移植）算 intent → 映射 respond/fold 预测 → 记一条 `intent_ab`（`devEmit` 落 `.dev-telemetry.jsonl`）+ `postBeacon('/api/ab/intent')`（代理落 `.ab-intent.jsonl`，板上生产也发）。**端侧只影子、不改行为。** 收一致率：读这两个 jsonl 的 `agree` 字段。

---

## 资产路径备忘（为何这么排）
- `dist/index.html` 用相对 `./assets/...`（`base:'./'`）；页面在 `/assets/index.html` → 解析到 `/assets/assets/...`。
- AssetLoader 前缀 `/assets/` → APK `assets/`，故 `dist/` 平铺进 `assets/` 后路径一一对上。
- pdfjs cmap/字体用 `BASE_URL` 相对解析（`src/surface/renderer.ts`），落到 `/assets/cmaps/`。

## 安全 / 发布
- WebView：关 file 访问、`MIXED_CONTENT_NEVER_ALLOW`、release 关 WebView debugging、外链交系统浏览器。
- 隐私：AI 开启时会把 PDF 文本片段 / 页面图片片段 / 标注内容发到代理。侧载自用无需上架合规。
