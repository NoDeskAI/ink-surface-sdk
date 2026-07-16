# standalone.ts 拆分计划（待办·分批执行）

> 状态：**未开工**。codex 只读调查产出（2026-07-15），主循环已审。执行方式：按 ④ 批次表逐批领活，
> 每批一个会话完成+验证+独立 commit；批 0（补 characterization 测试）必须先行。

以下方案基于对 [standalone.ts](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:1)、现有模块及测试的只读调查。未修改文件，也未运行会产生临时状态的测试。

## ① 现状地图

| 行区间 | 约行数 | 功能簇 | 主要共享依赖 |
|---|---:|---|---|
| [114–140](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:114) | 27 | `.env` 加载、LLM 默认值、飞书 bot env | `ROOT`、`process.env`、fs；`feishuBotRuntimeEnv` 被飞书路由和启动逻辑共用 |
| [142–181](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:142) | 40 | CORS/LAN origin | `ALLOW_ORIGINS`、`requestHostName` |
| [183–688](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:183) | 506 | session、local device auth、panel auth 代理、飞书身份升级 | `ROOT`、`PORT`、`PANEL_AUTH_BASE`、secret、local auth 配置、`readBody/sendJson/safeId/recordOf`；反向依赖 1875 行的 `cloudLibraryStore` |
| [690–730](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:690) | 41 | panel-feishu 代理 | `PANEL_FEISHU_BASE`、secret、`requireDeviceSession`、`readBody` |
| [732–856](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:732) | 125 | panel vault 代理及本地 vault 兜底 | `ROOT`、vault env、secret、session、`readBody`、`panel-vault-guard` |
| [858–907](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:858) | 50 | 飞书/convert 配置与 Google/MTL identity helper | `FEISHU_SERVICE_BASE`、Lark scope/callback、`CONVERT_SERVICE_BASE`、local tenant/user |
| [908–1111](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:908) | 204 | `/api/google/*`，含 summary、OAuth、meeting source/transcript、MTL token/live-state | session、`readBody/sendJson`、Google 模块、MTL 模块、AI summary |
| [1112–1232](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:1112) | 121 | Lark OAuth URL、回调、device redirect、连接页 | `PORT`、callback 配置、auth pending store、session 身份升级、HTML helper |
| [1233–1270](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:1233) | 38 | 二进制缓冲/流式转发 | 飞书和 convert 共用 |
| [1271–1781](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:1271) | 511 | feishu-svc：本地兜底、OAuth、会议、docx、群资料及远端转发 | 几乎全部 Lark/Feishu 模块、auth service、`ROOT`、secret、二进制 relay |
| [1782–1835](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:1782) | 54 | convert 代理、docx 下载票据 | convert/Feishu/panel-auth base、secret、internal token、`PORT`、session |
| [1837–1866](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:1837) | 30 | AI JSON 路由表、A/B 日志与 body reader 配置 | `AB_LOG`、`MAX_BODY`、`infer.ts` |
| [1868–2452](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:1868) | 585 | runtime-sync 装配、KO/Projection 构建、AI 后处理、store 单例 | runtime/library/knowledge store、session resolver、infer、两套 schema |
| [2454–2468](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:2454) | 15 | Library/Knowledge/Device handler 装配 | 三个 store 单例、同一个 `resolveDeviceSession` |
| [2470–2568](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:2470) | 99 | 总路由、health、AI 流式响应 | 上述所有 handler；路由顺序和 POST-only 闸具有协议意义 |
| [2570–2626](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:2570) | 57 | HTTP、Lark callback bridge、HTTPS、WS 启动 | `PORT`、callback 配置、同一个 `handleRequest`、Lark WS 全局状态 |
| [2515–2516](/Users/edy/Desktop/Nova_project/.wt-meeting-platforms/examples/ai-annotation-demo/server/standalone.ts:2515) | 2 | MTL 核心路由接线 | 核心已成功外拆到 `mtl-receiver.ts`；Google 内另有 MTL 管理端点 |
| 无 | 0 | 静态文件服务 | 当前没有静态 handler；普通 GET 最终返回 `405 POST only`，不要在拆分中顺手新增 |

## ② 建议模块清单

