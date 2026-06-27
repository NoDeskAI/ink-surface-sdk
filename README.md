# InkSurface SDK

InkSurface SDK 是 InkLoop 的共享文档 surface 渲染 SDK。它把原生文档文本、锚点标注、AI 旁注、高亮、框选和自由笔迹渲染成同一套可嵌入的 DOM surface，供 Web 端、Obsidian 插件和后续宿主复用。

推荐项目名：

- 产品名：`InkSurface SDK`
- GitHub/package 名：`ink-surface-sdk`
- 兼容构建产物：`dist/inkloop-surface-sdk/*`
- IIFE 全局变量：`window.InkLoopSurfaceSDK`

保留旧构建名是为了兼容当前 Obsidian 插件加载路径；对外文档使用 InkSurface SDK。

## SDK 能做什么

- 解析 InkLoop Markdown projection，生成可渲染的 visual model。
- 渲染文档正文、页标题、margin note、AI note、excerpt、QA、task、框选、高亮和自由笔迹。
- 支持铅笔/高亮的 `color` 和 `opacity`，适配深色主题。
- 提供纯字符串编辑 helpers：替换 block、追加 annotation、更新 annotation。
- ESM 和 IIFE 双构建，方便 Web App 和插件宿主接入。
- import 无副作用：不自动改 DOM、不注入 CSS、不启动网络/同步/监听。

详细 SDK 使用文档见 [docs/ink-surface-sdk.md](./docs/ink-surface-sdk.md)。

## 快速使用 SDK

```bash
npm install
npm run build:sdk
npm run dev -- --host 127.0.0.1
```

打开最小示例：

```text
http://127.0.0.1:8765/examples/ink-surface/basic.html
```

ESM 用法：

```ts
import {
  installInkLoopSurfaceStyles,
  renderInkLoopVisualModel,
} from './dist/inkloop-surface-sdk/inkloop-surface-sdk.es.js';

installInkLoopSurfaceStyles();
document.querySelector('#app')?.replaceChildren(renderInkLoopVisualModel(model));
```

`installInkLoopSurfaceStyles()` 和 `replaceChildren(...)` 都是显式调用；单纯 import SDK 不会产生宿主副作用。

## 本仓库还包含什么

本仓库同时保留 InkLoop Web demo 和 Obsidian Runtime MVP，用来验证 SDK 在真实阅读/标注/同步场景下是否能跑通：

> PDF 原文圈画/手写 → InkLoop 生成标注/AI 旁注 → SDK 渲染 surface → Web 和 Obsidian 共用同一套 sidecar 数据。

- 导入数字版 PDF，并用 PDF.js 渲染页面。
- 用笔、鼠标或触控笔在页面上圈、划、写、高亮、擦除。
- 用纯几何过滤误触，并识别圈、划线、箭头、自由笔迹。
- 从 PDF 文本层命中被圈/划的文字；图片或手写才走视觉识别兜底。
- 把连续标注合成一次 session，长停顿或手写问题后触发 AI。
- 把 AI 旁注贴到原版页面右侧留白，或贴到重排阅读视图对应段落旁。
- 把 PDF、笔迹、AI 回复、重排缓存存进 IndexedDB，刷新后可以恢复。
- 提供调试页查看 HMP 取证、AI 会话、设置和遥测。
- 提供 Obsidian Runtime MVP：原生 Markdown 文档、隐藏 `.inkloop` sidecar、Obsidian 后台插件、Web Lab 双端编辑/标注/同步验证。

## 快速跑起来

项目是 Vite + TypeScript。当前机器已验证：

- Node.js `v24.14.0`
- npm `11.9.0`

第一次准备：

```bash
npm install
cp .env.example .env
```

启动：

```bash
npm run dev -- --host 127.0.0.1
```

打开：

```text
http://127.0.0.1:8765/
```

