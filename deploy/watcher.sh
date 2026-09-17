#!/bin/sh
# new-api · NAS 部署守望进程（在容器内运行）
#
# 作用：替代 cron。容器常驻，循环检查 staging 是否有部署请求，
#       有则调用 runner.sh 执行（容器挂载了 docker.sock，因此有权限）。
#
# 为什么不用 cron：
#   - 不写 /etc/cron.d（DSM 更新可能重置 /etc）
#   - 由 Container Manager 管理，restart: unless-stopped 自动拉起
#   - 启停/查看日志都在 DSM 界面里，不需要 SSH root
#
# 该脚本由 deploy/compose.deployer.yaml 启动。
set -eu

BASE=/volume1/docker/new-apiv1
STAGING="$BASE/staging"
OUT="$BASE/deploy/out"
LOG="$OUT/watcher.log"
INTERVAL=5

mkdir -p "$OUT" "$STAGING"

log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

log "watcher 启动：docker=$(docker --version 2>/dev/null | cut -d, -f1) compose=$(docker compose version 2>/dev/null | head -1)"

while true; do
  if [ -f "$STAGING/request.json" ]; then
    if [ -x "$BASE/deploy/runner.sh" ]; then
      log "发现请求，调用 runner.sh"
      if "$BASE/deploy/runner.sh"; then
        log "runner.sh 成功"
      else
        log "runner.sh 退出码 $?（细节见同目录日志）"
      fi
    else
      log "错误：$BASE/deploy/runner.sh 不存在或不可执行（chmod 755）"
      rm -f "$STAGING/request.json"
    fi
  fi
  sleep "$INTERVAL"
done