| 目标文件 | 职责 | 预计行数 | 搬迁来源 |
|---|---|---:|---|
| `server-route-utils.ts` | body、JSON、bearer、HTML escape、binary relay、`recordOf/safeId/textOf` | 90–120 | 263–277、530–536、874–881、1233–1270、1840–1854 |
| `standalone-cors.ts` | CORS/LAN origin | 45–55 | 142–181 |
| `cloud-hub-auth.ts` | local/panel auth、session resolver、OAuth pending、飞书身份升级 | 450–500 | 185–688 |
| `panel-feishu-proxy.ts` | panel 飞书白名单代理 | 55–70 | 690–730 |
| `panel-vault-routes.ts` | 远端 vault 代理和本地兜底 | 135–160 | 732–856 |
| `google-api-routes.ts` | 完整 `/api/google/*` family，包括 MTL 管理端点 | 220–250 | 883–1111 |
| `lark-oauth-http.ts` | Lark redirect/callback/connect HTML 编排 | 130–160 | 1112–1232 |
| `feishu-service-routes.ts` | feishu-svc 本地兜底与远端转发，整体搬、不重写分支 | 520–570 | 1285–1781，另收 134–140、861–871、1271–1283 |
| `convert-service-routes.ts` | convert、legacy source rewrite、下载票据 | 65–85 | 1782–1835 |
| `ai-inference-routes.ts` | A/B、JSON AI、reflow/chat streaming | 90–120 | 1837–1866、2524–2567 |
| `runtime-knowledge-pipeline.ts` | runtime event → AI turn/KO/projection、副作用编排 | 570–620 | 1877–2452 |
| 继续使用现有模块 | `mtl-receiver*`、`google-*`、`lark-*`、`cloud-*-handler/store` | 不搬 | 已是成功先例 |
| `standalone.ts` | env/config 装配、单例创建、有序路由表、HTTP/HTTPS/WS 启动 | 约 250–350 | 保留 114–140、handler 装配、2470–2523、2570–2626 |

不建议增加框架或通用 router。一个有序的 `{ prefix, handle }[]` 加少量精确路径判断即可，并保持现在的匹配顺序。

## ③ 共享状态处理

| 状态/常量 | 处理方式 | 关键风险 |
|---|---|---|
| `ROOT`、`PORT`、`process.env` 引用 | `standalone.ts` 先构造只读 `config`，再创建 handler | 消除当前 `PORT` 后声明、前闭包引用的隐式时序 |
| `INKLOOP_SHARED_SECRET`、`PANEL_AUTH_BASE`、Feishu/convert base | 放 `config`，按模块传窄字段；不要各模块重新读 env | 多处重新解析可能产生不同 trailing-slash/default 行为 |
| `PANEL_FEISHU_BASE` | panel-feishu 专属配置 | 不进入 auth 模块 |
| `PANEL_VAULT_BASE`、force user、local vault root、50MB 限制 | 下沉 vault 模块；env 值由 config 传入，限制和正则留模块内部 | 不改 fail-closed 白名单 |
| local auth 路径、tenant/user、TTL | `AuthConfig`，由唯一 `createCloudHubAuth` 使用 | auth 文件是 read-modify-write；拆分时不要顺便改并发语义 |
| Lark scope、callback path/port | config 供 `lark-oauth-http`、Feishu handler和启动桥共用 | 三处必须是同一个值 |
| `feishuBotRuntimeEnv()` | 保留为每次调用重新构建的函数 | 不能在启动时冻结结果，否则 bot config 保存/删除后不生效 |
| `cloudKnowledgeStore` | 在 standalone 只 `new` 一次并传给 pipeline 和 handler | 内含 `writeQueues Map`；双实例会绕过串行写保护 |
| `JsonlRuntimeSyncEventStore` | 只创建一次，再创建一个 runtime handler | 内含 events 数组和 write queue；双实例可能读到不同视图 |
| `cloudLibraryStore` | 唯一实例同时给 library handler、runtime pipeline、auth 身份迁移 | 避免登录迁移与 API 使用不同对象 |
| `cloudDeviceStore` | 唯一实例 | 保持统一装配，虽当前没有内存 Map |
| `runtimeSyncHandler` | 创建一次，HTTP/HTTPS/callback 共用同一个 `handleRequest` | 闭包内有 `inFlightAccepts`、`sideEffectTails` 两个 Map |
| `cloudLibraryHandler` | 创建一次 | 闭包内 `streamClients Set`；双 handler 会让 SSE 漏通知 |
| Google transcript | 继续只 import `google-meet-records.ts` | 其中 `jobsInFlight Map` 是 ESM 单例；不要复制实现到路由模块 |
| Lark WS | 只在主 HTTP listen 回调启动一次 | 模块有 `wsClient/started/status` 全局状态 |
| MTL/auth/OAuth 状态 | 当前主要为文件状态 | 不存在 standalone 内存 Map；不要误改成每个 handler 一份内存缓存 |
| `ALLOW_ORIGINS`、路由正则、body 限制 | 下沉各自模块 | 这些是模块私有不可变值，不需要进入大 context |

