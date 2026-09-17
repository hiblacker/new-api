# 推荐组合详解：外部构建 + 文件投递 + NAS 侧 root 执行

> 这是三轮调研后的最终推荐。本文给出**可直接落地的完整设计**，包括脚本全文、
> 端到端时序、失败处理、安全边界，以及对现有 `deploy/nas.sh` 的改造清单。

---

## 1. 一句话概括

> **构建放在能联网的地方**（GitHub Actions 或你的工作站）；
> **镜像经 SSH 投递到 NAS 的一个 staging 目录**；
> **NAS 上唯一拥有特权的固定脚本**（由 root cron 或按需触发）完成
> 「备份 → 载入 → 部署 → 健康检查 → 失败自动回滚」。

NAS **不出网、不构建、不持有构建产物之外的任何东西**；
SSH 凭据**不直接拥有 docker 权限**。

---

## 2. 为什么是这个组合：从实测约束反推

每一条设计决策都能追到一条实测事实，不是拍脑袋：

| 实测约束 | 推导出的设计决策 |
|---|---|
| NAS → `github.com` ❌ | **不在 NAS 上拉源码** → 构建必须在外部 |
| NAS → `auth.docker.io` ❌（虽有 3 个镜像源可用） | **不在 NAS 上构建** → 避免依赖镜像源可用性；且引擎 24.0.2 老旧 |
| `docker.sock` = `root:root`，无 docker 组 | **特权操作必须集中** → 收进一个固定脚本，而不是散落在 SSH 命令里 |
| 计划任务可以 **root** 运行 + `/etc/cron.d` 存在 | **有现成的特权执行入口** → 不需要 NOPASSWD、不需要 root SSH |
| SSH 凭据可能泄露 | **投递与执行分离** → 凭据只能写文件、读结果 |
| 本次改动**零 schema 变更** | 部署与回滚**都不需要碰数据** |
| 数据全是 **bind mount** | 备份 = `pg_dump` / 打包目录，无匿名卷陷阱 |
| GHCR token 被拒、Portainer CE webhook 需商业版 | **不走 registry、不引入额外服务** |

---

## 3. 架构图

```
┌─────────────────────── 外部（CI 或工作站）───────────────────────┐
│                                                                  │
│   git push tag                                                   │
│        ↓                                                         │
│   bun run typecheck && bun run test      ← 回归拦在这里           │
│        ↓                                                         │
│   bun run build && go build              ← 真正的构建             │
│        ↓                                                         │
│   docker build -t new-api:vX.Y.Z-custom.N                        │
│        ↓                                                         │
│   docker save | gzip  →  image.tgz                               │
│                                                                  │
└──────────────────────────┬───────────────────────────────────────┘
                           │  scp（走已打通的 13022 通道）
                           │  ★ 只写文件，不执行任何特权命令
                           ▼
┌────────────────────────── NAS（群晖 DS723+）──────────────────────┐
│                                                                  │
│  /volume1/docker/new-apiv1/                                      │
│  ├── compose.yaml          ← 需改：image: ${NEWAPI_IMAGE:-...}    │
│  ├── .env                  ← 现有，含 DB/Redis 密钥（不动）        │
│  ├── postgres/ redis/ data/ logs/   ← 数据（不动）                │
│  │                                                               │
│  ├── staging/   (hiblacker 可写)     ← 外部唯一能写的地方          │
│  │   ├── image.tgz                                               │
│  │   └── request.json                                            │
│  │                                                               │
│  └── deploy/    (root:root 755)      ← 外部只能读，不能写          │
│      ├── runner.sh                   ← 唯一的特权脚本              │
│      ├── backups/                    ← pg_dump 落地               │
│      └── out/   (外部可读)                                        │
│          ├── result.json             ← 外部轮询这个判断结果        │
│          ├── recon.txt                                            │
│          └── runner.log                                           │
│                                                                  │
│  触发：/etc/cron.d/newapi-deploy  →  */2 * * * * root runner.sh   │
│        （分钟级轮询；或按需 synoschedtask --run）                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 4. NAS 侧组件清单

### 4.1 目录与权限

| 路径 | 属主/权限 | 谁能写 | 作用 |
|---|---|---|---|
| `staging/` | `hiblacker:users 700` | **外部 SSH 用户** | 投递镜像与请求 |
| `deploy/` | `root:root 755` | 仅 root | 特权脚本 |
| `deploy/backups/` | `root:root 700` | 仅 root | 备份（含数据库内容，不能外泄） |
| `deploy/out/` | `hiblacker:users 755` | 仅 root | 结果输出，外部可读 |

**关键**：外部能写的只有 `staging/`，而特权脚本**只从 staging 读 `image.tgz` 和 `request.json` 两个文件**，且校验属主。

### 4.2 `compose.yaml` 的唯一改动

```yaml
services:
  new-api:
    # 原来是硬编码： image: calciumion/new-api:v1.0.0-rc.36
    image: ${NEWAPI_IMAGE:-calciumion/new-api:v1.0.0-rc.36}
