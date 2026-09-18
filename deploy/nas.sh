#!/usr/bin/env bash
#
# new-api · NAS 一键部署（群晖）
#
#   ./deploy/nas.sh check        自检：本机 docker、SSH、远端前提、服务状态
#   ./deploy/nas.sh init-key     生成专用 SSH 密钥并打印公钥
#   ./deploy/nas.sh deploy       一键部署：构建 → 投递 → 提权上线（含健康检查与自动回滚）
#   ./deploy/nas.sh rollback     回滚到上一个成功部署的镜像
#   ./deploy/nas.sh backup       在 NAS 上备份数据库
#   ./deploy/nas.sh recon        采集 NAS 容器/镜像/挂载/磁盘信息
#   ./deploy/nas.sh logs         查看 new-api 容器日志
#   ./deploy/nas.sh prune        清理 168h 以上的悬空镜像与构建缓存
#
#   deploy 支持 --mirror：基础镜像拉不动时改走 deploy/Dockerfile.mirror
#
# 权限模型：
#   本地只做「构建 + 传输」；所有 docker 操作都由 NAS 上的
#   deploy/remote-deploy.sh 以 root 执行。整条链路只会有**一次** sudo 提示
#   （deploy/rollback/backup/... 时），你输一次密码，脚本即一次做完并退出。
#
# 安全约定：任何路径都不会执行 `docker compose down -v`（数据卷是红线）。
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/deploy/nas.env"
REMOTE_SCRIPT="$ROOT_DIR/deploy/remote-deploy.sh"

log()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 配置加载
SSH_OPTS=()
SCP_OPTS=()
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
  : "${NAS_COMPOSE_FILE:=compose.yaml}"
  : "${IMAGE_NAME:?nas.env 缺少 IMAGE_NAME}"

  # 默认按部署时间生成镜像标签。nas.env 仍可填写 IMAGE_TAG 来固定标签。
  if [ -z "${IMAGE_TAG:-}" ]; then
    IMAGE_TAG="local-$(date +%Y%m%d-%H%M%S)"
    export IMAGE_TAG
  fi

  # 必须在加载 nas.env 之后再构建，否则端口/密钥会取到默认值。
  SSH_OPTS=(-o ConnectTimeout=8 -o BatchMode=no -o StrictHostKeyChecking=accept-new
            -p "$NAS_SSH_PORT")
  # OpenSSH 9 起 scp 默认走 SFTP；部分群晖未启用 SFTP subsystem，需强制旧 SCP 协议。
  SCP_OPTS=(-O -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -P "$NAS_SSH_PORT")
  [ -n "${NAS_SSH_KEY:-}" ] && SSH_OPTS+=(-i "${NAS_SSH_KEY/#\~/$HOME}")
  [ -n "${NAS_SSH_KEY:-}" ] && SCP_OPTS+=(-i "${NAS_SSH_KEY/#\~/$HOME}")
}

nas_ssh() { ssh "${SSH_OPTS[@]}" "${NAS_SSH_USER}@${NAS_HOST}" "$@"; }
nas_scp() { scp "${SCP_OPTS[@]}" "$@"; }

# 需要 root 的动作：一次 ssh -t，sudo 在 TTY 上提示一次密码
nas_sudo() { # action [arg]
  local action="$1" arg="${2:-}" cmd
  cmd="sudo '$NAS_DEPLOY_DIR/deploy/remote-deploy.sh' '$action'"
  [ -n "$arg" ] && cmd="$cmd '$arg'"
  ssh -t "${SSH_OPTS[@]}" "${NAS_SSH_USER}@${NAS_HOST}" "$cmd"
}

# ------------------------------------------------------------------- 本机
require_local_docker() {
  command -v docker >/dev/null 2>&1 || die "本机找不到 docker。
    本脚本需要在本地构建镜像。若用 Docker Desktop：
      Settings → Resources → WSL Integration → 打开当前发行版
    或直接在 Windows 侧有 docker 的环境里运行。"

  if ! docker info >/dev/null 2>&1; then
    die "本机 docker 客户端存在，但连不上引擎（Docker Desktop 未启动或未开启 WSL 集成）。
    Docker Desktop → Settings → Resources → WSL Integration → 打开当前发行版。"
  fi
}

