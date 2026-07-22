---
title: "Education classroom Phase 2 formula recognition implementation"
date: 2026-07-19
status: passed
scope: "Phase 2 / Unit 4"
---

# Phase 2 / Unit 4 实施与验收

## 结论

公式识别 revision、教师审核、学生可信状态和服务端 trust gate 已落地。默认本地 provider 未配置时明确记录 failed，不伪造公式；外部识别必须由教师显式开启，并只上传所选笔画的白底 PNG 裁图、验证过的 event IDs、surface 与 bbox。

## 已实现

- 同 surface、同书写行和有限时间窗的客户端笔迹分组，禁止跨页、跨草稿和跨行合并。
- append-only recognition revision：pending、confirmed、corrected、dismissed、failed；更正保留原候选和来源。
- 教师紧凑审核栏：识别最近一行、确认、纠正文本/LaTeX、驳回、定位原笔迹。
- 学生只读可信状态：待确认不显示为确定公式，confirmed/corrected 才显示转写文本。
- pending/failed 公式的实时解释只返回不确定提示；总结、练习和 LessonGraph 在审核前拒绝生成。
- 生成结果保存 recognition revision fingerprint；上游更正后旧结果标 stale，并可按新证据重试。
- recognition JSON 与 point-free timeline 的启动修复和精确 revision 幂等重试。
- 固定六行配方法 fixture 覆盖 `x² + 4x - 5 = 0` 到 `x = 1 或 x = -5`，包括 `+3` 更正为 `±3`。

## 自动验证

- Demo TypeScript check：通过。
- Demo Biome lint：通过。
- Demo tests：644 passed。
- Demo production build：通过。
- SDK TypeScript check / Biome lint：通过。
- SDK tests：96 passed。
- 六行 fixture contract：6/6 经过识别、教师确认和 trusted projection。

## 浏览器可视验收

- 教师入口：内置两页配方法讲义正常，右侧公式审核栏没有遮挡主教材；隐私开关文案明确。
- 学生入口：教材主区、跟随状态、私人 AI 区和老师板书识别状态层级清晰；没有审核控件。
- 截图：`docs/reviews/education-unit4-teacher.png`、`docs/reviews/education-unit4-student.png`。

## 尚需真实 provider 验收

本地测试 adapter 已通过六行语义门槛，但真实云/本地 HWR 的字迹准确率和 P95 需在配置 provider 后，用同一 fixture 和真实手写逐行复测。没有 provider 时，产品保持 failed/待重试状态，不以确定性 fallback 冒充识别。