```

**只改这一行。** 其余（`.env`、volumes、depends_on、healthcheck）一律不动。

---

## 5. 特权脚本全文：`deploy/runner.sh`

```bash
#!/bin/bash
# /volume1/docker/new-apiv1/deploy/runner.sh
# 属主 root:root，权限 755。由 cron 以 root 调用，或 synoschedtask --run。
# ★ 不接受任何外部参数 —— 消除命令注入面。
set -euo pipefail

BASE=/volume1/docker/new-apiv1
STAGING="$BASE/staging"
OUT="$BASE/deploy/out"
BACKUPS="$BASE/deploy/backups"
COMPOSE="$BASE/compose.yaml"
ENVFILE="$BASE/.env"
PROJECT=""                      # 若你的 compose 用了 -p，在此填项目名
export PATH=/usr/local/bin:$PATH

mkdir -p "$OUT" "$BACKUPS"
REQ="$STAGING/request.json"
LOG="$OUT/runner.log"

log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }
result() {  # ok action tag message
  printf '{"ok":%s,"action":"%s","tag":"%s","at":"%s","message":"%s"}\n' \
    "$1" "$2" "${3:-}" "$(date -Iseconds)" "${4:-}" > "$OUT/result.json"
}

# 用指定镜像重建容器（本项目所有 compose 调用都走这里）
compose_up_with() {  # $1 = 镜像引用；其余参数透传给 compose up
  local image="$1"; shift
  cd "$BASE"
  NEWAPI_IMAGE="$image" docker compose --env-file "$ENVFILE" \
    ${PROJECT:+-p "$PROJECT"} -f "$COMPOSE" up -d "$@" >> "$LOG" 2>&1
}

service_container() {  # 按 compose 服务名解析容器
  docker ps -q --filter "label=com.docker.compose.service=$1" | head -1
}

# ── 没有请求就直接退出（轮询模式下的绝大多数情况）────────────────
[ -f "$REQ" ] || exit 0

# ── 校验：只接受本用户投递的文件 ──────────────────────────────
if [ "$(stat -c %U "$REQ")" != "hiblacker" ]; then
  log "拒绝：request.json 属主是 $(stat -c %U "$REQ")"
  rm -f "$REQ"; exit 1
fi

# 移到 .processing，保证崩溃后不会无限重放
mv "$REQ" "$STAGING/request.processing"
PROC="$STAGING/request.processing"
trap 'mv -f "$PROC" "$STAGING/request.failed" 2>/dev/null || true' ERR

read_field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$PROC"; }
ACTION="$(read_field action)"
TAG="$(read_field tag)"
REQUEST_ID="$(read_field id)"

case "$ACTION" in deploy|rollback|backup|recon|prune) ;; *)
  log "拒绝：未知 action=$ACTION"; result false "$ACTION" "" "unknown action"
  mv -f "$PROC" "$STAGING/request.failed"; exit 1 ;;
esac

log "── 开始 action=$ACTION tag=$TAG id=$REQUEST_ID ──"

