# Annotation Loop Demo — A 组竖切（周末预跑）

单文件 demo：`index.html`。覆盖闭环的 A 组段：**PDF 渲染 → 墨迹采集 → AnnotationEvent → (mock OCR → mock 推理) → overlay 回屏**，B 组段用 provider 接缝占位。

## 运行

```bash
cd annotation-loop-demo
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

平板实测（fallback 路径验证）：Mac 和 iPad 同一 Wi-Fi，iPad Safari 访问 `http://<Mac的IP>:8000`，用 Apple Pencil / 手指画。

## 它证明什么（对应周五 gate）

| 操作 | 验证的 gate / 决策 |
| --- | --- |
| 重复导入同一 PDF，document_id 不变 | Gate·PDF 身份稳定（hash 派生 id） |
| 画一笔，trace 出现 AnnotationEvent | Gate·标注监听 ≤1s（看「pen-up→event」延迟行） |
| 卡片出现 + 页面锚点虚线框位置正确 | Gate·结果可回屏 ⭐ |
| **缩放后**笔迹和锚点位置不漂移 | D1 归一化坐标闭环成立 |
| 顶栏「坐标自测 ✓」 | transform 栈往返误差 = 0 |
| 推理切到「模拟失败」，出现「稍后生成」卡片且可继续标注 | A11 降级不崩 |
| 侧栏分段延迟表 | I2 scorecard 的打点雏形 |
| 接受/忽略计数 | 北极星指标（接受率）预演 |
| 下载 trace.jsonl | trace 可复现（B 组 viewer 的输入样例） |

## 接缝（B 组 / 后续在哪里替换）

- `ocrProviders.vlm` —— 本周解锁真闭环：bbox 区域截图 → 多模态模型 → 返回同 shape 的 OCRResult，`runtime='cloud_fallback'`
- `ocrProviders.local` —— B 组 B3 本地 OCR 接入点
- `inferProviders.cloud` —— AB1 定稿后接真实云端推理（A8）
- 坐标换算只存在于 `normToPx` / `pxToNorm` 两个函数 —— 改坐标策略只动这里

## 已知简化（demo 范围内故意为之）

- 笔迹按页暂存，翻页清空（event 已进 trace，不丢数据语义）
- event 仅本地内存 + trace 下载，无服务端传输（第 5 步事件传输周二做）
- event_type 分类器是几何启发式（circle/underline/tap_region/stroke），margin_note 未实现
