#!/usr/bin/env bash
#
# new-api · NAS 部署助手
#
#   ./deploy/nas.sh check      连通性与配置自检
#   ./deploy/nas.sh init-key   生成专用 SSH 密钥并打印公钥
#   ./deploy/nas.sh recon      抓取容器挂载/环境变量（判断数据库类型与卷路径）
#   ./deploy/nas.sh backup     备份数据库（自动识别 SQLite / MySQL / PostgreSQL）
#   ./deploy/nas.sh build      本地构建镜像
#   ./deploy/nas.sh transfer   把镜像传到 NAS 并载入
#   ./deploy/nas.sh deploy     切换镜像并重建容器（保留数据卷）
#   ./deploy/nas.sh rollback   回滚到上一个镜像
#   ./deploy/nas.sh logs       跟踪容器日志
#
# 安全约定：本脚本永远不会执行 `docker compose down -v`。
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/deploy/nas.env"
RECON_FILE="$ROOT_DIR/deploy/.recon.txt"
KEY_PATH="$HOME/.ssh/id_ed25519_newapi_nas"

log()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

load_env() {
  [ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE —— 先执行: cp deploy/nas.env.example deploy/nas.env"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a

  : "${NAS_HOST:?nas.env 缺少 NAS_HOST}"
  : "${NAS_SSH_PORT:=22}"
  : "${NAS_CONTAINER:?nas.env 缺少 NAS_CONTAINER}"
  : "${NAS_SERVICE:=$NAS_CONTAINER}"
  : "${NAS_DEPLOY_DIR:?nas.env 缺少 NAS_DEPLOY_DIR}"
  : "${IMAGE_NAME:?nas.env 缺少 IMAGE_NAME}"
  : "${IMAGE_TAG:?nas.env 缺少 IMAGE_TAG}"
  : "${ROLLBACK_TAG:=$IMAGE_NAME:rollback}"
  : "${NAS_BACKUP_DIR:=$NAS_DEPLOY_DIR/backups}"
  [ -n "${NAS_SSH_USER:-}" ] || die "nas.env 缺少 NAS_SSH_USER（DSM 登录账号）"
}

SSH_OPTS=(-o ConnectTimeout=8 -o BatchMode=no -p "${NAS_SSH_PORT:-22}")
[ -n "${NAS_SSH_KEY:-}" ] && SSH_OPTS+=(-i "${NAS_SSH_KEY/#\~/$HOME}")

nas_ssh() { ssh "${SSH_OPTS[@]}" "${NAS_SSH_USER}@${NAS_HOST}" "$@"; }
nas_tty() { ssh -t "${SSH_OPTS[@]}" "${NAS_SSH_USER}@${NAS_HOST}" "$@"; }

cmd_check() {
  [ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE —— 先执行: cp deploy/nas.env.example deploy/nas.env"

  # 先只读主机/端口，这样首次运行时能先告诉我们「SSH 没开」，
  # 而不是卡在「账号还没填」。
  local host port
  host="$(sed -n 's/^NAS_HOST=//p' "$ENV_FILE" | head -1)"
  port="$(sed -n 's/^NAS_SSH_PORT=//p' "$ENV_FILE" | head -1)"
  : "${port:=22}"

  log "探测主机 ${host} …"
  if ping -c1 -W2 "$host" >/dev/null 2>&1; then ok "ping 通"
  else warn "ping 不通（可能被防火墙拦截，继续测试端口）"; fi

  log "探测 SSH 端口 ${host}:${port} …"
  if timeout 5 bash -c "cat < /dev/null > /dev/tcp/${host}/${port}" 2>/dev/null; then
    ok "SSH 端口开放"
  else
    die "SSH 端口不可达。请在群晖 DSM 依次操作：
    1) 控制面板 → 终端机和 SNMP → 勾选「启动 SSH 功能」→ 应用
    2) 然后重跑 ./deploy/nas.sh check"
  fi

  load_env
  log "配置摘要：${NAS_SSH_USER}@${NAS_HOST}:${NAS_SSH_PORT} → ${NAS_DEPLOY_DIR}"

  log "测试 SSH 登录…"
  if nas_ssh "echo ok" >/dev/null 2>&1; then
    ok "SSH 登录成功"
    nas_ssh "docker --version; docker compose version 2>/dev/null | head -1"
  else
    die "SSH 登录失败。请确认：
    - nas.env 的 NAS_SSH_USER 是 DSM 登录账号
    - 公钥已加入 DSM：控制面板 → 用户与群组 → 你的账号 → 高级 → 用户密钥，或
      已把公钥写入 NAS 的 ~/.ssh/authorized_keys
    - 若用密码登录，先执行 ./deploy/nas.sh init-key 生成密钥"
  fi

  log "检查部署目录…"
  nas_ssh "[ -f '${NAS_DEPLOY_DIR}/docker-compose.yml' ] && echo 'compose: 存在' || echo 'compose: 缺失'"
  nas_ssh "docker inspect '${NAS_CONTAINER}' --format '容器: {{.Name}} | 镜像: {{.Config.Image}} | 状态: {{.State.Status}}' 2>/dev/null || echo '容器 ${NAS_CONTAINER} 不存在'"

  if [ -n "${NAS_API_URL:-}" ]; then
    log "检查服务可访问性…"
    curl -fsS -m 8 "${NAS_API_URL}/api/status" >/dev/null 2>&1 \
      && ok "${NAS_API_URL} 响应正常" || warn "${NAS_API_URL} 无响应"
  fi
  ok "自检完成"
}