# ═══════════════════ recon ═══════════════════
if [ "$ACTION" = recon ]; then
  CNAME="$(service_container new-api)"
  {
    echo "### $(date -Iseconds)"
    echo "## container: ${CNAME:-none}"
    [ -n "$CNAME" ] && docker inspect "$CNAME" --format 'image={{.Config.Image}} status={{.State.Status}}'
    echo "## images"
    docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep -i new-api || true
    echo "## mounts"
    [ -n "$CNAME" ] && docker inspect "$CNAME" --format '{{json .Mounts}}'
    echo "## disk"
    df -h /volume1 | tail -1
    echo "## backups"
    ls -lh "$BACKUPS" | tail -5
  } > "$OUT/recon.txt" 2>&1
  result true recon "" "recon written"
  mv -f "$PROC" "$STAGING/request.done"; exit 0
fi

# ═══════════════════ backup ═══════════════════
do_backup() {
  local stamp; stamp="$(date +%F-%H%M%S)"
  local pgc; pgc="$(service_container postgres)"
  [ -n "$pgc" ] || { log "找不到 postgres 容器"; return 1; }
  docker exec "$pgc" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    | gzip > "$BACKUPS/pg-${stamp}.sql.gz" || return 1
  # 只保留最近 10 份
  ls -1t "$BACKUPS"/pg-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
  log "备份完成：pg-${stamp}.sql.gz ($(du -h "$BACKUPS/pg-${stamp}.sql.gz" | cut -f1))"
}

if [ "$ACTION" = backup ]; then
  if do_backup; then result true backup "" "backup ok"
  else result false backup "" "backup failed"; fi
  mv -f "$PROC" "$STAGING/request.done"; exit 0
fi

# ═══════════════════ prune ═══════════════════
if [ "$ACTION" = prune ]; then
  docker image prune -f --filter "until=168h"   >> "$LOG" 2>&1
  docker builder prune -f --filter "until=168h" >> "$LOG" 2>&1
  # ★ 不碰 rollback 镜像：它没有 dangling，且是唯一的回滚依赖
  result true prune "" "prune done"
  mv -f "$PROC" "$STAGING/request.done"; exit 0
fi

# ═══════════════════ rollback ═══════════════════
if [ "$ACTION" = rollback ]; then
  if ! docker image inspect new-api:rollback >/dev/null 2>&1; then
    result false rollback "" "no rollback image"; mv -f "$PROC" "$STAGING/request.done"; exit 0
  fi
  compose_up_with new-api:rollback || true
  sleep 10
  if curl -fsS -m 10 http://127.0.0.1:53130/api/status >/dev/null 2>&1; then
    result true rollback new-api:rollback "rolled back"
  else
    result false rollback new-api:rollback "rollback unhealthy"
  fi
  mv -f "$PROC" "$STAGING/request.done"; exit 0
fi

# ═══════════════════ deploy ═══════════════════
[ -n "$TAG" ] || { result false deploy "" "tag required"; mv -f "$PROC" "$STAGING/request.done"; exit 0; }

IMG="$STAGING/image.tgz"
[ -f "$IMG" ] || { result false deploy "$TAG" "image.tgz missing"; mv -f "$PROC" "$STAGING/request.done"; exit 0; }
[ "$(stat -c %U "$IMG")" = "hiblacker" ] || {
  result false deploy "$TAG" "image.tgz owner invalid"; mv -f "$PROC" "$STAGING/request.done"; exit 0; }

# 1) 记录回滚点
CUR="$(docker inspect "$(service_container new-api)" --format '{{.Config.Image}}' 2>/dev/null || true)"
if [ -n "$CUR" ] && [ "$CUR" != "$TAG" ]; then
  docker tag "$CUR" new-api:rollback && log "回滚点：new-api:rollback ← $CUR"
fi

# 2) 部署前必须先备份成功，否则中止
if ! do_backup; then
  result false deploy "$TAG" "pre-deploy backup failed, aborted"
  mv -f "$PROC" "$STAGING/request.done"; exit 1
fi

# 3) 载入新镜像
docker load < "$IMG" >> "$LOG" 2>&1 || {
  result false deploy "$TAG" "docker load failed"; mv -f "$PROC" "$STAGING/request.done"; exit 1; }
