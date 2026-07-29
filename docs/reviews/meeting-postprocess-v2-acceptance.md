# 会议后处理 V2 验收与调试路径

## 1. 快速本地验证

不需要真实模型 Key，可用确定性 mock 贯穿 snapshot → run → cards → summary → events：

```bash
npm run debug:meeting-postprocess --workspace examples/ai-annotation-demo -- fixtures/meeting-postprocess/ordinary.json
npm run test:meeting-postprocess --workspace examples/ai-annotation-demo
```

可替换 fixture：

- `ordinary.json`：普通会议，含明确决定与行动语句。
- `interview.json`：访谈问答，验证同一业务 schema。
- `handwriting.json`：提议 + 个人手写，验收证据隔离。
- `provisional.json`：InkLoop 自有正式转写/OCR 尚未收敛，验收 provisional 和缺失原因。
- `long.json`：长会议与尾部事实，验收分块、缓存和 tail coverage。

调试脚本输出：snapshot fingerprint/finality、摘要 run 的状态/attempt、Cards 与可读摘要两个 artifact 的内容和 revision、完整事件序列。用 `--root=/absolute/path` 可保留 JSON store，省略时使用临时目录。

### 六模板内容对比

对一场 InkLoop 自有事实链 fixture 批量运行六种模板；五种短纪要输出结构化结果，完整版访谈输出独立 HTML：

```bash
npm run accept:meeting-postprocess-templates --workspace examples/ai-annotation-demo -- \
  .inkloop/real-meeting-tests/fixtures-review/eab7664919c6.json \
  --templates=all \
  --real-model \
  --meeting-date=2026-07-14 \
  --output-dir=.inkloop/meeting-postprocess-acceptance/五模板真实模型 \
  --concurrency=2
```

- `--templates=all` 也可替换为逗号分隔的模板 ID：`meeting_expert,interview_memo`。
- 只生成快速纪要 Cards 和兼容可读摘要。完整报告与脑图均不生成。
- 可重复传入 `--conclusion=...`、`--impression=...`、`--pain-point=...` 模拟用户会后引导。
- 每份结果显示总耗时、模型调用、Cards 大小和证据引用检查。
- `README.md` 是人工验收入口，`manifest.json` 用于比较不同模型或版本的耗时、大小和失败率。

## 2. API 验收路径

前提：启动 Cloud Hub，使用有效设备 session。以下 payload 只示例必要字段。

### A. 自动创建后台 run

`POST /api/meeting-postprocess/runs`

```json
{
  "meeting_id": "acceptance-1",
  "title": "验收会议",
  "platform": "manual",
  "source": "local",
  "ocr_status": "ready",
  "utterances": [
    { "id": "u1", "speaker": "Alice", "start_ms": 0, "end_ms": 3000, "text": "我们决定周五发布。" }
  ],
  "handwriting": []
}
```

预期：返回 `202` 和 `snapshot_id`，状态为 `awaiting_configuration`；这是设备线索入口，即使旧客户端携带 `transcript_final/transcript_converged=true` 也只能形成 provisional snapshot。用户提交场景模板及可选引导后状态变为 `awaiting_transcript`；只有 InkLoop Meeting Media formalizer 提交自采双轨形成的 formal/明确 partial 转写，才返回唯一 `run_id`。Google Meet、Zoom、Teams、飞书等平台转写必须被丢弃，不能跨过收敛门。重复提交相同自有证据与配置仍返回同一 run。

### B. 不打开 recap 查看结果

- `GET /api/meeting-postprocess/runs?meeting_id=acceptance-1&occurrence_id=<上一步返回值>`
- `GET /api/meeting-postprocess/artifacts?meeting_id=acceptance-1&occurrence_id=<上一步返回值>`

预期：formal 转写收敛且配置已提交后，唯一的摘要 run 成功。新流程只产生：

1. `meeting.summary_cards`
2. `meeting.summary`（由 cards 确定性渲染）

旧客户端若调用 `POST /api/meeting-postprocess/full-report`，固定返回 HTTP `410` 与 `full_report_retired`，不得创建 run 或调用模型。

### C. 事件恢复

- JSON 调试：`GET /api/meeting-postprocess/events?meeting_id=acceptance-1&occurrence_id=<场次>&after=0`
- SSE：同一路径，发送 `Accept: text/event-stream`。
- 断开后携带 `Last-Event-ID: <最后事件 ID>` 重连。

预期：只收到更大的 event ID；scope 绑定当前 tenant/user/meeting；事件 payload 不含 transcript、handwriting、token 或 secret 正文。

