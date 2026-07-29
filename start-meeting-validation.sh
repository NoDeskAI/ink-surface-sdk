#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
demo_root="$repo_root/examples/ai-annotation-demo"
companion_root="$repo_root/native/macos/InkLoopMeetingCompanion"
runtime_root="$repo_root/.inkloop/meeting-validation"
meeting_media_token_file="$runtime_root/session-token"
live_board_token_file="$runtime_root/live-board-session-token"
whisper_fingerprint_file="$runtime_root/whisper-source.sha256"
meeting_media_fingerprint_file="$runtime_root/meeting-media-source.sha256"
live_board_fingerprint_file="$runtime_root/live-board-source.sha256"
companion_app="$companion_root/.build/app/debug/InkLoop Meeting Companion.app"
companion_binary="$companion_app/Contents/MacOS/InkLoopMeetingCompanion"
obs_binary="/Applications/OBS.app/Contents/MacOS/OBS"

whisper_url="http://127.0.0.1:8081/health"
meeting_media_url="http://127.0.0.1:3000/api/meeting-media/live-status"
live_board_url="http://127.0.0.1:8765/meeting-live-board.html"
meet_url="${INKLOOP_GOOGLE_MEET_URL:-https://meet.google.com/new}"

meeting_media_token=''
live_board_token=''

ensure_meeting_media_token() {
  local token=''
  mkdir -p "$runtime_root"
  chmod 700 "$runtime_root"
  if [[ -f "$meeting_media_token_file" ]]; then
    token="$(tr -d '[:space:]' <"$meeting_media_token_file")"
  fi
  if [[ ! "$token" =~ ^[A-Fa-f0-9]{64}$ ]]; then
    umask 077
    token="$(openssl rand -hex 32)"
    printf '%s\n' "$token" >"$meeting_media_token_file"
  fi
  chmod 600 "$meeting_media_token_file"
  meeting_media_token="$token"
  defaults write ai.inkloop.meeting-companion meetingMediaSessionToken -string "$meeting_media_token"

  token=''
  if [[ -f "$live_board_token_file" ]]; then
    token="$(tr -d '[:space:]' <"$live_board_token_file")"
  fi
  if [[ ! "$token" =~ ^[A-Fa-f0-9]{64}$ ]]; then
    umask 077
    token="$(openssl rand -hex 32)"
    printf '%s\n' "$token" >"$live_board_token_file"
  fi
  chmod 600 "$live_board_token_file"
  live_board_token="$token"
}

load_existing_tokens() {
  meeting_media_token=''
  live_board_token=''
  if [[ -f "$meeting_media_token_file" ]]; then
    meeting_media_token="$(tr -d '[:space:]' <"$meeting_media_token_file")"
  fi
  if [[ -f "$live_board_token_file" ]]; then
    live_board_token="$(tr -d '[:space:]' <"$live_board_token_file")"
  fi
  [[ "$meeting_media_token" =~ ^[A-Fa-f0-9]{64}$ ]] || meeting_media_token=''
  [[ "$live_board_token" =~ ^[A-Fa-f0-9]{64}$ ]] || live_board_token=''
}

source_fingerprint() {
  find "$@" -type f -print 2>/dev/null \
    | LC_ALL=C sort \
    | while IFS= read -r source_file; do
        shasum -a 256 "$source_file"
      done \
    | shasum -a 256 \
    | awk '{print $1}'
}

fingerprint_matches() {
  local fingerprint_file="$1"
  local expected="$2"
  [[ -f "$fingerprint_file" ]] \
    && [[ "$(tr -d '[:space:]' <"$fingerprint_file")" == "$expected" ]]
}

save_fingerprint() {
  local fingerprint_file="$1"
  local value="$2"
  umask 077
  printf '%s\n' "$value" >"$fingerprint_file"
}

say() {
  printf '[InkLoop 验收] %s\n' "$*"
}

check_whisper() {
  curl -fsS --max-time 2 "$whisper_url" >/dev/null 2>&1
}

