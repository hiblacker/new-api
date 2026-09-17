# 群晖 NAS 部署方案 · 第二轮调研

> 第一轮（`NAS-CICD-OPTIONS.md`）解决的是「有哪些路线」；
> 本轮在**计划任务可用 root** 这个新事实下，解决「具体怎么搭、权限边界画在哪」。

---

## 0. 本轮新增的实测事实

| 项 | 结果 | 影响 |
|---|---|---|
| 计划任务用户可选 **root** | ✅ 你已确认 | 解锁「NAS 侧以 root 执行部署」 |
| `synoschedtask --run id=<x>` | ✅ 命令存在，可**按需触发** | 部署可做到「准实时」，不必等轮询 |
| 非 root 调用 `--run` | ⚠️ 未报权限拒绝（只报任务不存在） | **有希望**，但需用真实任务实测（见 §6） |
| `docker compose` | ✅ **v2.20.1** 可用 | 可直接用 `docker compose`，非 legacy v1 |
| NAS → `ghproxy.net` | ✅ 200 | GitHub 代理可达 → **NAS 轮询 git 重开可能** |
| NAS → `gitee.com` | ✅ 200 | 可作为镜像仓库 |
| NAS → `docker.m.daocloud.io` | ✅ registry 行为正常 | 配好后 **NAS 本地构建重开可能** |
| NAS → `ghcr.io` token | ❌ DENIED | GHCR 拉取不可依赖 |
| 资源 | 4 线程 / 17.9G 内存 / 3.1T 可用 | 构建资源其实**足够** |

**对比第一轮的修正**：第一轮我判定「NAS 本地构建不成立」，那是基于
`auth.docker.io` 不可达。但 **daocloud 镜像源可达**，若在 Container Manager 里
配好镜像加速，本地构建是可行的（虽然仍然不推荐作为主力）。

---

## 1. 先厘清：NAS「自己拉」的三条路，各自缺什么

| 要拉的东西 | 直连 | 可用代理 | 结论 |
|---|---|---|---|
| GitHub 源码 | ❌ | ✅ `ghproxy.net` / `gitee.com` | **可行**，需把 remote 指到代理 |
| Docker Hub 基础镜像 | ❌ `auth.docker.io` | ✅ `docker.m.daocloud.io` | **可行**，需配镜像加速（要 root） |
| GHCR 成品镜像 | ⚠️ token DENIED | 未验证 | **不可依赖** |

→ **成品镜像不要走 registry，直接推**；源码/基础镜像可以走国内代理。

---

## 2. 四种架构（按「权限暴露面」从小到大排列）

### 架构 A：外部构建 + Drop-box + root 计划任务轮询 ⭐ 最小权限

```
[CI 或工作站]                          [NAS]
docker build
docker save | gzip
   │
   └── scp ──────────────────────►  /volume1/docker/new-apiv1/staging/
                                       image.tgz  +  pending.json
                                            │
                                            │  root 计划任务，每 2 分钟
                                            ▼
                                   检测 pending → 校验 → docker load
                                   → 备份 → compose up -d
                                   → 健康检查 → 写 result.json → 清 pending
```

**关键点**：SSH 密钥**只能写文件**，不直接执行任何特权命令。
提权只发生在 root cron 内部，且脚本是**固定内容**（不接受外部参数）。

- 权限暴露：🟢 最低（仅文件写入）
- 部署延迟：2 分钟以内（可调到 1 分钟）
- 依赖：无 registry、无 NAS 出网
- 代价：需要一个常驻 cron

### 架构 B：外部构建 + SSH 触发 root 计划任务 ⭐ 低延迟

```
[CI/工作站] scp 镜像 → ssh 'synoschedtask --run id=<部署任务>'
                                    │
                                    ▼
                          root 任务执行与架构 A 相同的脚本
```

- 权限暴露：🟡 低（能触发一个预定义任务，不能传任意命令）
- 延迟：秒级
- **前提**：非 root 用户确实能触发 root 任务（§6 待验证）