cmd_init_key() {
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  if [ -f "$KEY_PATH" ]; then
    warn "密钥已存在，直接复用：$KEY_PATH"
  else
    ssh-keygen -t ed25519 -N '' -C "new-api-nas-deploy" -f "$KEY_PATH" >/dev/null
    chmod 600 "$KEY_PATH"
    ok "已生成密钥：$KEY_PATH"
  fi
  echo
  echo "把下面这行公钥添加到群晖 DSM："
  echo "  控制面板 → 终端机和 SNMP → 启动 SSH 功能"
  echo "  控制面板 → 用户与群组 → 选中你的账号 → 编辑 → 高级 → 用户密钥 → 新增"
  echo
  cat "${KEY_PATH}.pub"
  echo
}

cmd_recon() {
  load_env
  log "抓取容器挂载与数据库配置…"

  {
    echo "### 采集时间: $(date -Iseconds)"
    echo
    echo "## 容器"
    nas_ssh "docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -iE 'new-api|newapi|mysql|postgres|redis|clickhouse' || true"
    echo
    echo "## 挂载（数据卷在哪 —— 备份的关键）"
    nas_ssh "docker inspect '${NAS_CONTAINER}' --format '{{json .Mounts}}'"
    echo
    echo "## 数据库相关环境变量"
    nas_ssh "docker inspect '${NAS_CONTAINER}' --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -Ei 'dsn|sql|redis|data|log' || true"
    echo
    echo "## compose 文件位置"
    nas_ssh "docker inspect '${NAS_CONTAINER}' --format '{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}'"
    echo
    echo "## compose 中的 image 行（部署时需要一个可被覆盖的变量）"
    nas_ssh "grep -nE '^\s*image:' '${NAS_DEPLOY_DIR}/docker-compose.yml' || true"
  } | tee "$RECON_FILE"

  ok "已保存到 $RECON_FILE"
  echo
  log "判读要点："
  echo "  · 若看到 SQL_DSN=postgresql://…  → PostgreSQL"
  echo "  · 若看到 SQL_DSN=…mysql…          → MySQL"
  echo "  · 若没有 SQL_DSN                  → SQLite（数据在挂载到 /data 的目录里）"
}

cmd_backup() {
  load_env
  local stamp; stamp="$(date +%F-%H%M%S)"
  log "在 NAS 上备份数据库…"
  nas_ssh "mkdir -p '${NAS_BACKUP_DIR}'"

  local dsn
  dsn="$(nas_ssh "docker inspect '${NAS_CONTAINER}' --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^SQL_DSN=//p'" || true)"

  if [ -z "$dsn" ]; then
    # ---- SQLite：直接把数据目录打包 ----
    local data_dir
    data_dir="$(nas_ssh "docker inspect '${NAS_CONTAINER}' --format '{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Source}}{{end}}{{end}}'")"
    [ -n "$data_dir" ] || die "找不到挂载到 /data 的目录，请先跑 recon 人工确认"
    log "SQLite 模式，数据目录：$data_dir"
    nas_ssh "tar czf '${NAS_BACKUP_DIR}/sqlite-${stamp}.tgz' -C '$(dirname "$data_dir")' '$(basename "$data_dir")'"
    nas_ssh "ls -lh '${NAS_BACKUP_DIR}/sqlite-${stamp}.tgz'"
  elif [[ "$dsn" == postgres* ]]; then
    log "PostgreSQL 模式"
    nas_ssh "docker exec '${NAS_CONTAINER}' sh -lc 'command -v pg_dump >/dev/null || exit 3'" 2>/dev/null \
      || die "new-api 容器内没有 pg_dump，请在 postgres 容器内执行备份（见 recon 结果）"
    nas_ssh "docker exec '${NAS_CONTAINER}' sh -lc 'pg_dump \"${dsn}\" | gzip' > '${NAS_BACKUP_DIR}/pg-${stamp}.sql.gz'"
    ok "已备份到 ${NAS_BACKUP_DIR}/pg-${stamp}.sql.gz"
  else
    log "MySQL 模式"
    nas_ssh "docker exec '${NAS_CONTAINER}' sh -lc 'command -v mysqldump >/dev/null || exit 3'" 2>/dev/null \
      || die "new-api 容器内没有 mysqldump，请在 mysql 容器内执行备份（见 recon 结果）"
    die "MySQL 备份需按 recon 结果指定 mysql 容器，请人工确认后执行：
    docker exec <mysql容器> mysqldump -uroot -p'<密码>' --single-transaction <库名> | gzip > ${NAS_BACKUP_DIR}/mysql-${stamp}.sql.gz"
  fi

  ok "备份完成：${NAS_BACKUP_DIR}"
}