# ------------------------------------------------ 远端前提：幂等修补 compose
# 只在首次需要时把 image 行换成 ${NEWAPI_IMAGE:-...}，并留一份备份。
# 这样你不需要手动编辑 NAS 上的 compose 文件。
ensure_compose_var() {
  local result
  if ! result="$(nas_ssh "sh -s -- '$NAS_DEPLOY_DIR' '$NAS_COMPOSE_FILE'" <<'REMOTE_PATCH'
set -eu
dir="$1"; file="$2"
cd "$dir"
[ -f "$file" ] || { echo "missing"; exit 0; }
if grep -q NEWAPI_IMAGE "$file"; then echo "already"; exit 0; fi
backup="$file.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$file" "$backup"
sed -i 's|^\([[:space:]]*image:[[:space:]]*\)calciumion/new-api:.*$|\1${NEWAPI_IMAGE:-calciumion/new-api:v1.0.0-rc.36}|' "$file"
grep -q NEWAPI_IMAGE "$file" || { echo "failed"; exit 1; }
echo "patched:$backup"
REMOTE_PATCH
)"; then
    die "SSH 到 NAS 失败，无法检查 compose（先执行 ./deploy/nas.sh check）"
  fi

  case "$result" in
    already) ok "compose 已支持版本切换（\${NEWAPI_IMAGE}）" ;;
    patched:*) ok "已为 compose 打上 \${NEWAPI_IMAGE} 变量，原文件备份为 ${result#patched:}" ;;
    "") die "无法确认 NAS 上 compose 的状态（SSH 输出为空）" ;;
    *) die "compose 修补失败（$result）—— 请手工把 $NAS_DEPLOY_DIR/$NAS_COMPOSE_FILE 的 image 行改为：
     image: \${NEWAPI_IMAGE:-calciumion/new-api:v1.0.0-rc.36}" ;;
  esac
}

# ------------------------------------------------------------ 构建参数
# --mirror 时改用 deploy/Dockerfile.mirror（基础镜像与 apt 源走可达的镜像）
DOCKERFILE_ARGS=()
DOCKERFILE_LABEL="（默认 Dockerfile）"

dockerfile_args() {
  DOCKERFILE_ARGS=()
  DOCKERFILE_LABEL="（默认 Dockerfile）"
  if [ "${1:-}" = "--mirror" ]; then
    DOCKERFILE_ARGS=(-f deploy/Dockerfile.mirror)
    DOCKERFILE_LABEL="（deploy/Dockerfile.mirror）"
  fi
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

  log "检查本机 docker…"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    ok "本机 docker 可用（$(docker version --format '{{.Server.Version}}' 2>/dev/null)）"
  else
    warn "本机 docker 不可用 —— deploy 的「构建」步骤会失败。
   若用 Docker Desktop：Settings → Resources → WSL Integration → 打开当前发行版。"
  fi

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

  log "检查部署目录…"
  # 不用 `nas_ssh ... | grep -q`：grep 命中即退出会触发 SIGPIPE，
  # 配合 set -o pipefail 会造成偶发误判。
  local dir_marker
  dir_marker="$(nas_ssh "[ -d '$NAS_DEPLOY_DIR' ] && echo ok || echo missing")"
  [ "$dir_marker" = "ok" ] || die "NAS 上找不到部署目录 $NAS_DEPLOY_DIR"

  if nas_ssh "[ -f '$NAS_DEPLOY_DIR/$NAS_COMPOSE_FILE' ]"; then
    ok "compose 文件存在（$NAS_COMPOSE_FILE）"
  else
    die "找不到 $NAS_DEPLOY_DIR/$NAS_COMPOSE_FILE"
  fi

  if nas_ssh "grep -q NEWAPI_IMAGE '$NAS_DEPLOY_DIR/$NAS_COMPOSE_FILE'"; then
    ok "compose 已支持版本切换（\${NEWAPI_IMAGE}）"
  else
    warn "compose 尚未使用 \${NEWAPI_IMAGE} —— deploy 会自动帮你改好并留备份"
  fi

  if [ -n "${NAS_API_URL:-}" ]; then
    log "检查服务可访问性…"
    if curl -fsS -m 8 "${NAS_API_URL}/api/status" >/dev/null 2>&1; then
      ok "${NAS_API_URL} 响应正常"
    else
      warn "${NAS_API_URL} 无响应"
    fi
  fi

  echo
  ok "自检完成。执行 ./deploy/nas.sh deploy 即可一键部署"
  echo "  （构建在本机进行；上线阶段会在 NAS 上提示一次 sudo 密码）"
}

cmd_build() {
  load_env
  require_local_docker
  dockerfile_args "$@"
  log "构建 ${IMAGE_NAME}:${IMAGE_TAG} ${DOCKERFILE_LABEL}…"
  ( cd "$ROOT_DIR" && docker build "${DOCKERFILE_ARGS[@]}" -t "${IMAGE_NAME}:${IMAGE_TAG}" . ) \
    || die "镜像构建失败"
  ok "构建完成"
}

