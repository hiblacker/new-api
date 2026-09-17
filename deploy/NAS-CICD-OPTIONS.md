# 群晖 NAS 自动化部署方案调研

> 目标：把 `custom/rc36-token-stats` 分支的改动自动部署到群晖 DS723+，
> 保留现有数据，且可回滚。

---

## 0. 你的环境（实测，非推测）

| 项 | 值 | 来源 |
|---|---|---|
| 型号 / 系统 | **DS723+ / DSM 7.4.1**（build 90080） | `cat /etc/VERSION` |
| SSH | **13022**，密钥登录 `hiblacker` | 实测登录成功 |
| 部署目录 | `/volume1/docker/new-apiv1` | 实测 |
| compose | `compose.yaml` + `.env`（PostgreSQL + Redis） | 实测 |
| 容器管理 | **Container Manager 已安装** | `/volume1/@appstore/ContainerManager` |
| docker 二进制 | `/volume1/@appstore/ContainerManager/usr/bin/docker`（软链 `/usr/local/bin/docker`） | 实测 |
| compose 二进制 | 同目录下有 `docker-compose`（legacy v1 风格） | 实测 |
| docker.sock | `srw-rw---- root:root`，**系统无 docker 组** | 实测 |
| 计划任务 CLI | **`/usr/syno/bin/synoschedtask` 存在** | 实测 |
| 数据持久化 | 全部 **bind mount**：`./postgres`、`./redis`、`./data`、`./logs` | 实测 |
| 资源 | **4 线程 / 17.9G 内存 / 3.1T 可用** | 实测 |
| NAS → `github.com` | ❌ **不可达** | 实测 curl |
| NAS → `auth.docker.io` | ❌ **不可达**（与工作站一致） | 实测 curl |
| NAS → `ghcr.io` | ⚠️ 可连（`/v2/` 405），但匿名 token 端点返回 403 | 实测 curl |
| NAS → `docker.m.daocloud.io` | ✅ **可达**（`/v2/` 401 = 正常需鉴权） | 实测 curl |
| NAS → `dockerproxy.com`、`hub-mirror.c.163.com` | ❌ 不可达 | 实测 curl |

**结论**：数据布局对自动化非常友好——全是 bind mount，备份 = 打包目录或 `pg_dump`，不涉及匿名卷。

---

## 1. 四个决定性约束

### 约束 1：docker 需要 root（最大的架构约束）

`docker.sock` 属 `root:root` 且无 `docker` 组，所以 `hiblacker` 通过 SSH 直接跑 docker 会 `permission denied`。
**任何自动化方案都必须先解决这一点**，三条突破口：

| 突破口 | 做法 | 影响 |
|---|---|---|
| **a. NOPASSWD sudoers** | 仅授权 `/usr/local/bin/docker` 一条命令 | 改动最小；需一次性 root 操作 |
| **b. DSM 计划任务** | 计划任务**本身以 root 执行**脚本 | **完全不用改 sudo**；天然 root |
| **c. 容器化 agent** | Portainer / 自建 runner 挂载 docker.sock | 自身以 root 跑；多一个常驻容器 |

> ⚠️ **约束 1b 是本方案的关键发现**：DSM 的计划任务能以 root 运行，
> 所以「在 NAS 上本地执行部署脚本」这条路线**根本不需要提权配置**。
> （需你在 DSM 界面确认计划任务的「用户」下拉可选 root —— 见第 5 节待确认项）

### 约束 2：NAS 的出网能力（已实测，这条最影响选型）

在 NAS 上实测的结果：

| 目标 | 结果 | 含义 |
|---|---|---|
| `github.com` | ❌ 不可达 | **NAS 上 `git clone/fetch` 走不通** |
| `auth.docker.io` | ❌ 不可达 | **NAS 无法从 Docker Hub 拉基础镜像** |
| `ghcr.io` | ⚠️ 可连但 token 端点 403 | GHCR 拉取不可靠，需专门验证 |
| `docker.m.daocloud.io` | ✅ 可达 | 走国内镜像源是唯一顺畅的拉取途径 |

→ **决定性推论**：
1. **不要在 NAS 上构建** —— 拉不到 `golang` / `oven/bun` / `debian` 基础镜像
   （除非在 Container Manager 里配好 daocloud 加速，且该配置需 root 才能确认）
2. **不要让 NAS 从 GitHub 拉代码**
3. **「能联网处构建 → 产物直推 NAS」是唯一不依赖任何 registry 的路线**

### 约束 3：必须固定版本、可回滚