Vite 端口在 [vite.config.ts](./vite.config.ts) 里固定为 `8765`，`strictPort: true`。如果端口被占用，先停掉旧进程再启动。

## Obsidian Runtime MVP

当前 Obsidian 集成不是简单导出插件，而是把 Obsidian 作为 InkLoop Runtime 的宿主：

- 用户文档保持原生 Markdown，默认显示在 `InkLoop/`。
- 笔迹、AI 旁注、画布、锚点、同步事件存进隐藏目录 `.inkloop/`。
- Obsidian 插件负责后台监听、渲染宿主、sidecar 写入和同步触发。
- Web Lab 和 Obsidian 使用同一套 InkLoop surface SDK 渲染标注和文档流。

从零跑一套本地验收：

```bash
npm run verify
npm run obsidian:smoke -- --out-dir .inkloop-smoke-runs/obsidian-runtime-mvp --force-clean
npm run build:sdk
npm run obsidian:install-plugin -- --vault .inkloop-smoke-runs/obsidian-runtime-mvp/obsidian-vault
INKLOOP_LAB_RUN_DIR=.inkloop-smoke-runs/obsidian-runtime-mvp npm run dev -- --host 0.0.0.0
```

Web Lab 页面内的写入请求走同源校验；如果要从局域网脚本直接调用写接口，设置 `INKLOOP_LAB_WRITE_TOKEN` 并发送 `x-inkloop-lab-token`。

打开 Web Lab：

```text
http://localhost:8765/obsidian-lab.html
```

打开 Obsidian Vault：

```text
.inkloop-smoke-runs/obsidian-runtime-mvp/obsidian-vault
```

详细验收和交接见 [docs/obsidian-runtime-mvp-handoff.md](./docs/obsidian-runtime-mvp-handoff.md)。

## AI Key 怎么配

`.env.example` 已经给出网关地址：

```bash
LLM_GATEWAY_URL=https://llm-gateway-api.nodesk.tech/default/passthrough
LLM_GATEWAY_KEY=
LLM_MODEL=kimi-k2.6
```

需要把真实 key 填到 `.env` 的 `LLM_GATEWAY_KEY`。这个 key 只在 Vite dev server 的 Node 侧读取，不会打包进前端。

没有 key 时，页面仍能打开、导入 PDF、渲染、画笔迹；但需要模型的功能会失败或降级，例如手写识别、图像 OCR、AI 旁注、AI 重排。

注意当前代码里有两层默认模型：

- `LLM_MODEL` 是服务端兜底模型，不传 model 时用它。
- 前端设置里的 `settings.inferModel` 默认是 `claude-sonnet-4-6`，多数 `/api/*` 请求会显式带这个值。
- 重排默认走 `settings.reflowModel = gemini-3.1-flash-lite`。

实际想换模型，优先在左侧「设置」页里改“推理模型”和“重排模型”。

## 怎么试这个 demo

1. 启动服务后打开 `http://127.0.0.1:8765/`。
2. 点「导入 PDF」，选一个有文本层的数字 PDF。扫描版 PDF 的文字命中会弱很多。
3. 选择钢笔工具，在正文上圈一个词或划一行。
4. 停笔。默认长停顿阈值是 90 秒；为了冒烟测试，可以在左侧「设置」页把“长停顿综合阈值”调到 10 秒。
5. 在页边写一个问题，系统会先判断这是“问 AI”还是“写给自己”。如果判定需要回应，会立刻走 AI。
6. 点顶部「重排」切到重排阅读视图，再在重排文本上圈画。它仍会映射回原 PDF 的 bbox 和同一套账本。

左侧导航默认可见，按 `m` 可以折叠或展开。

## 常用命令

