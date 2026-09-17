#!/bin/sh
# new-api · NAS 部署执行脚本
#
# 运行位置：deploy/compose.deployer.yaml 启动的守望容器内
#           （容器挂载了 docker.sock，因此具备 docker 权限）
# 触发方式：由 watcher.sh 检测到 staging/request.json 后调用
#
# ★ 不接受任何外部参数 —— 消除命令注入面。所有输入来自 staging/request.json
# ★ 永不执行 docker compose down -v
set -eu

BASE=/volume1/docker/new-apiv1
STAGING="$BASE/staging"
OUT="$BASE/deploy/out"
BACKUPS="$BASE/deploy/backups"
COMPOSE_FILE="$BASE/compose.yaml"
ENV_FILE="$BASE/.env"
HEALTH_PORT=3000

mkdir -p "$OUT" "$BACKUPS"
REQ="$STAGING/request.json"
PROC="$STAGING/request.processing"
LOG="$OUT/runner.log"

log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

result() { # ok action tag message
  printf '{"ok":%s,"action":"%s","tag":"%s","at":"%s","message":"%s"}\n' \
    "$1" "$2" "${3:-}" "$(date -Iseconds)" "${4:-}" > "$OUT/result.json"
}

# ---------------------------------------------------------------- 基础查询
service_container() { # $1 = compose 服务名
  docker ps -q --filter "label=com.docker.compose.service=$1" | head -1
}

# 从运行中的容器反查 compose 项目名。
# ★ 必须沿用原项目名，否则 docker compose 会当成新项目、创建重复容器并抢占端口。
project_args() {
  local svc_c proj
  svc_c="$(service_container new-api)" || true
  if [ -n "$svc_c" ]; then
    proj="$(docker inspect "$svc_c" \
      --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
    if [ -n "$proj" ] && [ "$proj" != "<no value>" ]; then
      printf -- '-p %s' "$proj"
    fi
  fi
  return 0      # ★ 总要返回 0：调用处是 $(), set -e 会因非 0 直接退出
}

compose_up_with() { # $1 = 镜像引用
  local image="$1"
  # shellcheck disable=SC2046
  NEWAPI_IMAGE="$image" docker compose --env-file "$ENV_FILE" $(project_args) \
    -f "$COMPOSE_FILE" up -d >> "$LOG" 2>&1
}

# 健康检查：进到 new-api 容器内部查它自己的 3000 端口。
# 不用 curl/wget 的宿主网络路径，避免容器网络差异。
health_ok() {
  local c
  c="$(service_container new-api)" || true
  [ -n "$c" ] || return 1
  docker exec "$c" wget -q -O - "http://127.0.0.1:${HEALTH_PORT}/api/status" 2>/dev/null \
    | grep -q '"success"[[:space:]]*:[[:space:]]*true' || return 1
  return 0
}

# ═══════════════════════════════════════════════════════════════════
[ -f "$REQ" ] || exit 0

if [ "$(stat -c %U "$REQ")" != "hiblacker" ]; then
  log "拒绝：request.json 属主是 $(stat -c %U "$REQ")"
  rm -f "$REQ"; exit 1
fi

mv "$REQ" "$PROC"

read_field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$PROC"; }
ACTION="$(read_field action)"
TAG="$(read_field tag)"

case "$ACTION" in deploy|rollback|backup|recon|prune) ;; *)
  log "拒绝：未知 action=$ACTION"
  result false "$ACTION" "" "unknown action"
  mv -f "$PROC" "$STAGING/request.failed"; exit 1 ;;
esac

log "── 开始 action=$ACTION tag=$TAG ──"

# ─────────────────────────── recon ───────────────────────────
if [ "$ACTION" = recon ]; then
  c="$(service_container new-api)"
  {
    echo "### $(date -Iseconds)"
    echo "## 项目名: $(project_args)"
    echo "## 应用容器: ${c:-none}"
    [ -n "$c" ] && docker inspect "$c" --format 'image={{.Config.Image}} status={{.State.Status}}'
    echo "## new-api 相关镜像"
    docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep -i new-api || true
    echo "## 挂载"
    [ -n "$c" ] && docker inspect "$c" --format '{{json .Mounts}}'
    echo "## 磁盘"
    df -h /volume1 | tail -1
    echo "## 现有备份"
    ls -lh "$BACKUPS" 2>/dev/null | tail -5
  } > "$OUT/recon.txt" 2>&1
  result true recon "" "recon written"
  mv -f "$PROC" "$STAGING/request.done"; exit 0