上游 `calciumion/new-api:latest` 是可变标签，无法定位版本、无法回滚。
当前 `compose.yaml` 硬编码 `image: calciumion/new-api:v1.0.0-rc.36`。

→ 自动化方案必须做到：每次部署打**不可变 tag**，并保留上一个镜像用于回滚。

### 约束 4：数据安全红线

你自己在 `部署说明.txt` 里已经写明，我在方案里同样执行：

- **绝不 `docker compose down -v`**（`-v` 删数据卷）
- `POSTGRES_PASSWORD` 改 `.env` **不会**改旧库内密码（仅初始化空目录时生效）
- 不要删除 `postgres/`、`data/`、`redis/` 目录

---

## 2. 方案矩阵

| 方案 | 构建位置 | 触发方式 | 需改权限 | NAS 出网依赖 | 回滚 | 复杂度 |
|---|---|---|---|---|---|---|
| **A. CI 构建 + SSH 直传** | GitHub 托管机 | push tag | NOPASSWD 或计划任务 | **零依赖** ✅ | 好 | 低 |
| **B. CI 构建 + GHCR 拉取** | GitHub 托管机 | webhook / 轮询 | 同上 | ghcr.io（**实测不可靠**）⚠️ | 好 | 中 |
| **C. NAS 本地构建** | NAS 自己 | 计划任务轮询 | **不需要**（root 任务） | Docker Hub（**实测不可达**）❌ | 好 | 中 |
| **D. 自建 Gitea + Runner** | NAS 自己 | push | 需 docker 访问 | Docker Hub ❌ + 需自建 Gitea | 好 | 高 |
| **E. Portainer API/Webhook** | GH 或工作站 | HTTP 调用 | 不需要（Portainer 已是 root） | 需要 | 中 | 中 |
| **F. Watchtower 自动更新** | GH | 定时拉取 | 不需要 | registry ❌ | **差** ❌ | 低 |

---

## 3. 各方案详解

### 方案 A：CI 构建 + SSH 直传（**推荐主力**）

```
git push tag
   ↓
GitHub Actions: 跑测试 → docker build → docker save | gzip
   ↓  scp（走 13022）
NAS: docker load → docker compose up -d → 健康检查
   ↓
失败则 docker tag 回滚镜像 + up -d
```

**为什么推荐**：
- 完全绕开「NAS 拉境外 registry」这个最大风险点
- 复用已经打通的 SSH 通道（13022 + 密钥）
- GitHub 托管 runner 拉基础镜像很稳（实测本机不行，托管机没问题）

**需要做的**：
1. 把部署私钥存为 GitHub Secret（**不要**用你现在这把，另生成一把，权限可单独撤销）
2. 写一个 `deploy.yml` workflow
3. 解决约束 1（NOPASSWD 或改由计划任务触发）

**风险**：把 NAS 的 SSH 暴露给 GitHub Actions。缓解：
- 专用密钥 + 只允许该密钥执行 `docker` 相关命令
- 或不用 Actions 直连，改为 Actions 只产镜像，NAS 侧主动拉（方案 C/E）

---

### 方案 B：CI 构建 + GHCR，NAS 拉取

标准做法，但在你的网络下**最脆弱**：NAS 必须能访问 `ghcr.io`。
可配国内镜像加速，但 GHCR 没有稳定的公共镜像。

**仅在**你确认 NAS 能顺畅访问 ghcr.io 时选它。

触发 NAS 更新有三种：
1. Container Manager 项目的 **Webhook**（DSM 界面里对项目可生成 webhook URL）—— 需界面确认
2. DSM 计划任务定时 `docker compose pull && up -d`
3. Watchtower（见方案 F，不推荐）

---

### 方案 C：NAS 本地构建 + 计划任务（**零权限改动**）

```
DSM 计划任务（root，每日/每 5 分钟）
   ↓
git fetch；若 custom 分支有新 tag
   ↓
在 NAS 上 docker build（需 git + docker）
   ↓
docker compose up -d
```

**最大优势**：计划任务以 root 运行 → **完全不需要 NOPASSWD 配置**。

**最大代价**：DS723+ 是 2 核 Ryzen R1600，`bun run build` + `go build` 会吃满 CPU、
耗时可能 10–30 分钟，且需要 NAS 上有 git 和足够磁盘。
**不推荐作为构建主力**，但很适合作为**触发器和执行器**（构建仍放 CI，见方案 A+E 组合）。

---

### 方案 D：自建 Gitea + Actions Runner

在 NAS 上跑 Gitea + runner，全内网闭环。
**问题**：runner 需要 docker 权限；NAS 资源有限；维护成本高。
对**单机个人项目**属于过度工程。