cmd_build() {
  load_env
  log "本地构建 ${IMAGE_NAME}:${IMAGE_TAG} …"
  ( cd "$ROOT_DIR" && DOCKER_CONFIG="${DOCKER_CONFIG:-$ROOT_DIR/.docker-build-config}" \
      docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" . )
  ok "构建完成"
}

cmd_transfer() {
  load_env
  local tmp; tmp="$(mktemp -d)"
  log "导出镜像并压缩（可能需要几分钟）…"
  docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip > "$tmp/image.tgz"
  ls -lh "$tmp/image.tgz"

  log "传输到 NAS…"
  scp "${SSH_OPTS[@]/-p/-P}" "$tmp/image.tgz" "${NAS_SSH_USER}@${NAS_HOST}:/tmp/newapi-image.tgz"

  log "在 NAS 上载入镜像…"
  nas_ssh "gunzip -c /tmp/newapi-image.tgz | docker load && rm -f /tmp/newapi-image.tgz"
  rm -rf "$tmp"
  nas_ssh "docker images '${IMAGE_NAME}' --format '{{.Repository}}:{{.Tag}}  {{.Size}}'"
  ok "镜像已就绪"
}

cmd_deploy() {
  load_env
  log "部署前检查…"
  nas_ssh "grep -qE '\\\$\{?NEWAPI_IMAGE' '${NAS_DEPLOY_DIR}/docker-compose.yml'" \
    || die "compose 里的 image 没有使用 \${NEWAPI_IMAGE} 变量，无法安全切换版本。
    请把 ${NAS_DEPLOY_DIR}/docker-compose.yml 中的
      image: <任意旧值>
    改为
      image: \${NEWAPI_IMAGE:-calciumion/new-api:latest}
    然后重新执行 deploy。"

  nas_ssh "docker image inspect '${IMAGE_NAME}:${IMAGE_TAG}' >/dev/null 2>&1" \
    || die "NAS 上找不到镜像 ${IMAGE_NAME}:${IMAGE_TAG}，先执行 ./deploy/nas.sh transfer"

  log "记录当前镜像用于回滚…"
  local current
  current="$(nas_ssh "docker inspect '${NAS_CONTAINER}' --format '{{.Config.Image}}'" || true)"
  if [ -n "$current" ]; then
    nas_ssh "docker tag '$current' '${ROLLBACK_TAG}'" && ok "回滚 tag 已更新：${ROLLBACK_TAG} ← ${current}"
  fi

  log "重建容器（只 up -d，绝不动数据卷）…"
  nas_ssh "cd '${NAS_DEPLOY_DIR}' && NEWAPI_IMAGE='${IMAGE_NAME}:${IMAGE_TAG}' docker compose up -d"

  log "等待启动…"
  sleep 8
  nas_ssh "docker ps --filter 'name=${NAS_CONTAINER}' --format '{{.Names}}  {{.Image}}  {{.Status}}'"
  nas_ssh "docker inspect '${NAS_CONTAINER}' --format '{{.Config.Image}}'"

  if [ -n "${NAS_API_URL:-}" ]; then
    log "自检 ${NAS_API_URL}/api/status …"
    curl -fsS -m 10 "${NAS_API_URL}/api/status" | head -c 200; echo
  fi
  ok "部署完成。请按 CUSTOMIZATIONS.md 的自检清单核对功能。"
}

cmd_rollback() {
  load_env
  log "回滚到 ${ROLLBACK_TAG} …"
  nas_ssh "docker image inspect '${ROLLBACK_TAG}' >/dev/null 2>&1" || die "找不到回滚镜像 ${ROLLBACK_TAG}"
  nas_ssh "cd '${NAS_DEPLOY_DIR}' && NEWAPI_IMAGE='${ROLLBACK_TAG}' docker compose up -d"
  sleep 6
  nas_ssh "docker ps --filter 'name=${NAS_CONTAINER}' --format '{{.Names}}  {{.Image}}  {{.Status}}'"
  ok "回滚完成（零 schema 变更，无需恢复数据库）"
}

cmd_logs() {
  load_env
  nas_tty "docker logs -f --tail=100 '${NAS_CONTAINER}'"
}

usage() {
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  check)    cmd_check ;;
  init-key) cmd_init_key ;;
  recon)    cmd_recon ;;
  backup)   cmd_backup ;;
  build)    cmd_build ;;
  transfer) cmd_transfer ;;
  deploy)   cmd_deploy ;;
  rollback) cmd_rollback ;;
  logs)     cmd_logs ;;
  ''|-h|--help|help) usage ;;
  *) die "未知子命令：$1（执行 ./deploy/nas.sh help 查看用法）" ;;
esac