rm -f "$IMG"

# 4) 重建容器（★ 永不 down -v）
if ! compose_up_with "$TAG"; then
  result false deploy "$TAG" "compose up failed"; mv -f "$PROC" "$STAGING/request.done"; exit 1
fi

# 5) 健康检查，失败自动回滚
sleep 15
if curl -fsS -m 10 http://127.0.0.1:53130/api/status >/dev/null 2>&1; then
  log "部署成功：$TAG"
  result true deploy "$TAG" "deployed and healthy"
else
  log "健康检查失败，自动回滚"
  if docker image inspect new-api:rollback >/dev/null 2>&1; then
    compose_up_with new-api:rollback || true
    sleep 10
    if curl -fsS -m 10 http://127.0.0.1:53130/api/status >/dev/null 2>&1; then
      result false deploy "$TAG" "unhealthy, auto-rolled back to new-api:rollback"
    else
      result false deploy "$TAG" "unhealthy AND rollback unhealthy, manual attention"
    fi
  else
    result false deploy "$TAG" "unhealthy, no rollback image available"
  fi
fi

mv -f "$PROC" "$STAGING/request.done"
```

---

## 6. 触发器：`/etc/cron.d/newapi-deploy`

```
# /etc/cron.d/newapi-deploy
# 群晖 crontab 格式比标准多一个 who 列
*/2 * * * *  root  /volume1/docker/new-apiv1/deploy/runner.sh
```

**为什么用 `cron.d` 而不是 DSM 计划任务界面**：实测群晖计划任务界面的调度粒度是
天/周/月，做不到「每 2 分钟」；而 `/etc/cron.d` 存在且支持标准 cron 表达式。

**DSM 更新可能重置 `/etc`** → 用一个 **开机触发的 DSM 计划任务**重新安装这个文件：

```bash
# DSM 计划任务 → 触发的任务 → 开机 → 用户 root
echo '*/2 * * * *  root  /volume1/docker/new-apiv1/deploy/runner.sh' \
  > /etc/cron.d/newapi-deploy && chmod 644 /etc/cron.d/newapi-deploy
```

这样即使 `/etc` 被重置，重启后也会自动恢复。**这个开机任务本身就是你用 DSM 界面
创建的那一个 root 任务** —— 只用于安装 cron 文件，内容固定、不可注入。

> **低延迟替代**：`synoschedtask --run id=<ID>` 可按需触发，把延迟从 2 分钟降到秒级。
> 但见 §8 的安全说明——它同时也是一个提权面，**默认不启用**。

---

## 7. 端到端时序

### 7.1 部署

```
工作站/CI                        NAS staging              root runner (cron)
    │                                │                          │
    ├─ build 镜像 ────────────────────┤                          │
    ├─ docker save | gzip ───────────►│ image.tgz                │
    ├─ 写 request.json ──────────────►│ {action:deploy,tag:...}  │
    │                                │                          │
    │                                │◄──── 每 2 分钟检查 ───────┤
    │                                │     发现 request         │
    │                                ├─────────────────────────►│ 校验属主
    │                                │                          ├─ pg_dump 备份
    │                                │                          ├─ tag rollback
    │                                │                          ├─ docker load
    │                                │                          ├─ compose up -d
    │                                │                          ├─ 健康检查
    │                                │                          │
    │◄── 读 out/result.json ─────────┤◄──── 写 result.json ─────┤
    │    {"ok":true,"tag":...}       │                          │