建议只有两个装配对象：`config` 和 `stores`。各 factory 声明自己的 `Options` 并接收窄依赖，避免把整个 god-context 传遍所有模块。

## ④ 分批计划

每批共同门槛：先跑对应 targeted tests 和 demo `check`；提交前按仓库规则跑 `npm run check && npm run lint:ci && npm test && npm run build`。

| 批次 | 搬什么 | 回归验证 | 风险 |
|---|---|---|---|
| 0 | 先补路由 characterization，不搬生产代码 | 新增 health/CORS/405/404/local-auth 路由测试 | 低；目前没有直接覆盖 `handleRequest` 的测试 |
| 1 | `server-route-utils`、CORS | 新测 UTF-8 跨 chunk、body 上限、binary headers、CORS preflight | 低 |
| 2 | `ai-inference-routes` | 路由表、A/B 写入、chat/reflow 流结束帧；成功 AI 调用需 mock gateway | 低到中 |
| 3 | panel-feishu 和 convert 两个无本地单例代理 | `panel-vault-guard`、`convert-source-rewrite`，另补 mock upstream/session handler 测试 | 中；白名单和票据 header 容易回归 |
| 4 | `google-api-routes`；MTL core 保持原文件 | `google-oauth-state`、`google-calendar-sync`、`google-meet-records`、`mtl-receiver*`，补路由 session/method 测试 | 中 |
| 5 | `panel-vault-routes` | `panel-vault-guard.test.ts`，补临时目录的 release/latest/blob 端到端测试 | 中；本地文件状态 |
| 6 | 先搬 `lark-oauth-http`，下一提交整体搬 `feishu-service-routes` | 全部 `lark-*`、`feishu-*`、`local-feishu-material-routes` 测试，补 local/forward 两模式路由测试 | 高；建议拆成两个会话/commit |
| 7 | 先把 runtime 纯转换与 KO/Projection builder 搬入最终模块 | 新 `runtime-knowledge-pipeline.test.ts` 固定 event→KO/projection 快照；现有 policy/schema tests | 中 |
| 8 | 完成 effectful runtime pipeline 和 store/handler 单例装配 | `runtime-sync-dev`、cloud handler/store tests；`smoke:cloud-hub-controlled-writeback`、multi-user | 高；重点审计双实例 |
| 9 | 最后搬 `cloud-hub-auth` | `smoke:cloud-hub-local-device-auth`、device-session-binding、multi-user、controlled-writeback；验证重启持久化 | 最高 |
| 10 | 清理 standalone 为 config、路由表、启动；不改启动协议 | process-level health、callback bridge rewrite、HTTP/HTTPS 共用 handler；全量四项检查 | 中 |

现有底层模块测试覆盖不错，但 panel/Google/Feishu/convert 的 HTTP 编排、CORS、AI streaming 和 callback bridge 明显缺测试；现有四个 Cloud Hub smoke 主要罩住 auth、runtime、library、knowledge 和重启持久化。

## ⑤ 建议先不动

- 先不拆 auth 内部的“飞书身份升级 + auth token 文件迁移 + Library namespace bootstrap”。这段跨越 auth、Lark OAuth、Library，最后整体搬最稳。
- 先不把 500 行 Feishu handler 按每个 endpoint 再细分。先原样搬 family；分支重构是另一项工作。
- runtime 后处理不要拆成多个长期服务模块。最终保持一个 pipeline factory，共享唯一 knowledge/library store。
- 不改路由顺序、白名单正则、状态码、响应体、header、callback URL 或 body 上限。
- 不抽象统一存储接口、不引 DI 容器、不把文件状态改成内存 Map。
- 启动桥、HTTPS 和 Lark WS 留在 `standalone.ts`；它们正属于目标形态中的 server 启动。
- 不新增“静态服务模块”，因为当前服务没有这项行为。