### D. 晚到资料 revision

对相同 meeting occurrence 由 InkLoop Meeting Media 再提交新增尾部 utterance 或 OCR evidence。

预期：新 snapshot fingerprint/revision；旧 run/artifact 标记 `superseded`，不原地改写；新 artifact revision 增长。相同证据重放不得创建新 revision。

## 3. 产品验收矩阵

| 用例 | 输入 | 预期 |
|---|---|---|
| 普通会议 | 明确决定、owner、due | 决定/行动卡准确；文本与卡片一致 |
| 未明确 owner/due | 只有任务描述 | `owner=null`、`due=null`，不得补全 |
| 提议非决定 | “建议/可以考虑” | `proposal`，不得写为 `decision` |
| 个人手写 | “个人想法” | 不升级为会议共识，保留 handwriting source ref |
| 空结果 | 无决定/行动/风险 | succeeded + 明确空态，不显示失败 |
| 访谈 | 问答转写 | 仍使用同一 cards schema，不强制普通会议模板 |
| 自有 ASR 晚到 | provisional 后补 InkLoop 正式转写 | 新 revision 变 final，旧结果可审计 |
| 平台转写到达 | Google/Zoom/Teams/飞书 utterance | 全部丢弃；保持 awaiting_transcript；不得创建摘要 run |
| OCR 单页失败 | 两页中一页超时 | 另一页继续完成；snapshot 记录 `ocr_failed` |
| 长会议 | 事实位于最后 chunk | 尾部事实进入 cards；无 48k/64k 静默头部截断 |
| chunk 边界 | 决定跨相邻 chunk | overlap 后仍能抽取，reducer 去重 |
| 历史报告任务 | store 中存在 queued/running `meeting.full_report` | 调度恢复时取消并标记 `full_report_retired`，不得调用模型 |
| 重启恢复 | run 在 lease 中进程退出 | lease 过期后回到 queued，不重复 artifact |
| 用户编辑保护 | 本地 summary 有 `summary_user_edited_at` | V2 projection 不覆盖用户正文 |
| 跨用户访问 | 用户 B 查询用户 A meeting | 空结果/拒绝，不泄漏 artifact/events |
| 平台结束信号 | Meet/Zoom/Teams 等从 live 变 ended | 只更新场次与结束时间；等待 InkLoop formal transcript，不消费平台转写 |
| 自动重试 | Provider 首次超时 | backoff timer 自动重跑；不依赖设备或 recap 再请求 |
| 容量边界 | 活跃 run/SSE/replay 超过 namespace 配额 | 返回 429 或截断标记；不得无界占用内存/磁盘 |

## 4. UI 验收

1. 结束会议后不要打开 recap，先用 API 确认 artifact 已生成。
2. 打开 recap：先按 occurrence 读取配置；未配置时选择模板并可选填“当场结论、最深感受、关注痛点”。不应发起 legacy 巨型 `panel_summary` 或 `/api/chat` 思路总结请求；应只读取/投影 V2 cards/summary 并订阅 SSE。
3. provisional 显示“初步结果·仍在补齐资料”；final 显示“最终结果”。
4. cards 按概览、要点、决定、提议、行动项、风险、待确认、洞察分组。
5. 页面没有“生成/查看完整报告”入口，也不展示历史 `report_markdown`。
6. loading、empty、failed、provisional、final 可通过文字区分，不能只靠颜色。
7. “场景”可在大学课堂笔记、互动课堂、推理总结、访谈备忘录和会议总结间切换；切换生成新 snapshot/revision，不覆盖历史结果，切回已有模板可复用其 artifact。
8. 页面不再显示旧版文本树“脑图”；后续只有接入真正的可视化产物时才恢复该入口。
9. 不显示“确认说话人”步骤；高置信自动身份匹配可显示已知姓名，低置信结果保留稳定匿名标签。

## 5. 多来源与生命周期验收

1. 分别制造会议平台 ended transition，只允许建立/更新 occurrence 和 provisional 状态，不得把平台 transcript 写入 snapshot。
2. 同一 occurrence 重放 ended，不得触发 model call；只有 InkLoop Meeting Media formal transcript 或新板书/OCR revision 才能产生新 artifact revision。
3. worker 在 running lease 内退出并重启 Hub，确认 bootstrap 在 lease 过期后自动恢复。
4. `DELETE /api/meeting-postprocess/artifacts?meeting_id=...` 后确认 run、snapshot、artifact、event 均不可再读。
5. JSON event replay 最多返回 1000 条并带 `truncated=true`；单 identity 最多 4 个 SSE；store 自动限制 5000 events 与 500 个 chunk cache entries。