```

### 7.2 失败与自动回滚

第 5 步健康检查失败 → 脚本自动 `compose up -d` 回滚镜像 → 写
`{"ok":false, "message":"unhealthy, auto-rolled back..."}`。
外部只需读 `result.json` 即可知道结果，**不需要交互式介入**。

### 7.3 其它操作

| 操作 | 外部做的事 | NAS 做的事 |
|---|---|---|
| `recon` | 写 `request.json{action:recon}` → 读 `out/recon.txt` | 采集容器/镜像/挂载/磁盘/备份清单 |
| `backup` | 写 `request.json{action:backup}` | `pg_dump` + 只留最近 10 份 |
| `rollback` | 写 `request.json{action:rollback}` | `compose up -d` 回滚镜像 |
| `prune` | 写 `request.json{action:prune}` | 清理 168h 以上的镜像/构建缓存（**不碰 rollback**） |

---

## 8. 安全模型

### 8.1 边界

| 谁 | 能做什么 | 不能做什么 |
|---|---|---|
| 外部 SSH 凭据 | 写 `staging/`、读 `deploy/out/` | 执行任何 docker 命令、读 `deploy/backups/`（含 DB 内容） |
| root runner | 全部 | 不接受外部参数（消除注入面） |

### 8.2 残余风险（必须如实说明）

**风险 1：`compose.yaml` 若可被外部改写，就能让 root 脚本启动特权容器。**

缓解（本设计已包含）：
- `compose.yaml` 位于 `deploy/` 之外的部署目录，属主是 `hiblacker`——
  **所以这一点目前并没有被限制住**。若要真正收紧，把 `compose.yaml` 也改为 `root:root 644`，
  外部需要改配置时通过一份新的 `compose.yaml.new` 走一次人工确认。

**风险 2：`synoschedtask --run` 是已知被滥用的提权路径。**

检索中出现「Malware Warning - `synoschedtask --run id=1`」的社区帖子
（正文未能抓取，**细节未确认**）。因此本设计**默认用 cron 轮询**，
不把 `--run` 作为默认触发方式。

**风险 3：投递目录的属主校验是"软"防护。**

脚本校验 `stat -c %U` = `hiblacker`，但同机其它进程若以该身份运行也能通过。
对你的单管理员 NAS 影响有限；若在意，给 CI 单独建一个**非 administrators** 的 DSM 账号，
只授予 `staging/` 的写权限。

### 8.3 与「NOPASSWD docker」的对比

| | 本设计 | NOPASSWD docker |
|---|---|---|
| 外部凭据能否直接执行特权操作 | ❌ 不能 | ✅ 能 |
| 泄露后的最坏后果 | 投递一个**经过校验**的镜像并触发固定流程 | **完整 root**（`docker run -v /:/host --privileged`） |
| 审计 | `runner.log` 记录每次 action | 无 |

> **注意**：严格来说，「能部署」本身就是一种重要权限（能替换服务端二进制）。
> 本设计的优势在于**行为被约束在一个固定脚本里**，而不是"给了对方一把 root 钥匙"。

---

## 9. 运维自动化（都用同一个 runner）

| 任务 | cron 表达式 | 作用 |
|---|---|---|
| 部署轮询 | `*/2 * * * *` | 检查 staging 是否有请求 |
| 每日备份 | `0 3 * * *` | 写 `request.json{action:backup}` 后由 runner 执行；或直接 `runner` 内部定时 |
| 每周清理 | `0 4 * * 0` | `request.json{action:prune}` |

> 更简单的做法：让 runner 自己判断时间（日备份/周清理），
> 这样只需要**一条** cron 记录。**推荐这种做法**，减少 /etc 里的文件数。

---

## 10. 对现有 `deploy/nas.sh` 的改造清单

| 现有子命令 | 改造后 |
|---|---|
| `check` | 保留；新增检查 cron 是否已安装、runner 是否就位 |
| `recon` | 改为「投递请求 → 等 → 读 `out/recon.txt`」（不再直连 docker） |
| `backup` | 同上，读 `out/result.json` + 备份列表 |
| `build` | **不变**（本地构建） |
| `transfer` | 改为 `docker save \| ssh 'cat > staging/image.tgz'`（**不再 `docker load`**） |
| `deploy` | 改为「写 `request.json{action:deploy,tag}` → 轮询 `result.json`」 |
| `rollback` | 改为「写 `request.json{action:rollback}` → 读结果」 |
| `logs` | 改为投递请求，由 runner 把 `docker logs` 落到 `out/`，本地 `cat` |
| **新增** `install` | 一次性引导：创建目录/权限、安装 cron 文件（需一次 root，走 DSM 界面或 NOPASSWD） |

**保留的能力**：`build`、`check`、以及所有「本地」操作完全不变。

---

## 11. 分阶段落地

| 阶段 | 动作 | 需要你做什么 | 产出 |
|---|---|---|---|
| **P0** | 改 `compose.yaml` 的 image 行为 `${NEWAPI_IMAGE:-...}` | 改 1 行 | 版本可切换 |
| **P1** | 在 NAS 建目录与权限，放 `runner.sh` | 一次 root（DSM 界面建 root 任务即可） | 特权脚本就位 |
| **P2** | 安装 `/etc/cron.d/newapi-deploy` + 开机恢复任务 | DSM 界面建开机任务 | 轮询生效 |
| **P3** | 改造 `deploy/nas.sh`（§10） | 我改 | 一键 `push` / `rollback` |
| **P4** | 首次真跑：备份 → 部署 → 验证 → 回滚演练 | 观察 | 链路打通 |
| **P5**（可选） | 接入 GitHub Actions | 配 Secret | push tag 即部署 |

**P1~P3 我可以现在就做完**（P1/P2 需要你用 DSM 界面点几下，或给我一次 NOPASSWD）。

---

## 12. 明确不采用的方案及原因

| 方案 | 不采用的原因 |
|---|---|
| NAS 本地构建 | 引擎 24.0.2（上游 2024-06 起不维护）；构建占满 4 核 10–30 分钟 |
| NAS 从 GitHub 拉源码 | `github.com` 实测不可达（走 ghproxy 可行但多一跳依赖） |
| 推送 GHCR 让 NAS 拉 | ghcr token 实测被拒；Container Manager UI 无法认证 GHCR |
| Watchtower | 「有新版就换」与固定 tag + 可回滚直接冲突 |
| Portainer CE webhook | stack webhook 是 **Business Edition** 功能，CE 需额外 sidecar |
| 自托管 GitHub Runner | 官方明确不建议用于公开仓库（forker 可执行恶意 workflow） |
| Coolify / Dokploy / k3s | 在 DSM 上均无法正常运行（安装器失败 / 引擎版本冲突 / 缺内核模块） |
| NOPASSWD docker | 等价于把 root 交给外部凭据（见 §8.3） |
| `docker compose down -v` | 会删数据卷 —— 任何方案下的绝对红线 |

---

## 13. 一句话总结

> **构建在外部，投递用文件，执行在 NAS 的固定脚本里，提权靠 root cron。**
> 每一步都能追到一条实测约束；每一处特权都被收进一个不接受参数的脚本；
> 部署前必先备份，失败自动回滚，且**永远不碰数据卷**。


---

## 14. 变体：如果自建 Git 服务呢？

### 14.1 先问一个问题：部署链路需要源码吗？

**不需要。** 推荐设计里，NAS 收到的只有**构建好的镜像**，
它从头到尾没有 `git clone`、没有 `docker build`。

所以：**自建 Git 服务不会改善部署链路。** 它的价值在别处（见 14.4）。

### 14.2 三种自建形态

#### 形态 A：NAS 存源码 + NAS 本地构建（自洽闭环）

```
你 git push nas → Gitea → runner/cron → NAS 上 docker build → compose up -d
```

| 优点 | 缺点 |
|---|---|
| 完全不依赖 GitHub | 构建在 **4 核** NAS 上跑 Go+前端：**10–30 分钟** |
| 源码与镜像都在自己手里 | runner 需要 docker 权限（**= root**） |
| | 依赖镜像源可用性（实测 3/9 可用，会变） |
| | 引擎 **24.0.2**，上游 2024-06 起不维护 |

**结论**：能跑，但**不划算**——你的工作站构建一次只要 1–2 分钟。

#### 形态 B：Git + 本地 Registry 作为**交付通道**（若自建，推荐这个形态）

```
工作站 build → docker push  nas:5010/new-api:vX-custom.N
                                  ↓
            NAS 从【本地 registry】拉取 → runner 部署
