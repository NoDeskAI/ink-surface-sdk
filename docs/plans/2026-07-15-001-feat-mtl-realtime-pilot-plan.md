# MTL 实时会议扩展 Pilot 操作说明

## 目的与边界

本说明用于 P3-A 首次真实 Google Meet 测试。浏览器扩展的默认 `baseUrl` 会包含用户密径 token，生成目录等同于凭据，不得提交到 Git、上传共享盘或发送给其他用户。每位用户单独签发；泄露或测试结束后立即吊销并重新导出。

本仓库不直接导入临时 SDK 克隆，也不保存带 token 的扩展产物。导出操作从 SDK 克隆执行，产物放在仓库外的私有目录。

## 前置条件

- Cloud Hub 已部署本分支，并设置正确的 `PUBLIC_HUB_BASE`；未设置时默认为 `https://meet.xiaobuyu.trade`。
- 反向代理/网关访问日志已对 `/api/mtl/<token>/...` 路径做脱敏或关闭记录，不能把密径写进基础设施日志。
- 设备已完成 InkLoop session 登录，且同一用户已连接 Google Calendar/Meet OAuth。
- Calendar 中已有本次 Google Meet 日程，会议链接 code 与实际入会 URL 一致。
- SDK 克隆包含 `scripts/export-three-platform-adapters.mjs` 和 `scripts/export-meeting-app-extension.mjs`。

当前参照克隆：

```bash
export MTL_SDK_ROOT=/private/tmp/claude-501/-Users-edy-Desktop-Nova-project/bcde8ed3-0c4a-4a6d-94a3-b4a3dfcd28d9/scratchpad/lmt-sdk
export HUB_BASE=https://meet.xiaobuyu.trade
export INKLOOP_SESSION='<device-session-token>'
```

## 1. 签发并核对密径

签发是幂等的：同一 tenant/user 已有未吊销 token 时返回原 token。

```bash
curl -sS -X POST "$HUB_BASE/api/google/mtl-token" \
  -H "Authorization: Bearer $INKLOOP_SESSION"
```

响应形如：

```json
{
  "token": "<32-hex>",
  "base_url": "https://meet.xiaobuyu.trade/api/mtl/<32-hex>",
  "created_at": "2026-07-15T00:00:00.000Z"
}
```

把响应中的完整 `base_url` 放入本机环境变量，不要只填 Hub 域名：

```bash
export MTL_BASE_URL='https://meet.xiaobuyu.trade/api/mtl/<32-hex>'
curl -sS "$MTL_BASE_URL/api/state"
```

探活应返回：

```json
{"ok":true,"service":"inkloop-mtl-receiver"}
```

仅查看现有签发信息可调用：

```bash
curl -sS "$HUB_BASE/api/google/mtl-token" \
  -H "Authorization: Bearer $INKLOOP_SESSION"
```

## 2. 从 SDK 导出 unpacked extension

完整三平台交付导出：

```bash
export MTL_EXTENSION_OUT=/private/tmp/inkloop-mtl-extension
cd "$MTL_SDK_ROOT"
node scripts/export-three-platform-adapters.mjs \
  --out-dir="$MTL_EXTENSION_OUT" \
  --base-url="$MTL_BASE_URL"
```

Chrome 要加载的目录是：

```text
/private/tmp/inkloop-mtl-extension/browser-extension
```

若本次只需浏览器扩展，或完整交付脚本因 desktop/package 验证环境不可用，可使用 SDK 自带的单扩展导出逻辑：

```bash
rm -rf /private/tmp/inkloop-mtl-google-extension
cd "$MTL_SDK_ROOT"
node scripts/export-meeting-app-extension.mjs \
  --out-dir=/private/tmp/inkloop-mtl-google-extension \
  --base-url="$MTL_BASE_URL" \
  --platforms=google-meet \
  --build=true
```

导出后检查生成的 `background.js` 中默认基址包含 `/api/mtl/`，但不要把 token 打到终端日志或截图中。

## 3. Chrome 安装与首测

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择上一步的 `browser-extension` 或单扩展输出目录。
4. 打开扩展 popup，确认服务探活成功。
5. 在该用户 Calendar 日程对应的 `https://meet.google.com/xxx-yyyy-zzz` 进入真实会议。
6. 保持 InkLoop 设备已登录、Google 已连接，并停留在可轮询会议数据的状态。
7. 离开会议，等待下一次设备轮询和后台转写检查。

## 4. 验收观察点

入会后：

- Hub 的 `.inkloop/mtl-events/<tenant>/<user>/live-state.json` 出现 `google_meet` 窗口，包含 `meeting_code` 和 `started_at_ms`。
- 对应 Calendar 会议卡在下一次约 12 秒轮询内变为“进行中”。
- 本地会议写入 `t0_source=local_detector`、`align_state=estimated`；已有 `provider_event`/`recording_event` 锚点时不得被覆盖。
- `.inkloop/mtl-events/<tenant>/<user>/events.jsonl` 有白名单审计，但没有完整 `meeting_app_record.snapshot` DOM。

离会后：

- 同一窗口写入 `ended_at_ms`，会议卡在下一次轮询内变为“已结束”。
- end 的 `meeting_id` 与当前 active 不一致时 Hub 返回结构化 409，不能结束另一场会议。
- Hub 异步触发一次 Google Meet transcript catch-up；没有可用 Google token 时只记录跳过原因，不阻塞 end 响应。
- 选场优先使用与真实出席窗口重叠的 `conferenceRecord`；旧的 `no_record/not_generated` job 在 10 分钟后可重查并翻转为 `ready`。

## 5. 吊销与清理

```bash
curl -sS -X DELETE "$HUB_BASE/api/google/mtl-token" \
  -H "Authorization: Bearer $INKLOOP_SESSION"
rm -rf /private/tmp/inkloop-mtl-extension /private/tmp/inkloop-mtl-google-extension
```

吊销后旧扩展访问任意密径 endpoint 都应得到 404。需要继续测试时重新签发并重新导出，旧扩展不能复用新 token。

## 故障定位

- 扩展探活 404：token 已吊销、基址漏了 `/api/mtl/<token>`，或扩展仍使用旧的 storage 配置。
- 设备会议卡不变化：先确认 `meeting-sources` 返回 `mtl_token_configured=true`，再检查 live-state 中 `platform + meeting_code + 日期` 是否能命中本地 Calendar 卡。
- end 返回 409：检查扩展上报的 `meeting_id` 是否与 live-state 当前未结束窗口一致；不要手工结束其他窗口。
- 没有自动转写检查：确认该 tenant/user 至少一个设备桶中有可用 Google OAuth token，并且 OAuth scopes 完整。
