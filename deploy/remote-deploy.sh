#!/bin/sh
# new-api · NAS 侧特权部署脚本
#
# 在 NAS 上以 root 运行。正常情况下你不需要手敲它 ——
# 本地 `./deploy/nas.sh deploy` 会通过**一次** `ssh -t` 调用本脚本，
# 你只需要在弹出的 sudo 提示里输一次密码。
#
# 手动用法（在 NAS 上）：
#   sudo /volume1/docker/new-apiv1/deploy/remote-deploy.sh deploy new-api:v1.0.0-rc.36-custom.1
#   sudo .../remote-deploy.sh rollback
#   sudo .../remote-deploy.sh backup
#   sudo .../remote-deploy.sh recon
#   sudo .../remote-deploy.sh logs
#   sudo .../remote-deploy.sh prune
#
# 目录一律从脚本自身位置推导（脚本放在 <部署目录>/deploy/ 下），
# 因此不存在「本地配置与远端脚本路径不同步」的问题。
#
# ★ 永不执行 `docker compose down -v`（数据卷是红线）。
set -eu

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"   # <部署目录>/deploy
BASE="$(dirname "$SELF_DIR")"               # <部署目录>
COMPOSE_FILE="$BASE/compose.yaml"
ENV_FILE="$BASE/.env"
IMAGE_FILE="$SELF_DIR/image.tgz"
BACKUPS="$SELF_DIR/backups"
LOG="$SELF_DIR/remote-deploy.log"

SERVICE=new-api
ROLLBACK_IMAGE="new-api:rollback"
HEALTH_PORT=3000
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/api/status"

# 群晖的 PATH 不含 /usr/local/bin，而 docker 在那里
PATH="/usr/local/bin:$PATH"
export PATH

say() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }
die() { say "✗ $*"; exit 1; }

# ------------------------------------------------------------- 前置检查
# 注意：这里刻意不用 say()，否则在非 root 误跑时会在当前目录留下日志文件。
if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' "✗ 需要 root：本脚本要访问 docker.sock，请用 sudo 运行" >&2
  exit 1
fi
command -v docker >/dev/null 2>&1 || die "找不到 docker"
[ -f "$COMPOSE_FILE" ] || die "找不到 compose 文件：$COMPOSE_FILE"
[ -f "$ENV_FILE" ] || die "找不到 env 文件：$ENV_FILE"
mkdir -p "$BACKUPS"

# --------------------------------------------------------------- 基础查询
service_container() { # $1 = compose 服务名
  docker ps -q --filter "label=com.docker.compose.service=$1" | head -1
}

# 从运行中的容器反查 compose 项目名。
# ★ 必须沿用原项目名，否则 docker compose 会当成新项目、创建重复容器并抢占端口。
compose_args() {
  svc_c="$(service_container "$SERVICE")" || true
  if [ -n "$svc_c" ]; then
    proj="$(docker inspect "$svc_c" \
      --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
    case "$proj" in
      ''|'<no value>') ;;
      *) printf -- '-p %s' "$proj" ;;
    esac
  fi
  return 0
}

compose_up_with() { # $1 = 镜像引用
  image="$1"
  # 捕获输出后再回显，保证失败时能拿到 compose 自己的退出码
  # （POSIX sh 没有 pipefail，直接 `| tee` 会吞掉错误码）
  out="$( ( cd "$BASE" && NEWAPI_IMAGE="$image" docker compose --env-file "$ENV_FILE" \
    $(compose_args) -f "$COMPOSE_FILE" up -d ) 2>&1 )" && rc=0 || rc=$?
  printf '%s\n' "$out" | tee -a "$LOG"
  return "$rc"
}

# 健康检查：优先直接问应用自己的状态接口（快），
# 失败再采用 compose 里定义好的 healthcheck 结论（兜底）。
health_ok() {
  c="$(service_container "$SERVICE")" || true
  [ -n "$c" ] || return 1

  if docker exec "$c" wget -q -O - "$HEALTH_URL" 2>/dev/null \
       | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
    return 0
  fi

  [ "$(docker inspect "$c" \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null)" = "healthy" ]
}

# up -d 之后容器通常几秒内就能响应；给它最多 ~2 分钟
wait_healthy() {
  n=0
  while [ "$n" -lt 40 ]; do
    if health_ok; then return 0; fi
    n=$((n + 1))
    sleep 3
  done
  return 1
}

# ----------------------------------------------------------------- 备份
do_backup() {
  stamp="$(date +%F-%H%M%S)"
  pgc="$(service_container postgres)" || true
  if [ -z "$pgc" ]; then
    say "找不到 postgres 容器，无法备份"
    return 1
  fi

  # 先落成明文，才能分辨「pg_dump 真的失败」与「只是管道退出码」的差别
  tmp="$BACKUPS/pg-${stamp}.sql"
  if ! docker exec "$pgc" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
       > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    say "✗ pg_dump 执行失败"
    return 1
  fi
  if [ ! -s "$tmp" ] || ! head -5 "$tmp" | grep -q 'PostgreSQL database dump'; then
    rm -f "$tmp"
    say "✗ 备份内容不合法（空文件或非 pg_dump 输出）"
    return 1
  fi
  gzip -c "$tmp" > "${tmp}.gz" && rm -f "$tmp"

  # 只保留最近 10 份
  ls -1t "$BACKUPS"/pg-*.sql.gz 2>/dev/null | tail -n +11 | while read -r f; do rm -f "$f"; done
  say "备份完成：${tmp}.gz（$(du -h "${tmp}.gz" | cut -f1)）"
}