```

| 优点 | 缺点 |
|---|---|
| **完全不依赖外部网络**（连镜像源都不需要） | 需配 `insecure-registries`（HTTP registry 必须） |
| 原生多 tag → 回滚到任意历史版本 | 改 `dockerd.json` + **重启 docker daemon**（需 root） |
| 层复用，增量传输 | 多一个常驻容器 |
| | 多一个要备份/升级的服务 |

#### 形态 C：完整 Gitea + Actions Runner

最重。runner 需要 docker 权限，构建仍在 NAS 上（慢），
且官方建议自托管 runner **不要用于公开仓库**。
**结论：过度工程。**

### 14.3 关键反驳：`docker load` 已经把「多版本回滚」免费给你了

这一点很多人会忽略：

> `docker load` 会把镜像**永久写进 NAS 本地镜像库**（直到被 prune）。

也就是说：

- 每部署一个版本，NAS 上就多一个镜像 tag → **回滚到任意历史版本天然可行**
- 不需要 registry 来保存历史版本
- 我们的 runner 只额外打一个 `rollback` tag，但完全可以保留 `vX-custom.1/2/3/...`

**registry 相对 `save | scp | load` 的核心增量，主要是**：

| | save/load | 本地 registry |
|---|---|---|
| 多版本回滚 | ✅ 已有 | ✅ |
| 增量传输（只传变化层） | ❌ 每次全量 ~150–200MB | ✅ |
| 配置成本 | **零** | 需 insecure-registries + 常驻容器 |
| 局域网耗时 | 几秒~几十秒 | 更快 |

**结论**：对「偶尔发版」的场景，`save/load` 的零配置优势大于 registry 的增量优势。

### 14.4 那自建 Git 真正值得的理由是什么？

不是部署，而是这三条：

1. **代码自主可控** —— 不再只存在 GitHub（你的 NAS 连不上 GitHub，但工作站能）
2. **异地备份** —— Gitea 可以作为 GitHub 仓库的**镜像目标**，定时同步
3. **事件驱动触发** —— Gitea webhook 可以替代 cron 轮询，把部署延迟从 2 分钟降到秒级

### 14.5 若确实要自建，我会怎么调整架构

**保持权限边界不变**是最重要的：

```
你 push tag → Gitea webhook ──► 非特权小接收器（以 hiblacker 运行）
                                        │  只做一件事：
                                        │  写 staging/request.json
                                        ▼
                                 root runner（cron）照常执行
