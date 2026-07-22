# 教育课堂 Phase 1 实施记录

日期：2026-07-19
范围：Units 1-3（两个普通 Web 客户端；不含识别、音频和视频）

## 已落地

- 课堂契约新增 capability、material、surface、teacher view、confirmed focus 和 point-free timeline。
- `events.jsonl` 继续作为板书真相；`timeline.jsonl` 只引用 board sequence / event ID / surface，并在重启时补齐缺项、截断损坏或悬空尾部。
- 新课堂启用 textbook；第一阶段旧课堂缺省推导为 whiteboard-only，保留原板书路径。
- 教师可使用内置两页配方法讲义或上传 PDF。服务端校验 PDF magic、大小、页数、解析超时、加密状态和 SHA-256；学生只能读取本课堂已发布材料。
- 教师可翻页、缩放、直接在当前课本页标注、打开与当前页/区域关联的草稿、确认全班焦点。
- 学生默认跟随教师；主动翻页或缩放进入本地自由浏览，教师更新只提示、不强拉；“返回老师位置”一次恢复最新页、缩放与确认焦点；状态跨重连保留，清除设备数据后恢复默认跟随。
- 内置验收讲义源：`fixtures/education-completing-square-handout.md`；PDF：`public/demo/education/completing-square-handout.pdf`。

## 已完成验证

- Demo 单测：630 passed。
- SDK 单测：95 passed。
- Demo 与 SDK TypeScript check：passed。
- Demo 与 SDK Biome lint：passed。
- Demo 与 SDK production build：passed。
- PDF `pdfinfo`：2 页、A4、未加密；两页均经 PNG 渲染人工检查，无裁切、重叠或中文乱码。
- 浏览器双 Web 联动验收（headed Chrome，1180 × 820）：passed。
  - 新建课堂后自动发布并显示两页内置讲义，学生凭课堂码进入后看到相同第 1 页。
  - 教师翻到第 2 页并从 100% 放大到 110%，跟随学生显示相同页码/缩放。
  - 学生主动回到第 1 页进入自由浏览；教师缩回 100% 后学生仍停在第 1 页并显示“老师已移动”，未被强拉。
  - 学生刷新后仍保持自由浏览和本地第 1 页；点击“返回老师位置”后一次恢复第 2 页、100% 和教师确认焦点。
  - 教师在第 2 页书写一笔并确认焦点，教师/学生各收到 1 条相同 surface 的板书，焦点框视觉对齐。
  - 教师打开关联草稿并书写一笔，学生同步进入 scratch surface 并收到相同草稿笔迹；返回课本后恢复原第 2 页。
  - 结束课堂经原生确认后，教师显示“课程已结束”，学生状态更新为“已结束”。
  - 可视检查发现并修复学生课本页框缺少 `textbook-frame` class 导致的右侧方格空白；复测后 PDF、笔迹层和焦点层尺寸一致。
  - 页面没有运行时异常；仅有浏览器请求站点图标产生的无关 404。

## 明确不在本阶段

- 数学公式识别与教师校正队列（Unit 4）。
- 实时音频、视频和转写（Units 5-6）。
- 将课本文字/公式/音频合并为可信 AI evidence（Unit 7）。