---

### 方案 E：Portainer / Container Manager API 触发

部署一个 Portainer 容器（挂载 docker.sock，自身以 root 运行），
然后：
- CI 里 `curl <portainer-webhook>` 触发 stack 重新部署
- 或调 Portainer API

**优点**：CI 不需要 NAS 的 SSH 凭据，只需要一个 webhook URL（可随时重置）
**缺点**：多一个常驻容器；Portainer 本身是额外攻击面（务必只在内网、加认证）

> 这条路线对你可能比方案 A 更安全：**CI 拿到的是一个 webhook URL，而不是 NAS 的 shell 访问权**。

---

### 方案 F：Watchtower 自动更新

**不推荐**，理由：
- 它是「有新镜像就换」，与「固定 tag、可控回滚」直接冲突
- 你的 `compose.yaml` 用的是固定 tag，Watchtower 帮不上忙
- 出问题时无法判断跑的是哪版

---

## 4. 推荐路线（分阶段，不一步到位）

| 阶段 | 做什么 | 依赖 |
|---|---|---|
| **P0 今天** | 手工部署一次：`./deploy/nas.sh build/transfer/deploy` | 仅需解决约束 1 |
| **P1** | 加一条 NOPASSWD 只授权 docker（或改用计划任务触发） | 一次 root 操作 |
| **P2** | GitHub Actions：`push tag → 测试 → build → scp → load → up -d` | SSH 部署密钥存 Secret |
| **P3** | 若不想给 CI 服务器 shell 权限 → 改方案 E（webhook） | Portainer 容器 |
| **P4** | 备份自动化：计划任务每日 `pg_dump` + 保留 N 份 | 计划任务（root） |

**我的建议**：**P0 → P1 → P2**，等真觉得「AI 自动发版」有必要时再上 P3。
对你这个规模的部署，P2 已经足够，且调试成本最低。

---

## 5. 待你确认的三个点（我无法离线验证）

我用不了联网检索（web 搜索走的正是你自建的 new-api，当前无可用渠道返回 503），
所以以下三项需要你在 DSM 界面上确认：

1. **计划任务的「用户」是否可选 `root`**
   控制面板 → 任务计划 → 新增 → 计划的任务 → 用户定义的脚本 → 看「用户」下拉
   → 这决定方案 C 是否可行（**最省事的路线**）

2. **Container Manager 的项目是否支持 Webhook**
   Container Manager → 项目 → 选中项目 → 设置/常规 → 找 Webhook 开关
   → 这决定方案 B/E 的触发方式

3. ~~NAS 能否访问 github.com / ghcr.io~~ → **已实测**：
   GitHub ❌、Docker Hub auth ❌、ghcr.io ⚠️、daocloud 镜像源 ✅（见第 0、1 节）

4. **Container Manager 是否配了镜像加速**
   需 root 才能读 `/var/packages/ContainerManager/etc/dockerd.json`。
   这决定「NAS 本地构建」是否还有救（daocloud 源可达，但可能没接进 daemon）。

---

## 6. 所有方案共用的安全基线

无论选哪条，这几条都要落实：

| 项 | 做法 |
|---|---|
| 部署前备份 | pg_dump（`./deploy/nas.sh backup` 已实现） |
| 固定版本 | 每次部署打 `vX.Y.Z-custom.N` tag；镜像同名 tag |
| 回滚 | 切换前 `docker tag <当前镜像> new-api:rollback-*` |
| 禁止项 | 永不 `down -v`；不改旧库密码；不删数据目录 |
| 密钥隔离 | CI 用的 SSH 密钥与个人密钥分开，可单独吊销 |
| 凭证不入库 | `.env`、`nas.env` 都已在 `.gitignore` |
| 部署后验证 | `/api/status` + `CUSTOMIZATIONS.md` 的功能自检清单 |

---

## 7. 一句话结论

> **实测结论：NAS 既连不上 GitHub，也连不上 Docker Hub。**
> 所以「NAS 本地构建」和「NAS 拉 GHCR」两条路都不成立（除非先解决镜像加速）。
>
> **唯一零外部依赖的路线是方案 A**：
> 能联网的 CI（或你的工作站）构建 → 把镜像**直推**给 NAS（`docker save | ssh | docker load`）。
> 只依赖已经打通的 SSH 通道，不需要 NAS 能访问任何 registry。
>
> 触发与提权用 **DSM 计划任务（天然 root，零配置改动）** 或
> 一条**仅限 docker 的 NOPASSWD** 解决。
>
> Watchtower 这类「自动跟随 latest」的做法与可回滚目标冲突，排除。