cmd_deploy() {
  load_env
  require_local_docker
  ensure_compose_var

  # 1) 推送特权脚本（每次覆盖，保证远端脚本与仓库一致）
  nas_ssh "mkdir -p '$NAS_DEPLOY_DIR/deploy'" >/dev/null
  nas_scp "$REMOTE_SCRIPT" "${NAS_SSH_USER}@${NAS_HOST}:$NAS_DEPLOY_DIR/deploy/remote-deploy.sh"
  nas_ssh "chmod 755 '$NAS_DEPLOY_DIR/deploy/remote-deploy.sh'"
  ok "已在 NAS 就位 deploy/remote-deploy.sh"

  # 2) 本机构建
  dockerfile_args "$@"
  log "构建 ${IMAGE_NAME}:${IMAGE_TAG}${DOCKERFILE_LABEL}（首次需拉取基础镜像，可能较慢）…"
  ( cd "$ROOT_DIR" && docker build "${DOCKERFILE_ARGS[@]}" -t "${IMAGE_NAME}:${IMAGE_TAG}" . ) \
    || die "镜像构建失败。若卡在拉取基础镜像，可改用：
     ./deploy/nas.sh deploy --mirror"

  # 3) 导出并投递
  local tmp; tmp="$(mktemp -d)"
  log "导出镜像…"
  if ! docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip > "$tmp/image.tgz"; then
    rm -rf "$tmp"; die "docker save 失败"
  fi
  ls -lh "$tmp/image.tgz"

  log "投递到 NAS（几分钟）…"
  if ! nas_scp "$tmp/image.tgz" "${NAS_SSH_USER}@${NAS_HOST}:$NAS_DEPLOY_DIR/deploy/image.tgz"; then
    rm -rf "$tmp"; die "镜像传输失败"
  fi
  rm -rf "$tmp"

  # 4) 上线：全部 docker 操作合并成一次 sudo
  echo
  log "在 NAS 上执行部署 —— 接下来会提示输入一次 sudo 密码"
  if ! nas_sudo deploy "${IMAGE_NAME}:${IMAGE_TAG}"; then
    die "部署失败。完整日志在 NAS：$NAS_DEPLOY_DIR/deploy/remote-deploy.log
   也可执行 ./deploy/nas.sh logs 查看容器输出。"
  fi

  # 5) 本地复核
  if [ -n "${NAS_API_URL:-}" ]; then
    local i
    for i in 1 2 3 4 5; do
      if curl -fsS -m 8 "${NAS_API_URL}/api/status" >/dev/null 2>&1; then
        ok "${NAS_API_URL} 响应正常"
        break
      fi
      [ "$i" = 5 ] && warn "${NAS_API_URL} 暂时无响应，请检查 NAS 容器状态"
      sleep 3
    done
  fi

  ok "部署完成：${IMAGE_NAME}:${IMAGE_TAG}"
  echo "  请按 CUSTOMIZATIONS.md 的功能自检清单核对界面。"
}

cmd_rollback() {
  load_env
  log "回滚到上一个成功部署的镜像（会提示一次 sudo 密码）…"
  nas_sudo rollback || die "回滚失败，详见上面的输出"
  ok "回滚完成"
}

cmd_backup() {
  load_env
  log "在 NAS 上备份数据库（会提示一次 sudo 密码）…"
  nas_sudo backup || die "备份失败"
}

cmd_recon() {
  load_env
  log "采集 NAS 信息（会提示一次 sudo 密码）…"
  nas_sudo recon || die "采集失败"
}

cmd_logs() {
  load_env
  log "读取 new-api 容器日志（会提示一次 sudo 密码）…"
  nas_sudo logs || die "读取日志失败"
}

cmd_prune() {
  load_env
  log "清理 NAS 上的悬空镜像与构建缓存（会提示一次 sudo 密码）…"
  nas_sudo prune || die "清理失败"
}

usage() {
  sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  check)    cmd_check ;;
  init-key) cmd_init_key ;;
  build)    cmd_build "${2:-}" ;;
  deploy)   cmd_deploy "${2:-}" ;;
  rollback) cmd_rollback ;;
  backup)   cmd_backup ;;
  recon)    cmd_recon ;;
  logs)     cmd_logs ;;
  prune)    cmd_prune ;;
  ''|-h|--help|help) usage ;;
  *) die "未知子命令：$1（执行 ./deploy/nas.sh help 查看用法）" ;;
esac
