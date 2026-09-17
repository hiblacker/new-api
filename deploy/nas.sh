#!/usr/bin/env bash
#
# new-api · NAS 部署助手（群晖）
#
#   ./deploy/nas.sh check      连通性与配置自检
#   ./deploy/nas.sh init-key   生成专用 SSH 密钥并打印公钥
#   ./deploy/nas.sh recon      抓取容器挂载/环境变量（判断数据库类型与卷路径）
#   ./deploy/nas.sh backup     备份数据库（自动识别 SQLite / PostgreSQL）
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

log()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 配置加载
SSH_OPTS=()
NAS_SSH_USER=""
NAS_HOST=""

load_env() {
  [ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE —— 先执行: cp deploy/nas.env.example deploy/nas.env"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a

  : "${NAS_HOST:?nas.env 缺少 NAS_HOST}"
  : "${NAS_SSH_PORT:=22}"
  : "${NAS_SSH_USER:?nas.env 缺少 NAS_SSH_USER（DSM 登录账号）}"
  : "${NAS_DEPLOY_DIR:?nas.env 缺少 NAS_DEPLOY_DIR}"
  : "${NAS_SERVICE:=new-api}"
  : "${NAS_CONTAINER:=}"
  : "${IMAGE_NAME:?nas.env 缺少 IMAGE_NAME}"
  : "${IMAGE_TAG:?nas.env 缺少 IMAGE_TAG}"
  : "${ROLLBACK_TAG:=$IMAGE_NAME:rollback}"
  : "${NAS_BACKUP_DIR:=$NAS_DEPLOY_DIR/backups}"

  # 群晖的 SSH 默认 PATH 不含 /usr/local/bin，而 docker 就在那里。
  : "${REMOTE_PATH:=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
  # docker.sock 是 root:root 且没有 docker 组，通常需要 sudo -n
  # （需在 NAS 上配置 NOPASSWD 规则，见 CUSTOMIZATION-DEPLOY-PLAN.md）
  : "${NAS_SUDO:=}"
  : "${NAS_COMPOSE_FILE:=compose.yaml}"
  : "${NAS_COMPOSE_PROJECT:=}"
  : "${NAS_ENV_FILE:=.env}"

  # 必须在加载 nas.env 之后再构建，否则端口/密钥会取到默认值。
  SSH_OPTS=(-o ConnectTimeout=8 -o BatchMode=no -o StrictHostKeyChecking=accept-new
            -p "$NAS_SSH_PORT")
  [ -n "${NAS_SSH_KEY:-}" ] && SSH_OPTS+=(-i "${NAS_SSH_KEY/#\~/$HOME}")
}

nas_ssh() { ssh "${SSH_OPTS[@]}" "${NAS_SSH_USER}@${NAS_HOST}" "$@"; }
nas_tty() { ssh -t "${SSH_OPTS[@]}" "${NAS_SSH_USER}@${NAS_HOST}" "$@"; }

# 远端执行 docker（自动补 PATH 与 sudo）
nas_docker() {
  local pre="export PATH='${REMOTE_PATH}':\$PATH;"
  [ -n "${NAS_SUDO:-}" ] && pre="$pre ${NAS_SUDO}"
  nas_ssh "$pre $*"
}

# docker compose（带 --env-file / -f / 可选 -p）
nas_compose() {
  local proj=""
  [ -n "${NAS_COMPOSE_PROJECT:-}" ] && proj="-p ${NAS_COMPOSE_PROJECT}"
  nas_docker "cd '${NAS_DEPLOY_DIR}' && docker compose --env-file '${NAS_ENV_FILE}' $proj -f '${NAS_COMPOSE_FILE}' $*"
}

# docker compose，附带 NEWAPI_IMAGE 变量
nas_compose_with_image() {
  local image="$1"; shift
  local proj=""
  [ -n "${NAS_COMPOSE_PROJECT:-}" ] && proj="-p ${NAS_COMPOSE_PROJECT}"
  nas_docker "cd '${NAS_DEPLOY_DIR}' && NEWAPI_IMAGE='${image}' docker compose --env-file '${NAS_ENV_FILE}' $proj -f '${NAS_COMPOSE_FILE}' $*"
}

# 容器名：compose 未固定 container_name，名字由项目名派生，需要动态解析
nas_resolve_container() {
  if [ -n "${NAS_CONTAINER:-}" ]; then printf '%s' "$NAS_CONTAINER"; return; fi
  local name
  name="$(nas_docker "docker ps --filter 'label=com.docker.compose.service=${NAS_SERVICE}' --format '{{.Names}}'" 2>/dev/null | head -1)"
  if [ -z "$name" ]; then
    name="$(nas_docker "docker ps --format '{{.Names}}'" 2>/dev/null | grep -iE 'new-?api' | grep -v -- '-log' | head -1 || true)"
  fi
  printf '%s' "$name"
}

# ------------------------------------------------------------------- 子命令
cmd_init_key() {
  local key="${NAS_SSH_KEY:-$HOME/.ssh/id_ed25519_newapi_nas}"
  key="${key/#\~/$HOME}"
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  if [ -f "$key" ]; then
    warn "密钥已存在，直接复用：$key"
  else
    ssh-keygen -t ed25519 -N '' -C "new-api-nas-deploy" -f "$key" >/dev/null
    chmod 600 "$key"
    ok "已生成密钥：$key"
  fi
  echo
  echo "把下面这行公钥添加到群晖 DSM："
  echo "  控制面板 → 用户与群组 → 选中你的账号 → 编辑 → 高级 → 用户密钥 → 新增"
  echo
  cat "${key}.pub"
}

cmd_check() {
  [ -f "$ENV_FILE" ] || die "缺少 $ENV_FILE —— 先执行: cp deploy/nas.env.example deploy/nas.env"

  # 先只读主机/端口，这样首次运行时能先说明「SSH 没开」，而不是卡在账号没填。
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
    die "SSH 端口不可达。请在群晖 DSM 开启：
    控制面板 → 终端机和 SNMP → 勾选「启动 SSH 功能」→ 应用
    若已改端口，请把实际端口填入 nas.env 的 NAS_SSH_PORT"
  fi

  load_env
  log "配置摘要：${NAS_SSH_USER}@${NAS_HOST}:${NAS_SSH_PORT} → ${NAS_DEPLOY_DIR}"

  log "测试 SSH 登录…"
  if nas_ssh "echo ok" >/dev/null 2>&1; then
    ok "SSH 登录成功"
  else
    die "SSH 登录失败：确认 nas.env 的 NAS_SSH_USER / NAS_SSH_KEY，且公钥已加入 DSM 用户密钥"
  fi

  log "检查部署目录与容器…"
  nas_ssh "[ -f '${NAS_DEPLOY_DIR}/${NAS_COMPOSE_FILE}' ] && echo 'compose: 存在 (${NAS_COMPOSE_FILE})' || echo 'compose: 缺失'"

  local cname
  cname="$(nas_resolve_container)"
  if [ -n "$cname" ]; then
    ok "容器：$cname"
    nas_docker "docker inspect '$cname' --format '  镜像: {{.Config.Image}}  状态: {{.State.Status}}'"
  else
    warn "未列出容器 —— 通常是 docker 权限不足（docker.sock 属 root:root）"
    warn "请在 NAS 配置 NOPASSWD 后在 nas.env 设 NAS_SUDO='sudo -n'（见方案文档）"
  fi

  if [ -n "${NAS_API_URL:-}" ]; then
    log "检查服务可访问性…"
    if curl -fsS -m 8 "${NAS_API_URL}/api/status" >/dev/null 2>&1; then
      ok "${NAS_API_URL} 响应正常"
    else
      warn "${NAS_API_URL} 无响应"
    fi
  fi
  ok "自检完成"
}

cmd_recon() {
  load_env
  local cname; cname="$(nas_resolve_container)"
  [ -n "$cname" ] || die "找不到运行中的容器，请先解决 docker 权限（NAS_SUDO）"

  log "抓取容器挂载与数据库配置（容器：$cname）…"
  {
    echo "### 采集时间: $(date -Iseconds)"
    echo "### 容器: $cname"
    echo
    echo "## 挂载（数据卷在哪 —— 备份的关键）"
    nas_docker "docker inspect '$cname' --format '{{json .Mounts}}'"
    echo
    echo "## 数据库相关环境变量"
    nas_docker "docker inspect '$cname' --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -Ei 'SQL_DSN|REDIS|NODE_NAME' || true"
    echo
    echo "## 同项目其它容器"
    nas_docker "docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -iE 'new-?api|postgres|mysql|redis|clickhouse' || true"
    echo
    echo "## compose 文件里的 image 行"
    nas_ssh "grep -nE '^[[:space:]]*image:' '${NAS_DEPLOY_DIR}/${NAS_COMPOSE_FILE}' || true"
    echo
    echo "## 数据目录大小"
    nas_ssh "du -sh '${NAS_DEPLOY_DIR}'/postgres '${NAS_DEPLOY_DIR}'/data '${NAS_DEPLOY_DIR}'/redis 2>/dev/null || true"
  } | tee "$RECON_FILE"

  ok "已保存到 $RECON_FILE"
}

cmd_backup() {
  load_env
  local stamp; stamp="$(date +%F-%H%M%S)"
  local cname; cname="$(nas_resolve_container)"
  [ -n "$cname" ] || die "找不到运行中的容器"

  log "在 NAS 上备份数据库…"
  nas_ssh "mkdir -p '${NAS_BACKUP_DIR}'"

  local dsn
  dsn="$(nas_docker "docker inspect '$cname' --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^SQL_DSN=//p'")"

  if [ -z "$dsn" ]; then
    local data_dir
    data_dir="$(nas_docker "docker inspect '$cname' --format '{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Source}}{{end}}{{end}}'")"
    [ -n "$data_dir" ] || die "找不到挂载到 /data 的目录，请先跑 recon 人工确认"
    log "SQLite 模式，数据目录：$data_dir"
    nas_ssh "tar czf '${NAS_BACKUP_DIR}/sqlite-${stamp}.tgz' -C '$(dirname "$data_dir")' '$(basename "$data_dir")'"
  elif [[ "$dsn" == postgres* ]]; then
    # 在 postgres 容器内备份：不依赖应用镜像里是否有 pg_dump
    log "PostgreSQL 模式：docker exec + pg_dump"
    local pgc
    pgc="$(nas_docker "docker ps --filter 'label=com.docker.compose.service=postgres' --format '{{.Names}}'" | head -1)"
    [ -n "$pgc" ] || die "找不到 postgres 容器"
    nas_docker "docker exec '$pgc' sh -lc 'pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' | gzip" \
      > "${NAS_BACKUP_DIR}/pg-${stamp}.sql.gz"
    ok "已备份到 ${NAS_BACKUP_DIR}/pg-${stamp}.sql.gz"
  else
    die "识别到 MySQL，需人工确认 mysql 容器名后执行：
    docker exec <mysql容器> mysqldump -uroot -p'<密码>' --single-transaction <库名> | gzip > ${NAS_BACKUP_DIR}/mysql-${stamp}.sql.gz"
  fi

  nas_ssh "ls -lh '${NAS_BACKUP_DIR}' | tail -5"
  ok "备份完成"
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
  log "导出镜像并压缩（几分钟）…"
  docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip > "$tmp/image.tgz"
  ls -lh "$tmp/image.tgz"

  log "传输到 NAS…"
  local scp_opts=(-o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -P "$NAS_SSH_PORT")
  [ -n "${NAS_SSH_KEY:-}" ] && scp_opts+=(-i "${NAS_SSH_KEY/#\~/$HOME}")
  scp "${scp_opts[@]}" "$tmp/image.tgz" "${NAS_SSH_USER}@${NAS_HOST}:/tmp/newapi-image.tgz"

  log "在 NAS 上载入镜像…"
  nas_docker "gunzip -c /tmp/newapi-image.tgz | docker load && rm -f /tmp/newapi-image.tgz"
  rm -rf "$tmp"
  nas_docker "docker images '${IMAGE_NAME}' --format '{{.Repository}}:{{.Tag}}  {{.Size}}'"
  ok "镜像已就绪"
}

cmd_deploy() {
  load_env
  log "部署前检查…"
  if ! nas_ssh "grep -qE '\\\$\{?NEWAPI_IMAGE' '${NAS_DEPLOY_DIR}/${NAS_COMPOSE_FILE}'"; then
    die "compose 里的 image 没有使用 \${NEWAPI_IMAGE} 变量，无法安全切换版本。
    请把 ${NAS_DEPLOY_DIR}/${NAS_COMPOSE_FILE} 中的
      image: <任意旧值>
    改为
      image: \${NEWAPI_IMAGE:-calciumion/new-api:v1.0.0-rc.36}
    然后重新执行 deploy。"
  fi

  nas_docker "docker image inspect '${IMAGE_NAME}:${IMAGE_TAG}' >/dev/null 2>&1" \
    || die "NAS 上找不到镜像 ${IMAGE_NAME}:${IMAGE_TAG}，先执行 ./deploy/nas.sh transfer"

  local cname; cname="$(nas_resolve_container)"
  if [ -n "$cname" ]; then
    log "记录当前镜像用于回滚…"
    local current
    current="$(nas_docker "docker inspect '$cname' --format '{{.Config.Image}}'")"
    if nas_docker "docker tag '$current' '${ROLLBACK_TAG}'"; then
      ok "回滚 tag 已更新：${ROLLBACK_TAG} ← ${current}"
    fi
  fi

  log "重建容器（只 up -d，绝不动数据卷）…"
  nas_compose_with_image "${IMAGE_NAME}:${IMAGE_TAG}" up -d

  log "等待启动…"
  sleep 8
  cname="$(nas_resolve_container)"
  if [ -n "$cname" ]; then
    nas_docker "docker ps --filter 'name=$cname' --format '{{.Names}}  {{.Image}}  {{.Status}}'"
  fi

  if [ -n "${NAS_API_URL:-}" ]; then
    log "自检 ${NAS_API_URL}/api/status …"
    curl -fsS -m 10 "${NAS_API_URL}/api/status" | head -c 200; echo
  fi
  ok "部署完成。请按 CUSTOMIZATIONS.md 的自检清单核对功能。"
}

cmd_rollback() {
  load_env
  log "回滚到 ${ROLLBACK_TAG} …"
  nas_docker "docker image inspect '${ROLLBACK_TAG}' >/dev/null 2>&1" || die "找不到回滚镜像 ${ROLLBACK_TAG}"
  nas_compose_with_image "${ROLLBACK_TAG}" up -d
  sleep 6
  local cname; cname="$(nas_resolve_container)"
  if [ -n "$cname" ]; then
    nas_docker "docker ps --filter 'name=$cname' --format '{{.Names}}  {{.Image}}  {{.Status}}'"
  fi
  ok "回滚完成（零 schema 变更，无需恢复数据库）"
}

cmd_logs() {
  load_env
  local cname; cname="$(nas_resolve_container)"
  [ -n "$cname" ] || die "找不到运行中的容器"
  nas_tty "export PATH='${REMOTE_PATH}':\$PATH; ${NAS_SUDO:+$NAS_SUDO }docker logs -f --tail=100 '$cname'"
}

usage() { sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

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