## 6. 提交前门槛

```bash
npm run check
npm run lint:ci
npm test
npm run build
```

另跑本文件第 1 节的后处理专项命令。真实模型验收必须记录 end→run、evidence→summary、artifact 大小、tail recall、owner/due 幻觉、重复 run 和摘要 token；不要仅记录一个总耗时。

## 7. 源方案逐条追踪（2026-07-21）

这里的“自动”指 InkLoop 自有 Meeting Media formal transcript 收敛后，无需进入 recap 即可创建 Hub run。平台 ended/source-sync 只用于场次识别和停止边界，绝不提供后处理文本证据。尚未注册过的设备本地会议没有可安全推断的本地 ID，worker 不会伪造映射。

### 7.1 功能验收

| 源方案条目 | 状态 | 可执行证据 |
|---|---|---|
| 自有 formal 收敛后自动创建唯一 run | 已实现 | Meeting Media formalizer 接线；`service.test.ts` identical replay |
| 平台 transcript 永不进入后处理 | 已实现 | provider-trigger discard test；Google/Zoom/Lark/MTL provenance gate tests |
| 不打开 recap 生成短纪要 | 已实现 | `scheduler.test.ts` canonical cards；`ordinary.json` debug 产生 Cards + summary |
| recap 不触发新总结 | 已实现 | `loadRecapView()` artifact-first + SSE；V2 UI 无生成按钮；旧 `/api/chat` 和 provider panel 生成均无生产调用 |
| OCR 正常完成后才开始短纪要 | 已实现于设备 ended 路径 | `triggerEndedMeetingPostprocess()` await OCR 后提交 snapshot；无手写为 `not_applicable` |
| OCR 失败不静默返回空结果 | 已实现 | service OCR failure test：`provisional + ocr_failed`；board OCR 单页失败测试 |
| `meeting.summary` 成为默认结果 | 已实现 | cards→deterministic renderer→summary artifact；client projection |
| 结构化卡片逐项显示 | 已实现 | validated `card.ready` events；recap progressive upsert |
| 从上次 event ID 恢复 | 已实现 | real HTTP SSE `Last-Event-ID` test；client reconnect loop |
| 完整报告不再生成 | 已实现 | legacy API 返回 410；scheduler 拒绝新 report run，并取消历史 queued/running run |
| 会议/访谈同 Prompt/schema | 已实现 | `ordinary.json`、`interview.json` 同一 debug path |
| 长会议不做 48k head-only 截断 | 已实现 | forced-chunk `long.json`；tail decision ref=`u3` |
| 结论可回溯到 utterance/mark | 已实现 | chunk-local/global source-ref validation；handwriting fixture |

### 7.2 质量验收

| 源方案条目 | 状态 | 可执行证据 |
|---|---|---|
| 未明确 owner/due 输出 null | 已实现 | cards schema + brief prompt + scheduler assertion |
| proposal 不升级为 confirmed decision | 已实现于 prompt/schema，需真实模型抽样 | `status: tentative/confirmed` 契约与 system prompt |
| 个人手写不冒充共识 | 已实现于 prompt/schema，需真实模型抽样 | `personal_notes` 独立字段与 mark refs |
| 尾部事实不遗漏 | 已实现 | long fixture tail decision + revised-tail cache test |
| overview/key points/actions/risks 少重复 | reducer 确定性去重已实现，语义质量需真实模型验收 | `reduceExtractions()` + Cards 密度约束 |
| 访谈可由同一 schema 表达 | 已实现 | interview fixture |
| 普通会议不强制研究报告 | 已实现 | V2 brief prompt；ordinary fixture |

### 7.3 上线环境校准项（不阻塞 Unit 完成）

- 用真实模型和真实会议流量锁定阈值：实现已记录摘要 `duration_ms`、artifact bytes、模型调用数和事件序列，但质量阈值需要验收样本，不能由 deterministic mock 代替。
- 删除链已按 Hub canonical state → 本地 projection 的顺序执行；Hub 删除失败保留本地 meeting 供重试。当前产品唯一自动删除入口（重复卡自愈）已接线，未来新增用户删除按钮必须复用 `deleteMeetingPostprocess()`。
- 多 active worker 放量前把文件 store 迁移到具备原子领取/唯一约束的持久层；当前拓扑明确为单 active worker。
