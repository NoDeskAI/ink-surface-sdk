---
title: "Education classroom Unit 8 hard acceptance"
date: 2026-07-20
status: conditional-pass
scope: two-web-classroom
---

# Unit 8 结论

固定案例已统一为 `x² + 4x - 5 = 0`。双 Web 自动化工作流、真实 AI 数学语义、来源白名单、参与者隔离、恢复、删除、浏览器性能和既有产品冻结门均通过。真实麦克风、真实 STT、真实手写识别和人工中文可用性仍需在已配置 provider/设备的可信 HTTPS 环境中验收，因此本单元判为 **conditional pass**，不能把 fixture 当成这些物理/供应商门的通过证据。

## 固定数学门

唯一推导为：

1. `x² + 4x - 5 = 0`
2. `x² + 4x = 5`
3. `x² + 4x + 4 = 9`
4. `(x + 2)² = 9`
5. `x + 2 = ±3`
6. `x = 1 或 x = -5`

Fixture、内置讲义、自动脚本、人工脚本与模板均以此为准。练习语义检查会解析任意首一元二次方程，用根的和与积验证答案，并拒绝泄露答案或不包含配方法线索的提示。

## 自动化证据

- 真实 AI：`glm-5.2`，学生 prompt `inkloop.education.v2`，LessonGraph prompt `inkloop.education.v3`。当前步骤、框选区域、完整总结、练习和原始 LessonGraph 五项的数学语义与 event source allowlist 均通过；每项本次均一次成功。
- 双 Web：Chrome `150.0.7871.128`，1 教师 + 3 个隔离学生 profile，最终 sequence 15（14 条 world 新笔迹 + 1 条 legacy normalized fixture）。通过单一教学视口、双页独立相机/ledger、教师焦点、transient/final、跟随/自由浏览/返回、晚加入、world/legacy 来源跳转、当前步骤、错过片段、框选区域、私人出题锚点、公式更正 stale、服务重启、课后总结/练习、教师审核恢复、音频删除与课堂删除。
- 隐私/安全：跨 participant job 返回 404；另一学生看不到私人 anchor；伪造 participant signal 被拒绝；学生端 `getUserMedia` 调用数为 0；外部转写需 HTTPS、显式 opt-in，且拒绝私网/不安全目标；公开错误只保存稳定错误码，不保存 provider 正文或密钥。
- 浏览器性能：31 个真实浏览器 render 样本；world stroke P50/P95 `4/5 ms`、transient view `5/11 ms`、durable view `10/67 ms`，均低于 `150/300 ms`。这是 Web 模拟证据，不代表 AI Pen、iPad 或电子纸刷新性能。
- 自动测试：App `712 tests`，根包 `99 tests`；TypeScript、Biome、根构建与 App 构建均通过。

## 冻结门

- Meeting V1 E2E：通过。
- Reading/Reflow trust loop：通过。
- Runtime Sync：通过，未走 release path。
- AI Pen V1 smoke：通过。
- Android asset/default-entry：通过，`mobile.html` 保持默认入口。课堂 HTML 只是附加资源。

## 仍待人工/真实 provider

- 可信 HTTPS 下的真实教师麦克风、学生实际听感和浏览器权限提示。
- 桌面 Safari 与真实 iPad Safari/Pencil 的书写、双指 pan/pinch、手掌拒绝、证书信任和页面不误滚；当前只有 headed desktop Chrome 证据。
- 真实本地/外部 STT 的样本量、P50/P95（final subtitle P95 门槛 `≤ 5 s`）及固定中文讲稿准确率。
- 真实 HWR/公式识别的逐行准确率、样本量与 P50/P95。
- 人工检查 AI 中文讲解是否自然、公式不确定性表达、两个 Web 的来源跳转，以及教师是否无需重写大部分 LessonGraph。
- 电子纸设备不属于本轮范围，不作为 Unit 8 阻塞项。

生成的真实 AI 原文、浏览器报告和 latency CSV/JSON 位于 ignored `examples/ai-annotation-demo/test-results/`，不得提交凭证、音频正文、字幕正文或供应商 payload。