### 架构 C：外部构建 + NOPASSWD 仅授权 docker

```bash
echo 'hiblacker ALL=(ALL) NOPASSWD: /usr/local/bin/docker' | sudo tee /etc/sudoers.d/...
```

- 权限暴露：🔴 **最高** —— 见 §3，`docker` 权限等价于 root
- 优点：最直接，脚本改一行就能用
- 适用：只在内网、且你接受这个权限边界

### 架构 D：NAS 本地构建（需先配镜像加速）

```
NAS git fetch（走 ghproxy）→ docker build（走 daocloud 镜像源）→ compose up
```

- 权限暴露：🟢 低（全在 root cron 内）
- 依赖：**Container Manager 必须配好 daocloud 镜像加速**（读 daemon 配置需 root）
- 代价：每次部署消耗 NAS CPU 10–30 分钟
- 适用：你希望「NAS 完全自洽、不依赖外部机器」时

---

## 3. 安全分析：为什么 docker 权限 = root

这点必须说清楚，否则容易做出错误取舍：

> **能操作 docker daemon 的人，等价于拥有宿主机 root。**
> 因为可以 `docker run -v /:/host --privileged ...` 直接读写宿主文件系统。

因此：

| 做法 | 实际授予对方的能力 |
|---|---|
| NOPASSWD docker | **完整 root**（可绕道） |
| Drop-box（只写文件） | 只能影响「部署脚本会读的那几个文件」 |
| 触发预定义任务 | 只能触发固定行为 |

**结论**：如果 CI 或自动化工具的凭据可能泄露，
**架构 A/B 明显优于 C**。它们把「能不能执行特权操作」和「能不能传文件」分开了。

### 架构 A 的一个残余风险与缓解

如果外部能改写 `compose.yaml`，就能让 root 脚本启动任意特权容器 → 仍然提权。

**缓解措施**：
1. 部署脚本读**固定路径的模板**，不读 staging 里被推送的 compose
2. 或对 staging 里的文件做校验（只接受 `image.tgz`，compose 由 root 侧维护）
3. staging 目录权限设为 `hiblacker:users 700`，且脚本校验文件属主

---

## 4. 推荐架构的具体设计（架构 A）

### 4.1 NAS 侧文件布局

```
/volume1/docker/new-apiv1/
├── compose.yaml              # root 侧维护，把 image 改为 ${NEWAPI_IMAGE:-...}
├── .env                      # 现有，不动
├── postgres/ redis/ data/ logs/   # 数据，不动
├── staging/                  # ← SSH 用户可写
│   ├── image.tgz             #    待部署镜像
│   └── pending.json          #    {tag, 时间戳}
└── deploy/
    ├── deploy.sh             # ← root 拥有，755，只读执行
    ├── backups/              #    pg_dump 落地
    └── result.json           #    最近一次结果（供外部读取）
```

### 4.2 root 计划任务脚本骨架

```bash
#!/bin/bash
# /volume1/docker/new-apiv1/deploy/deploy.sh   —— 属主 root:root 755
set -euo pipefail
BASE=/volume1/docker/new-apiv1
STAGING="$BASE/staging"
export PATH=/usr/local/bin:$PATH

[ -f "$STAGING/pending.json" ] || exit 0     # 无待部署任务直接退出

# 1) 只接受本用户推送的文件
[ "$(stat -c %U "$STAGING/image.tgz")" = "hiblacker" ] || exit 1

TAG=$(sed -n 's/.*"tag":[[:space:]]*"\([^"]*\)".*/\1/p' "$STAGING/pending.json")
[ -n "$TAG" ] || exit 1

# 2) 部署前备份（失败即中止）
docker exec "$(docker ps -qf label=com.docker.compose.service=postgres)" \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip > "$BASE/deploy/backups/pg-$(date +%F-%H%M%S).sql.gz"

# 3) 记录回滚点 + 载入新镜像
CUR=$(docker inspect "$(docker ps -qf label=com.docker.compose.service=new-api)" \
      --format '{{.Config.Image}}' || true)
[ -n "$CUR" ] && docker tag "$CUR" new-api:rollback

gunzip -c "$STAGING/image.tgz" | docker load
rm -f "$STAGING/image.tgz" "$STAGING/pending.json"

# 4) 重建（永不 down -v）并做健康检查
cd "$BASE"
NEWAPI_IMAGE="$TAG" docker compose --env-file .env -f compose.yaml up -d

sleep 10
if curl -fsS -m 10 http://127.0.0.1:53130/api/status >/dev/null; then
  echo "{\"ok\":true,\"tag\":\"$TAG\",\"at\":\"$(date -Iseconds)\"}" > "$BASE/deploy/result.json"
else
  echo "{\"ok\":false,\"tag\":\"$TAG\",\"at\":\"$(date -Iseconds)\"}" > "$BASE/deploy/result.json"
  docker tag new-api:rollback "$CUR" && NEWAPI_IMAGE="$CUR" \
    docker compose --env-file .env -f compose.yaml up -d
fi
```