check_meeting_media() {
  [[ -n "$meeting_media_token" && -n "$live_board_token" ]] || return 1
  curl -fsS --max-time 2 \
    -H "Authorization: Bearer $meeting_media_token" \
    "$meeting_media_url" >/dev/null 2>&1 \
    && curl -fsS --max-time 2 \
      -H "Authorization: Bearer $live_board_token" \
      "$meeting_media_url" >/dev/null 2>&1
}

meeting_media_active() {
  [[ -n "$meeting_media_token" ]] || return 1
  curl -fsS --max-time 2 \
    -H "Authorization: Bearer $meeting_media_token" \
    "$meeting_media_url" 2>/dev/null \
    | node -e '
      let input = "";
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try { process.exit(JSON.parse(input).active === true ? 0 : 1); }
        catch { process.exit(1); }
      });
    '
}

check_live_board() {
  [[ -n "$live_board_token" ]] || return 1
  curl -fsS --max-time 2 "$live_board_url" >/dev/null 2>&1 \
    && curl -fsS --max-time 2 \
      -H "Authorization: Bearer $live_board_token" \
      "$meeting_media_url" >/dev/null 2>&1
}

companion_running() {
  pgrep -f '/InkLoop Meeting Companion\.app/Contents/MacOS/InkLoopMeetingCompanion($| )' \
    >/dev/null 2>&1
}

companion_stopped() {
  ! companion_running
}

obs_running() {
  pgrep -f '^/Applications/OBS\.app/Contents/MacOS/OBS($| )' >/dev/null 2>&1
}

obs_virtual_camera_running() {
  local latest_event latest_log
  obs_running || return 1
  latest_log="$(ls -t "$HOME/Library/Application Support/obs-studio/logs"/*.txt 2>/dev/null \
    | head -n 1 || true)"
  [[ -n "$latest_log" ]] || return 1
  latest_event="$(grep -E '==== Virtual Camera (Start|Stop) ' "$latest_log" | tail -n 1 || true)"
  [[ "$latest_event" == *'Virtual Camera Start '* ]]
}

print_component_status() {
  local label="$1"
  shift
  if "$@"; then
    printf '  ✓ %s\n' "$label"
    return 0
  fi
  printf '  ✗ %s\n' "$label"
  return 1
}

show_status() {
  local failed=0
  say '当前状态：'
  print_component_status 'Whisper ASR（127.0.0.1:8081）' check_whisper || failed=1
  print_component_status 'Meeting Media（127.0.0.1:3000）' check_meeting_media || failed=1
  print_component_status 'Live Board（127.0.0.1:8765）' check_live_board || failed=1
  print_component_status 'InkLoop Meeting Companion' companion_running || failed=1
  print_component_status 'OBS + 虚拟摄像头' obs_virtual_camera_running || failed=1
  return "$failed"
}

show_status_json() {
  local whisper=false media=false board=false companion=false obs=false overall=true
  check_whisper && whisper=true || overall=false
  check_meeting_media && media=true || overall=false
  check_live_board && board=true || overall=false
  companion_running && companion=true || overall=false
  obs_virtual_camera_running && obs=true || overall=false
  printf '{"schema_version":"inkloop.meeting_validation_status.v1","overall":%s,"components":{"whisper":{"healthy":%s},"meeting_media":{"healthy":%s},"live_board":{"healthy":%s},"companion":{"healthy":%s},"obs_virtual_camera":{"healthy":%s}}}\n' \
    "$overall" "$whisper" "$media" "$board" "$companion" "$obs"
  [[ "$overall" == true ]]
}

wait_for() {
  local timeout_seconds="$1"
  local check_function="$2"
  local elapsed=0
  while (( elapsed < timeout_seconds )); do
    if "$check_function"; then
      return 0
    fi
    sleep 1
    ((elapsed += 1))
  done
  return 1
}