# ----------------------------------------------------------------- 分派
ACTION="${1:-}"
TAG="${2:-}"

case "$ACTION" in
  deploy|rollback|backup|recon|logs|prune) ;;
  '') die "用法：$0 {deploy <image:tag>|rollback|backup|recon|logs|prune}" ;;
  *) die "未知动作：$ACTION" ;;
esac

say "── action=$ACTION${TAG:+ tag=$TAG} ──"

# ─────────────────────────── recon ───────────────────────────
if [ "$ACTION" = recon ]; then
  c="$(service_container "$SERVICE")" || true
  echo "## 项目参数: $(compose_args)"
  echo "## 应用容器: ${c:-none}"
  [ -n "$c" ] && docker inspect "$c" --format 'image={{.Config.Image}} status={{.State.Status}}'
  echo "## new-api 相关镜像"
  docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep -i new-api || true
  echo "## 挂载"
  [ -n "$c" ] && docker inspect "$c" --format '{{json .Mounts}}'
  echo "## 磁盘"
  df -h "$BASE" | tail -1
  echo "## 现有备份"
  ls -lh "$BACKUPS" 2>/dev/null | tail -5
  exit 0
fi

# ─────────────────────────── backup ───────────────────────────
if [ "$ACTION" = backup ]; then
  do_backup || die "备份失败"
  exit 0
fi

# ─────────────────────────── prune ───────────────────────────
if [ "$ACTION" = prune ]; then
  # ★ 只用 until 过滤、不用 -a：避免删掉 rollback 与历史版本镜像
  docker image prune -f --filter "until=168h"   >> "$LOG" 2>&1 || true
  docker builder prune -f --filter "until=168h" >> "$LOG" 2>&1 || true
  say "已清理 168h 以上的悬空镜像与构建缓存（rollback/版本镜像已保留）"
  exit 0
fi

# ─────────────────────────── logs ───────────────────────────
if [ "$ACTION" = logs ]; then
  c="$(service_container "$SERVICE")" || true
  [ -n "$c" ] || die "找不到 $SERVICE 容器"
  docker logs --tail 200 "$c" 2>&1 | tee -a "$LOG"
  exit 0
fi

# ─────────────────────────── rollback ───────────────────────────
if [ "$ACTION" = rollback ]; then
  if ! docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
    die "没有回滚镜像 $ROLLBACK_IMAGE（每个成功的部署都会自动打上它）"
  fi
  say "切换到回滚镜像 $ROLLBACK_IMAGE …"
  compose_up_with "$ROLLBACK_IMAGE" || die "compose up 失败"
  if wait_healthy; then
    say "✓ 回滚完成且服务健康"
  else
    die "回滚后服务仍不健康，请查看：$0 logs"
  fi
  exit 0
fi

# ─────────────────────────── deploy ───────────────────────────
[ -n "$TAG" ] || die "deploy 需要镜像 tag：$0 deploy new-api:<tag>"
case "$TAG" in
  *[!A-Za-z0-9._:/-]*) die "tag 含非法字符：$TAG" ;;
esac

# NAS 上已有该 tag 就不必依赖投递文件（例如重复部署同一版本）
if ! docker image inspect "$TAG" >/dev/null 2>&1; then
  [ -s "$IMAGE_FILE" ] || die "NAS 上没有镜像 $TAG，且 $IMAGE_FILE 缺失或为空（本地 nas.sh 会先投递它）"
fi

# 1) 记录回滚点。这一步失败就不该继续 —— 「失败自动回滚」是本脚本的核心保证，
#    没有正确的回滚点就不能悄悄往下走。
CUR="$(docker inspect "$(service_container "$SERVICE")" --format '{{.Config.Image}}' 2>/dev/null || true)"
if [ -n "$CUR" ] && [ "$CUR" != "$TAG" ]; then
  docker tag "$CUR" "$ROLLBACK_IMAGE" \
    || die "无法把当前镜像 $CUR 标记为 $ROLLBACK_IMAGE，已中止（没有可靠回滚点）"
  say "回滚点：$ROLLBACK_IMAGE ← $CUR"
fi

# 2) 部署前必须先备份成功，否则中止
say "部署前备份…"
do_backup || die "部署前备份失败，已中止（数据未做任何改动）"

# 3) 载入新镜像
if [ -s "$IMAGE_FILE" ]; then
  say "载入镜像 $TAG …"
  if ! docker load < "$IMAGE_FILE" >> "$LOG" 2>&1; then
    die "docker load 失败，已中止"
  fi
  rm -f "$IMAGE_FILE"
else
  say "NAS 上已存在 $TAG，跳过 load"
fi
docker image inspect "$TAG" >/dev/null 2>&1 || die "找不到镜像 $TAG，已中止"

# 4) 重建容器（沿用原项目名；永不 down -v）
say "重建 $SERVICE 容器…"
compose_up_with "$TAG" || die "compose up 失败，已中止（容器可能仍是旧版本，可执行 rollback）"

# 5) 健康检查，失败自动回滚
say "等待服务就绪…"
if wait_healthy; then
  say "✓ 部署成功：$TAG"
  exit 0
fi

say "✗ 健康检查失败，自动回滚到 $ROLLBACK_IMAGE"
if docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
  compose_up_with "$ROLLBACK_IMAGE" || true
  if wait_healthy; then
    die "新版本不健康，已自动回滚（服务当前运行 $ROLLBACK_IMAGE）"
  fi
  die "新版本不健康，且回滚后仍不健康 —— 需要人工介入（$0 logs）"
fi
die "新版本不健康，且没有可用回滚镜像 —— 需要人工介入（$0 logs）"