fi

# ─────────────────────────── backup ───────────────────────────
do_backup() {
  stamp="$(date +%F-%H%M%S)"
  pgc="$(service_container postgres)"
  [ -n "$pgc" ] || { log "找不到 postgres 容器"; return 1; }
  docker exec "$pgc" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    | gzip > "$BACKUPS/pg-${stamp}.sql.gz" || return 1
  # 只保留最近 10 份
  ls -1t "$BACKUPS"/pg-*.sql.gz 2>/dev/null | tail -n +11 | while read -r f; do rm -f "$f"; done
  log "备份完成：pg-${stamp}.sql.gz ($(du -h "$BACKUPS/pg-${stamp}.sql.gz" | cut -f1))"
}

if [ "$ACTION" = backup ]; then
  if do_backup; then result true backup "" "backup ok"
  else result false backup "" "backup failed"; fi
  mv -f "$PROC" "$STAGING/request.done"; exit 0
fi

# ─────────────────────────── prune ───────────────────────────
if [ "$ACTION" = prune ]; then
  # ★ 只用 until 过滤，不用 -a：避免删掉回滚镜像
  docker image prune -f --filter "until=168h"   >> "$LOG" 2>&1 || true
  docker builder prune -f --filter "until=168h" >> "$LOG" 2>&1 || true
  result true prune "" "prune done"
  mv -f "$PROC" "$STAGING/request.done"; exit 0
fi

# ─────────────────────────── rollback ───────────────────────────
if [ "$ACTION" = rollback ]; then
  if ! docker image inspect new-api:rollback >/dev/null 2>&1; then
    result false rollback "" "no rollback image"
    mv -f "$PROC" "$STAGING/request.done"; exit 0
  fi
  compose_up_with new-api:rollback || true
  sleep 10
  if health_ok; then result true rollback new-api:rollback "rolled back"
  else result false rollback new-api:rollback "rollback unhealthy"; fi
  mv -f "$PROC" "$STAGING/request.done"; exit 0
fi

# ─────────────────────────── deploy ───────────────────────────
[ -n "$TAG" ] || { result false deploy "" "tag required"; mv -f "$PROC" "$STAGING/request.done"; exit 0; }

IMG="$STAGING/image.tgz"
if [ ! -f "$IMG" ]; then
  result false deploy "$TAG" "image.tgz missing"
  mv -f "$PROC" "$STAGING/request.done"; exit 0
fi
if [ "$(stat -c %U "$IMG")" != "hiblacker" ]; then
  result false deploy "$TAG" "image.tgz owner invalid"
  mv -f "$PROC" "$STAGING/request.done"; exit 0
fi

# 1) 记录回滚点
CUR="$(docker inspect "$(service_container new-api)" --format '{{.Config.Image}}' 2>/dev/null || true)"
if [ -n "$CUR" ] && [ "$CUR" != "$TAG" ]; then
  docker tag "$CUR" new-api:rollback && log "回滚点：new-api:rollback ← $CUR"
fi

# 2) 部署前必须先备份成功
if ! do_backup; then
  result false deploy "$TAG" "pre-deploy backup failed, aborted"
  mv -f "$PROC" "$STAGING/request.done"; exit 1
fi

# 3) 载入新镜像
if ! docker load < "$IMG" >> "$LOG" 2>&1; then
  result false deploy "$TAG" "docker load failed"
  mv -f "$PROC" "$STAGING/request.done"; exit 1
fi
rm -f "$IMG"

# 4) 重建容器（沿用原项目名；永不 down -v）
if ! compose_up_with "$TAG"; then
  result false deploy "$TAG" "compose up failed"
  mv -f "$PROC" "$STAGING/request.done"; exit 1
fi

# 5) 健康检查，失败自动回滚
sleep 15
if health_ok; then
  log "部署成功：$TAG"
  result true deploy "$TAG" "deployed and healthy"
else
  log "健康检查失败，尝试自动回滚"
  if docker image inspect new-api:rollback >/dev/null 2>&1; then
    compose_up_with new-api:rollback || true
    sleep 10
    if health_ok; then
      result false deploy "$TAG" "unhealthy, auto-rolled back"
    else
      result false deploy "$TAG" "unhealthy AND rollback unhealthy, manual attention needed"
    fi
  else
    result false deploy "$TAG" "unhealthy, no rollback image"
  fi
fi

mv -f "$PROC" "$STAGING/request.done"