```

要点：
- **绝不让 webhook 接收器直接拥有 docker 权限** —— 它只写一个文件
- 选型建议 **Forgejo**（Gitea 的社区 fork，许可证更干净）或 Gitea
- 端口避开 `5000 / 5001 / 53130`，例如 `3010`(web) + `2222`(SSH)
- **只用它的 Git 仓库**（+ 可选的内置 registry），**不要用 Actions**
- Gitea 自身也要纳入备份（仓库 + 数据库）

### 14.6 更轻的替代方案

如果真实诉求只是其中一条，不必上 Gitea：

| 诉求 | 更轻的做法 |
|---|---|
| 只要一个本地 registry | 单跑 `registry:2` 容器（几十 MB），不需要 Gitea |
| 只要代码异地备份 | Gitea/Forgejo 当**镜像目标**；或群晖自带 **Git Server** 包（很轻，无 UI/registry） |
| 只要事件触发 | 一个 20 行的接收器（只写 `request.json`），或先继续用 cron 轮询 |

### 14.7 建议

> **不要为了部署而自建 Git。**
> 推荐设计里 NAS 不需要源码；`docker load` 已经免费提供了多版本回滚。
>
> **如果你的动机是「代码不想只依赖 GitHub」，那自建 Gitea/Forgejo 是合理的**——
> 但请把它定位成**代码托管与镜像备份**，而不是部署流水线的一部分。
>
> **若两者都想要**，采用形态 B：自建 Git + 本地 registry，
> 但**绝不用它的 Actions**，部署仍走本设计的 root runner，
> 权限边界保持不变（webhook 只写文件）。