### 4.3 外部（CI / 工作站）

```bash
./deploy/nas.sh build                    # 本地构建
scp image.tgz  → staging/
scp pending.json → staging/              # 触发部署
# 轮询 result.json 判断结果（或等下一次 cron）
```

**这正是 `deploy/nas.sh` 的 `transfer` 子命令要改成的形态** —— 从「直接 docker load」
改成「写 staging + 等 result」，从而不需要任何提权。

---

## 5. 四条路线总对照

| | A drop-box | B 触发任务 | C NOPASSWD | D NAS 构建 |
|---|---|---|---|---|
| 权限暴露面 | 🟢 最小 | 🟡 小 | 🔴 最大 | 🟢 小 |
| 部署延迟 | ≤2 min | 秒级 | 秒级 | 10–30 min |
| 需要 NAS 出网 | 否 | 否 | 否 | ✅ 需要（配代理+镜像源） |
| 需要改 sudo | 否 | 否 | ✅ 是 | 否 |
| 需要容器 | 否 | 否 | 否 | 否 |
| 外部机器依赖 | ✅ 需要 | ✅ 需要 | ✅ 需要 | 不需要 |
| 待验证 | — | `--run` 权限 | — | daemon 镜像源配置 |

---

## 6. 仍需验证的两点（附验证方法）

### 6.1 非 root 能否触发 root 计划任务（决定架构 B 是否可用）

请在 DSM **任务计划** 里建一个测试任务（用户选 `root`）：

```bash
# 任务内容
echo "$(date) triggered" >> /volume1/docker/new-apiv1/deploy/trigger-test.log
```

然后在 SSH 里查任务 ID 并触发：

```bash
sudo /usr/syno/bin/synoschedtask --get        # 需要一次密码，或看 DSM 界面里的 ID
/usr/syno/bin/synoschedtask --run id=<ID>     # ← 关键：不带 sudo
cat /volume1/docker/new-apiv1/deploy/trigger-test.log
```

- 日志出现新行 → **架构 B 可用**（低延迟，且不需要 NOPASSWD）
- 报权限错误 → 退回架构 A（轮询）

### 6.2 Container Manager 的镜像加速配置（决定架构 D 是否可用）

```bash
# 需 root
sudo cat /var/packages/ContainerManager/etc/dockerd.json
```

若 `registry-mirrors` 里有 `https://docker.m.daocloud.io`，则 NAS 本地构建可行。

---

## 7. 结论与建议

1. **成品镜像不要走任何 registry** —— GHCR token 被拒、Docker Hub 不可达，
   而 `docker save | ssh` 这条路已验证可用，零外部依赖。

2. **提权放在 NAS 侧的固定脚本里，不要给外部凭据**。
   推荐 **架构 A（drop-box + root cron）**：SSH 密钥只能写文件，
   特权操作只在 root cron 内以固定逻辑发生。

3. **若 §6.1 验证通过，升级到架构 B**：把轮询换成 `synoschedtask --run`，
   延迟从 2 分钟降到秒级，权限边界不变。

