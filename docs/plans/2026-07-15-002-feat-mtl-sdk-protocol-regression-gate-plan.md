# MTL SDK 协议回归门

## 目的与范围

Hub 的密径接收端实现会议时间轴 SDK 使用的 HTTP 协议。SDK 不在本仓库内，常规测试不能依赖某个开发者机器上的克隆，因此协议门分为两层：仓库内契约测试使用固定 payload 输出验证接收端；升级对账脚本读取待升级 SDK，检查 builder、验收 gate 和固定输出是否发生漂移。

当前 fixture 钉住 SDK commit `fd13d52a67a915f4afb9a2a7383beedba623114a`，来源文件为：

- `packages/meeting-timeline-sdk/index.mjs`
- `scripts/three-platform-live-acceptance-core.mjs`
- `scripts/start-three-platform-live-acceptance.mjs`

fixture 位于 `examples/ai-annotation-demo/server/fixtures/mtl-protocol-contract.json`。它只保存无凭据的构造输入、真实输出、payload 字段、相关函数摘要、live acceptance core 摘要以及检查点。

## SDK 升级流程

1. 在仓库外拉取或更新可信的 meeting timeline SDK 克隆，并记录目标 commit。
2. 从本仓库根目录运行对账：

```bash
node scripts/check-mtl-protocol.mjs /absolute/path/to/lmt-sdk
```

3. 若命令报告 drift，逐项检查 builder 源码摘要、payload 字段/输出、平台列表、core/speaker check IDs 和 HTTP 响应检查点。不要只改摘要来消除失败；先确认 `mtl-receiver.ts` 是否仍满足新契约。
4. 如协议确实变更，更新接收端、fixture 的来源 commit/快照及 `mtl-protocol-contract.test.ts` 的响应断言。
5. 运行协议测试与现有接收端测试：

```bash
npm --workspace ./examples/ai-annotation-demo exec vitest run \
  server/mtl-protocol-contract.test.ts \
  server/mtl-receiver.test.ts
```

6. 再次运行对账，随后完成 demo 类型检查和构建：

```bash
npm run demo:check
npm run demo:build
```

对账退出码 `0` 表示目标 SDK 与当前 fixture 一致，`1` 表示发现协议漂移，`2` 表示参数、文件或脚本执行错误。脚本会加载目标 SDK 的 `index.mjs` 来重放固定 builder case，因此只对可信克隆运行。