```bash
npm run dev      # 本地开发服务，含 /api/* AI 代理
npm run check    # TypeScript 严格类型检查
npm run build    # 类型检查 + Vite 生产构建
npm run build:sdk # 构建 InkSurface SDK ESM/IIFE bundle
npm run preview  # 预览构建产物
npm run verify   # 类型检查 + lint + 测试 + Web 构建 + SDK 构建
npm run obsidian:smoke          # 生成 Obsidian Runtime smoke vault
npm run obsidian:install-plugin -- --vault <vault-path> # 安装 InkLoop Obsidian 插件到指定 vault
```

`npm install` 后会自动跑：

```bash
node scripts/copy-pdfjs-assets.mjs
```

它会把 PDF.js 的 CMap 和标准字体复制到 `public/cmaps`、`public/standard_fonts`，用于老中文 PDF 正常渲染。

## 代码地图

```text
src/main.ts
  应用装配；区域组装；停顿/手写触发；恢复账本；页面操作。

src/app/state.ts
  全局状态、设置、事件总线、当前工具、当前页笔迹。

src/capture/
  ink.ts        Pointer Events 采集、笔/手指分流、擦除、撤销。
  classify.ts   纯几何分类：tap、circle、underline、arrow、freeform。
  session.ts    Mark / Session 累积器。

src/core/
  contracts.ts      数据契约。
  pipeline.ts       主处理链：recordEvent、captureMark、commitSessionDiscussion。
  transform.ts      归一化坐标和像素坐标换算。
  store-format.ts   IndexedDB 账本格式。

src/evidence/
  target.ts          SurfaceIndex、字符级对象、HMP 取证。
  mark-graph.ts      时空关系图。
  inference-view.ts  把复杂图蒸馏成给模型看的文字载荷。
  recall.ts          从历史 mark 账本召回同页邻近标注。
  focus.ts           页面文字、行带命中、点在多边形内。
  ocr.ts             从 canvas 裁取笔迹图 / 合成图。

src/surface/
  renderer.ts        PDF.js 渲染、文本层抽取、图片区域抽取、SurfaceIndex 构建。
  reflow.ts          本地几何重排。
  reflow-provider.ts AI / VLM 重排 provider。
  reader.ts          重排阅读视图和重排视图里的圈画。
  whisper.ts         原版页面旁注。
  anchor-layer.ts    流式锚点预览。
  toolbar.ts         底部工具栏。

src/local/store.ts
  IndexedDB 持久化：docs、pdf_blobs、marks、ai_turns。

src/chat/
  buffer.ts          每本书最近 3 轮对话 buffer。
  stream-client.ts   流式 /api/chat 客户端。
  classify-client.ts 手写 respond/fold 分类客户端。

server/
  infer.ts           Vite dev 中间件背后的 AI 代理实现。
  prompts.ts         各角色 system prompt 注册表。
  debug.mjs          dev 遥测 JSONL。
```

## 主链路一句话版

```text
PointerEvent
→ Stroke
→ AnnotationEvent
→ 区域组装成 Mark
→ captureMark 取证成 HMP
→ Session 累积
→ 手写问题或长停顿触发提交
→ MarkGraph
→ InferenceView
→ /api/chat
→ ScreenOverlay
→ 原版页面或重排页面回屏
→ IndexedDB 账本持久化
```

详细解释见 [docs/前端标注链路-技术文档.md](./docs/%E5%89%8D%E7%AB%AF%E6%A0%87%E6%B3%A8%E9%93%BE%E8%B7%AF-%E6%8A%80%E6%9C%AF%E6%96%87%E6%A1%A3.md)。

## 已知边界

- 数字版 PDF 最适合，因为文本层能直接提供文字和位置。
- 扫描版 PDF 需要 OCR/VLM 兜底，没 key 时基本只能看图，无法准确命中文字。
- 本地重排适合单栏正文；多栏、表格、公式、网页截图 PDF 需要 AI 或 VLM 重排。
- 这是 Web demo，不是硬件端实现；但全链路都用归一化坐标，后续迁移到电子纸/原生运行时比较容易。
- IndexedDB 不可用时会退化成仅内存，刷新后无法恢复。