4. **架构 C（NOPASSWD docker）只作为临时手段** —— 它等价于把 root 交给 SSH 密钥。

5. **架构 D 仅在**你希望 NAS 完全自洽、且愿意配镜像加速时考虑；
   构建慢但权限边界干净。

6. **无论选哪个**：部署前 `pg_dump` 备份、固定 tag、保留 rollback 镜像、
   永不 `docker compose down -v`（这条你的 `部署说明.txt` 里也写了）。


---

# 第三轮补充：外部调研 + 实测修正

> 本轮联网检索了群晖 NAS 上的 CI/CD 实践，并在 NAS 上补测了镜像源与引擎版本。
> **其中两条结论修正了本文件前面的判断。**

## 8. 镜像源实测：9 个里只有 3 个活着

你的 `dockerd.json` 配了 9 个加速源，逐个实测结果：

| 镜像源 | 结果 |
|---|---|
| `docker.m.daocloud.io` | ✅ 401（registry 正常） |
| `docker.jianmuhub.com` | ✅ 401 |
| `dockerhub1.beget.com` | ✅ 200 |
| `dockerhub.azk8s.cn` | ⚠️ 403（该服务早已停止） |
| `hub-mirror.c.163.com` | ❌ 不可达 |
| `mirror.ccs.tencentyun.com` | ❌ 不可达（仅腾讯云内网可用） |
| `huecker.io` / `dockerhub.timeweb.cloud` / `noohub.ru` | ❌ 不可达 |

### ⚠️ 修正结论 1：**NAS 本地构建是可行的**

第一轮我判定「NAS 无法本地构建」，依据是 `auth.docker.io` 不可达。
但 `dockerd.json` 里已配好加速源，且其中 **3 个实测可用** →
**NAS 能拉取 `golang` / `oven/bun` / `debian` 等基础镜像，架构 D 成立。**

代价仍是速度（4 线程，构建 10–30 分钟）与对 NAS 的负载。

## 9. 引擎版本：**Docker 24.0.2（老旧）**

实测：`Docker version 24.0.2, build 610b8d0` / `containerd 1.7.1` / `compose v2.20.1`。

外部调研明确指出群晖 Container Manager 长期停留在 **Docker 24.0.2**，
**上游自 2024 年 6 月起已不再支持该版本**。可能的影响：

- 缺少两年多的安全补丁
- 较新的 BuildKit / compose 语法可能不支持
- 本仓库的 `Dockerfile` 用了 buildx + digest 固定基础镜像，**在 24.0.2 上需实测确认**

→ 这也是「**构建放在外部、NAS 只负责运行**」更稳的另一个理由。

## 10. ⚠️ 修正结论 2：Portainer 的 stack webhook 是**商业版功能**

第一轮我把「Portainer webhook」列为方案 E 的推荐路径。
外部资料确认：**Portainer CE 的 stack webhook 属于 Business Edition 功能**，
CE 需要额外的社区 sidecar（如 `aklinker1/portainer-stack-webhook`）才能实现等价能力。

→ 方案 E 的落地成本被低估了，**降级为备选**。

## 11. 外部调研印证了主结论

一份针对「群晖上的 CI/CD」的深度调研，其结论与本文件一致：

| 外部结论 | 与本文件的关系 |
|---|---|
| 推荐组合是 **Container Manager + Compose + 一个 bash 部署脚本** | 与本文件 §4 推荐一致 ✅ |
| Coolify / Dokploy / k3s **在 DSM 上跑不起来**（安装器失败、引擎版本冲突、内核模块缺失） | 印证「不要自建 PaaS」 |
| Container Manager 的 **UI 无法认证 GHCR**（`Registry returned bad result`），但 CLI 可以 | 与我们的 ghcr 实测一致 |
| **Task Scheduler 默认以 root 运行** | 印证本文件的核心手段 ✅ |
| 自托管 GitHub Runner **只适合私有仓库**（公开仓库有 forker 执行恶意 workflow 的风险） | 排除架构 D 的 runner 变体 |
| 群晖 SSH 的 **home 目录权限若为 777 会静默破坏密钥认证**（需 755 / `.ssh` 755 / `authorized_keys` 644） | 新增注意事项，见 §13 |
| **BTRFS 快照可能吃掉整个卷**（有案例在 10.5T 卷上累积 4.7T 快照） | 新增风险，见 §13 |