start_launchd_npm_service() {
  local label="$1"
  local launchd_label="$2"
  local pid_file="$3"
  local log_file="$4"
  local error_log="${log_file%.log}.error.log"
  local npm_binary old_pid new_pid
  shift 4

  say "启动 ${label}…"
  npm_binary="$(command -v npm)"
  old_pid="$(launchctl list "$launchd_label" 2>/dev/null \
    | sed -n 's/^[[:space:]]*"PID"[[:space:]]*=[[:space:]]*\\([0-9][0-9]*\\);/\\1/p' \
    || true)"
  launchctl remove "$launchd_label" >/dev/null 2>&1 || true
  for _ in {1..100}; do
    if ! launchctl list "$launchd_label" >/dev/null 2>&1 \
      && { [[ -z "$old_pid" ]] || ! kill -0 "$old_pid" >/dev/null 2>&1; }; then
      break
    fi
    sleep 0.1
  done
  if launchctl list "$launchd_label" >/dev/null 2>&1 \
    || { [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; }; then
    say "${label} 的旧进程未在 10 秒内退出。"
    return 1
  fi
  : >"$log_file"
  : >"$error_log"
  launchctl submit \
    -l "$launchd_label" \
    -o "$log_file" \
    -e "$error_log" \
    -- /usr/bin/env \
      "PATH=$PATH" \
      "HOST=127.0.0.1" \
      "INKLOOP_LOCAL_DEVICE_AUTH_TOKEN=$meeting_media_token" \
      "INKLOOP_LOCAL_DEVICE_AUTH_TOKEN_FILE=$meeting_media_token_file" \
      "INKLOOP_LOCAL_BROWSER_AUTH_TOKEN=$live_board_token" \
      "VITE_INKLOOP_LOCAL_DEMO_SESSION_TOKEN=$live_board_token" \
      "$npm_binary" --prefix "$demo_root" "$@"
  new_pid=''
  for _ in {1..100}; do
    new_pid="$(launchctl list "$launchd_label" 2>/dev/null \
      | sed -n 's/^[[:space:]]*"PID"[[:space:]]*=[[:space:]]*\\([0-9][0-9]*\\);/\\1/p' \
      || true)"
    if [[ -n "$new_pid" && "$new_pid" != "$old_pid" ]] \
      && kill -0 "$new_pid" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  if [[ -z "$new_pid" || "$new_pid" == "$old_pid" ]] \
    || ! kill -0 "$new_pid" >/dev/null 2>&1; then
    say "${label} 的新 launchd 进程未稳定启动。"
    return 1
  fi
  printf '%s\n' "$new_pid" >"$pid_file"
}

fail_with_log() {
  local label="$1"
  local log_file="$2"
  local error_log="${log_file%.log}.error.log"
  say "$label 启动失败，最近日志："
  tail -n 40 "$log_file" 2>/dev/null || true
  tail -n 40 "$error_log" 2>/dev/null || true
  exit 1
}

ensure_whisper() {
  local log_file="$runtime_root/whisper.log"
  local fingerprint
  fingerprint="$(source_fingerprint \
    "$demo_root/scripts/start-local-whisper.ts" \
    "$demo_root/server/local-whisper-transcription.ts" \
    "$demo_root/package.json" \
    "$repo_root/package-lock.json")"
  if check_whisper; then
    if fingerprint_matches "$whisper_fingerprint_file" "$fingerprint"; then
      say 'Whisper 已运行且源码版本一致，直接复用。'
      return
    fi
    if meeting_media_active; then
      say 'Whisper 源码已更新，但当前有会议正在录制；为避免中断，本次拒绝复用旧进程。请结束会议后重试。'
      exit 1
    fi
    say 'Whisper 源码已更新，重启到当前 worktree 版本。'
  fi
  start_launchd_npm_service \
    'Whisper ASR' \
    'ai.inkloop.meeting-validation.whisper' \
    "$runtime_root/whisper.pid" \
    "$log_file" \
    run 'serve:meeting-media:whisper' \
    || fail_with_log 'Whisper ASR' "$log_file"
  wait_for 45 check_whisper || fail_with_log 'Whisper ASR' "$log_file"
  save_fingerprint "$whisper_fingerprint_file" "$fingerprint"
  say 'Whisper 已就绪（Large V3 Turbo Q5 + Silero VAD）。'
}

ensure_meeting_media() {
  local log_file="$runtime_root/meeting-media.log"
  local fingerprint
  fingerprint="$(source_fingerprint \
    "$demo_root/server" \
    "$repo_root/packages/meeting-media-core/src" \
    "$demo_root/package.json" \
    "$repo_root/package-lock.json")"
  if check_meeting_media; then
    if fingerprint_matches "$meeting_media_fingerprint_file" "$fingerprint"; then
      say 'Meeting Media 已运行且源码版本一致，直接复用。'
      return
    fi
    if meeting_media_active; then
      say 'Meeting Media 源码已更新，但当前有会议正在录制；为避免中断，本次拒绝复用旧进程。请结束会议后重试。'
      exit 1
    fi
    say 'Meeting Media 源码已更新，重启到当前 worktree 版本。'
  fi
  start_launchd_npm_service \
    'Meeting Media' \
    'ai.inkloop.meeting-validation.media' \
    "$runtime_root/meeting-media.pid" \
    "$log_file" \
    run 'serve:meeting-media' \
    || fail_with_log 'Meeting Media' "$log_file"
  wait_for 45 check_meeting_media || fail_with_log 'Meeting Media' "$log_file"
  save_fingerprint "$meeting_media_fingerprint_file" "$fingerprint"
  say 'Meeting Media 已就绪（首窗 3s / 每 4s 修订 / 20s 最大上下文）。'
}

ensure_live_board() {
  local log_file="$runtime_root/live-board.log"
  local fingerprint
  fingerprint="$(source_fingerprint \
    "$demo_root/src" \
    "$demo_root/meeting-live-board.html" \
    "$demo_root/vite.config.ts" \
    "$demo_root/package.json" \
    "$repo_root/package-lock.json")"
  if check_live_board; then
    if fingerprint_matches "$live_board_fingerprint_file" "$fingerprint"; then
      say 'Live Board 已运行且源码版本一致，直接复用。'
      return
    fi
    if meeting_media_active; then
      say 'Live Board 源码已更新，但当前有会议正在录制；为避免页面重载，本次拒绝复用旧进程。请结束会议后重试。'
      exit 1
    fi
    say 'Live Board 源码已更新，重启到当前 worktree 版本。'
  fi
  start_launchd_npm_service \
    'Live Board' \
    'ai.inkloop.meeting-validation.live-board' \
    "$runtime_root/live-board.pid" \
    "$log_file" \
    run dev -- --host 127.0.0.1 --port 8765 --strictPort \
    || fail_with_log 'Live Board' "$log_file"
  wait_for 45 check_live_board || fail_with_log 'Live Board' "$log_file"
  save_fingerprint "$live_board_fingerprint_file" "$fingerprint"
  say 'Live Board 已就绪。'
}

companion_needs_build() {
  if [[ ! -x "$companion_binary" ]]; then
    return 0
  fi
  find \
    "$companion_root/Sources" \
    "$companion_root/Resources" \
    "$companion_root/Package.swift" \
    "$companion_root/scripts/build-app.sh" \
    -type f -newer "$companion_binary" -print -quit 2>/dev/null \
    | grep -q .
}

ensure_companion() {
  if companion_running; then
    if ! companion_needs_build; then
      say 'Companion 已运行且构建版本一致，直接复用。'
      open "$companion_app"
      return
    fi
    if meeting_media_active; then
      say 'Companion 源码比运行中的 App 新，但当前有会议正在录制；为避免中断，本次拒绝复用旧版本。请结束会议后重试。'
      exit 1
    fi
    say 'Companion 源码已更新，先正常退出空闲旧版本。'
    osascript -e 'tell application id "ai.inkloop.meeting-companion" to quit' \
      >/dev/null 2>&1 || true
    wait_for 10 companion_stopped || {
      say 'Companion 未能在 10 秒内正常退出；没有强制结束进程。'
      exit 1
    }
  fi

  if companion_needs_build; then
    say '构建最新版 Companion…'
    (
      cd "$companion_root"
      ./scripts/build-app.sh
    ) >"$runtime_root/companion-build.log" 2>&1 \
      || fail_with_log 'Companion' "$runtime_root/companion-build.log"
  else
    say 'Companion 已是最新构建。'
  fi

  open "$companion_app"
  wait_for 15 companion_running || fail_with_log 'Companion' "$runtime_root/companion-build.log"
  say 'Companion 已打开（Dock + 菜单栏入口同时保留）。'
}

ensure_obs() {
  local log_file="$runtime_root/obs-launcher.log"
  if obs_running; then
    if obs_virtual_camera_running; then
      say 'OBS 和虚拟摄像头已运行，保持现有进程，不执行重启。'
    else
      say 'OBS 已运行，但无法从最新日志确认虚拟摄像头；为保护当前场景不自动重启，请在 OBS 点“启动虚拟摄像头”。'
    fi
    return
  fi
  if [[ ! -x "$obs_binary" ]]; then
    say "未找到 OBS：$obs_binary"
    exit 1
  fi

  say '配置 InkLoop Interview 场景并启动 OBS 虚拟摄像头…'
  if ! (
    cd "$demo_root"
    npm run launch:obs-interview-camera -- --force-restart
  ) >"$log_file" 2>&1; then
    # OBS 32 may emit the virtual-camera marker exactly on the launcher's
    # timeout boundary. Verify real state before treating that race as failure.
    sleep 10
    if obs_virtual_camera_running; then
      say 'OBS 启动器在边界时刻超时，但实际虚拟摄像头已启动，按真实状态继续。'
      return
    fi
    fail_with_log 'OBS' "$log_file"
  fi
  wait_for 20 obs_running || fail_with_log 'OBS' "$log_file"
  say 'OBS 已运行；已有 OBS 时脚本永远不会结束或重启它。'
}

open_validation_pages() {
  if [[ "${INKLOOP_SKIP_BROWSER_OPEN:-0}" == '1' ]]; then
    say '按 INKLOOP_SKIP_BROWSER_OPEN=1 跳过打开浏览器页面。'
    return
  fi
  open -a 'Google Chrome' "$live_board_url"
  open -a 'Google Chrome' "$meet_url"
  say '已在 Chrome 打开 Live Board 和 Google Meet。'
}

usage() {
  cat <<'EOF'
用法：
  ./start-meeting-validation.sh           启动完整验收环境并打开页面
  ./start-meeting-validation.sh --status  只检查当前状态
  ./start-meeting-validation.sh --status --format=json

可选环境变量：
  INKLOOP_GOOGLE_MEET_URL=<url>  打开指定 Meet；默认创建新会议
  INKLOOP_SKIP_BROWSER_OPEN=1    启动服务但不打开浏览器页面

运行日志位于 .inkloop/meeting-validation/。脚本不会删除会议原始数据，
也不会结束或重启一个已经在运行的 OBS。
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  --status)
    load_existing_tokens
    case "${2:-}" in
      '') show_status; exit $? ;;
      --format=json) show_status_json; exit $? ;;
      *) usage >&2; exit 2 ;;
    esac
    ;;
  '')
    [[ $# -eq 0 ]] || { usage >&2; exit 2; }
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

for required_command in curl npm node open osascript pgrep openssl shasum; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    say "缺少命令：$required_command"
    exit 1
  fi
done

ensure_meeting_media_token
ensure_whisper
ensure_meeting_media
ensure_live_board
ensure_companion
ensure_obs
open_validation_pages

printf '\n'
show_status
printf '\n'
say '环境已准备好，可以开始真实会议。会议结束后告诉我“跑完了”，我会读取最新会话做验收。'
say "日志目录：$runtime_root"
