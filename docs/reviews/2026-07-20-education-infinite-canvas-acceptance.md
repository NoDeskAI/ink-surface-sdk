---
title: "Education infinite canvas acceptance"
date: 2026-07-20
status: conditional-pass
scope: teacher-and-student-web
---

# 结论

教育课堂的每教材页无限画布已完成自动化与桌面 Chrome 有界面验收。功能实现通过；设备矩阵仍是 **conditional pass**，因为桌面 Safari 和真实 iPad/Pencil 尚未执行，不能用 Chrome/CDP 模拟替代。

## 已通过证据

- 单一教学视口：教师/学生各只有一个 `.board-frame`，外层裁剪，教材层 `overflow: visible` 且无 nested scroll；教材、点阵、笔迹、焦点和框选共用一个 world transform。
- 每页事实：sequence 15，包括两页的 14 条 world 新笔迹和 1 条 legacy normalized fixture；主/次页只挂自己的路径，往返后 camera 和 ink 恢复。
- 教师/学生同步：transient/final revision fence、跨后续 revision 和重启的 final 幂等、学生 follow/free browse/return、晚加入、服务重连、删除传播均通过。
- 来源与兼容：world 与 legacy normalized 事件都能从学生结果切到正确教材页、fit 对应 world region 并高亮原笔迹；新教师笔迹只写 world branch。
- 故障与资源：非法坐标原子拒绝；preview 不持久化；4096 points、128KiB、页/课堂事件与字节配额、重启重建、PDF 失败保留点阵/ink、恢复 raster、删除 fence 均通过。
- 隐私：学生本地 camera/selection/private job 不进入 shared stream；跨参与者 job/anchor/signaling 被拒绝；学生 `getUserMedia` 调用为 0。
- 数学题：真实 `glm-5.2` 对 `x² + 4x - 5 = 0` 的当前步骤、框选解释、完整总结、练习和 5-candidate LessonGraph 均通过数学语义与 source allowlist；本次各项均一次成功。结构化输出失败时的 retry 仍由自动测试覆盖。
- 延迟：31 个 browser-simulation 提交样本；world stroke P50/P95 `4/5 ms`、transient view `5/11 ms`、durable view `10/67 ms`，均低于 `150/300 ms`。
- HTTPS/LAN：headed Chrome 的教师/学生均在 `https://localhost:8872`，`isSecureContext=true`；LAN 页面和预检从 `https://172.168.20.94:8872` 返回，未请求旧 `8731`。

## 完整审查与回归

- 完整代码审查已修复：50%–400% zoom 契约不一致、teacher/focus surface 不一致、普通 projection 缺少课堂状态与教材页校验、教师/学生 PDF 异步晚到覆盖、旧 confirmed focus 乱序覆盖、迟到 preview 回退、stroke/preview/transient 速率预算偏差，以及验收脚本将 culling 误判为账本丢失。
- 根包：`npm run check`、`npm run lint:ci`、`npm test`（99 tests）、`npm run build` 全部通过。
- demo：`npm run check`、`npm run lint:ci`、`npm test`（712 tests）、`npm run build` 全部通过。
- 冻结回归：meeting V1 E2E、reader reflow trust loop、runtime sync、AI Pen V1、Android/Paper asset/default entry 全部通过。

## 有界面截图

- `docs/reviews/education-infinite-canvas-headed-https-teacher.png`
- `docs/reviews/education-infinite-canvas-headed-https-student.png`
- `docs/reviews/education-infinite-canvas-headed-pdf-failure.png`

## 尚未执行的真实设备门

- 桌面 Safari：滚轮锚点缩放、Space+mouse、页面不误滚。
- 真实 iPad Safari/Pencil：Pencil 写字、手掌拒绝、双指 pan/pinch、证书安装与信任、音频播放体验。
- 真实麦克风/真实 STT/HWR 的物理质量与延迟。

这些未测项不否定双 Web 功能实现，但发布前必须按 validation runbook 记录为通过、降级或失败。