## 12. ⚠️ 安全：`synoschedtask --run` 曾被恶意软件滥用

检索中出现一条社区帖子，标题为
「**Malware Warning - `/usr/syno/bin/synoschedtask --run id=1`**」。
该页面正文我未能抓取（只返回了站点外壳），所以**无法确认细节**，
但标题本身是一个明确信号：**用计划任务做提权/持久化是已被滥用的手法**。

### 这对架构 A / B 的影响

我前面说架构 A「SSH 密钥只能写文件、权限最小」——这个说法**需要收紧**：

- 你的 SSH 账号本身是 **administrators**，它是否能触发 root 计划任务尚未验证
- 若**普通用户也能 `synoschedtask --run`**，那么持有该 SSH 凭据 ≈ 持有 root
  → 架构 A 与架构 C 的权限差距**没有我说的那么大**

**修正后的建议**：

| | 修正前 | 修正后 |
|---|---|---|
| 架构 A（drop-box） | 🟢 最小权限 | 🟡 权限取决于该账号能否触发任务 |
| 架构 B（触发任务） | 低延迟升级选项 | ⚠️ 同时也是一个**提权面**，需谨慎 |

**真正能收紧权限的做法**（如果你在意这个边界）：
1. 在 DSM 计划任务里，脚本**只读固定路径**的 `compose.yaml`，绝不读取 staging 里传入的文件
2. staging 目录设为 `hiblacker:users 700`，脚本校验推送文件的属主
3. 给 CI 单独建一个**非 administrators** 的 DSM 账号，只用它做文件投递

## 13. 两个新增的运维风险（来自外部案例）

### 13.1 BTRFS 快照可能吃满卷

你的 docker data-root 在 btrfs 上（`/var/packages/ContainerManager/var/docker`）。
外部案例：有用户在 10.5T 卷上累积了 **4.7T 的 `@docker` 快照**，
且激进清理导致**所有容器损坏**。

→ 建议：定期 `du`/快照配额监控，**不要**盲目批量删快照。

### 13.2 定期清理是必需项

镜像与构建缓存会持续累积。推荐用计划任务（root）跑：

```bash
docker image prune -f --filter "until=168h"    # 保留一周
docker builder prune -f --filter "until=168h"
```

注意：**不要**用 `docker system prune -a`，它会删掉 rollback 镜像，
破坏「可回滚」这个核心保障。

## 14. 更新后的最终建议

1. **构建放外部**（CI 或工作站）→ 仍然首选。
   理由更新为：不仅因为 NAS 连不上 Docker Hub，更因为**NAS 的引擎是 24.0.2**，
   在旧引擎上构建现代镜像有额外不确定性。

2. **交付方式二选一**（都不依赖 NAS 出网）：
   - 首选：`docker save | ssh | docker load`（`deploy/nas.sh transfer` 已实现）
   - 备选：推到 **GHCR**，NAS 侧 `docker compose pull`（外部资料称 CLI 可用、UI 不行）
     —— 但我们的实测是 ghcr token 被拒，**需先验证**

3. **触发与提权**：计划任务以 root 运行，这是既定事实；
   但**不要把它当作"安全的提权边界"**（见 §12）。
   若希望权限边界清晰，采用 §12 的三条收紧措施。

4. **补充运维自动化**（计划任务，root）：
   - 每日 `pg_dump` 备份 + 保留 N 份
   - 每周 `docker image/builder prune`（**排除 rollback 镜像**）
   - 快照容量监控

5. **明确的排除项**：Coolify、Dokploy、k3s、自托管 Runner（公开仓库）、
   Watchtower、Portainer CE webhook（需商业版）。
