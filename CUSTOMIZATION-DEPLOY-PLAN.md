# new-api 定制化：提交、CI/CD 与 NAS 部署方案

> 面向场景：你在 `v1.0.0-rc.36` 上做了概览页 Token 统计改造，希望①改动可版本化，
> ②未来能持续合并上游最新代码，③自动部署到 NAS，④保住现有服务数据。

---

## 0. 现状与两个决定性结论

### 0.1 当前仓库状态（已核实）

| 项 | 状态 |
|---|---|
| 仓库根目录 | **本工作区根目录**（已与上游结构一致，无 `src/`、`rc36/` 嵌套） |
| 分支 | `custom/rc36-token-stats`（基于 tag `v1.0.0-rc.36`） |
| 远端 | `origin` = 你的 fork，`upstream` = `QuantumNous/new-api` |
| 提交 | 已拆成 4 个提交并推送；tag `v1.0.0-rc.36-custom.1` |
| 历史 | **完整历史**（非浅克隆），可直接 rebase

### 0.2 结论一：本次改动 **零数据库变更** ✅

已核实：**没有**改动 `model/`、`setting/`、`service/`、`main.go`，没有任何 `AutoMigrate` 变化。

- 后端只改了 `controller/log.go` 的两处**查询响应**（把已存在的 `SumUsedToken` 接出来）
- 其余全是前端

**这意味着换镜像时数据库结构完全兼容，现有数据一条都不会动，不需要任何数据迁移脚本。**

### 0.3 结论二：必须先建分支，再谈 CI/CD

游离 HEAD 上无法安全地做 rebase/合并。**第一步就是把改动落到命名分支上。**

---

## 1. 提交方案（为「持续合并上游」而设计）

### 1.1 仓库拓扑

```
upstream  →  github.com/QuantumNous/new-api   （只读，拉取用）
origin    →  你自己的 fork / 自建 Gitea         （可写，推送用）
```

> 注意：你当前的 `origin` 指向 `Calcium-Ion/new-api.git`，该地址已 301 重定向到
> `QuantumNous/new-api`。建议直接改名为 `upstream`，把 `origin` 留给自己的 fork。

> ✅ 这一步**已经完成**，保留在此作为说明。当前仓库状态见 0.1。

```bash
# 已完成，无需重做
git remote -v          # origin=你的 fork, upstream=QuantumNous
git branch --show-current
git tag --list 'v1.0.0-rc.36*'
```

### 1.2 提交拆分（建议 4 个提交）

拆成**可直接构建、职责单一**的提交，而不是一个巨型提交。这样将来 cherry-pick / rebase
可以按需取舍，冲突也更容易定位。

| # | 提交信息 | 包含文件 |
|---|---|---|
| 1 | `feat(controller): report token usage in log statistics endpoints` | `controller/log.go`、`controller/log_stat_test.go` |
| 2 | `feat(web): add token usage cards and per-model chart to the overview` | `features/dashboard/**`、`features/usage-logs/{types,constants}.ts`、`styles/*.css`、`i18n/locales/*.json` |
| 3 | `test(web): cover token usage aggregation, chart behaviour and cards` | 3 个新测试文件 + `setup-guide.test.tsx` + `test-setup.ts` |
| 4 | `docs: record customizations and upgrade notes` | 新增 `CUSTOMIZATIONS.md`（见 1.5） |

> 第 2 个提交同时含 i18n，是为了保证**每个提交都能独立构建**（否则中间提交会缺翻译键）。
> 虽然 i18n 通常单独提交，但这里拆开会让 2、3 号提交处于不可用状态，得不偿失。

```bash
# 示例：按上表分批 add + commit
git add controller/log.go controller/log_stat_test.go
git commit -m "feat(controller): report token usage in log statistics endpoints"
# ... 其余同理
```

**打标签**（把「代码版本」和「部署版本」绑定）：

```bash
git tag -a v1.0.0-rc.36-custom.1 -m "rc.36 + overview token stats"
git push -u origin custom/rc36-token-stats --tags
```

### 1.3 后续合并上游的流程（每轮升级照做）

推荐 **rebase-onto-新 tag** 而非 `merge upstream/main`：

```bash
git fetch upstream --tags

# 以新 tag 为基线，重放你的提交
git switch -c custom/rc37 v1.0.0-rc.37
git rebase --onto v1.0.0-rc.37 v1.0.0-rc.36 custom/rc36-token-stats
```

**为什么用 rebase 而不是 merge**：
- 你的定制是**小范围补丁**，不是长期分叉。rebase 后历史是一条直线，你的改动永远"骑"在最新上游之上
- `merge upstream/main` 会让 `main` 的每次提交都进入你的历史，冲突会在**每次合并**时反复出现
- rebase 时冲突集中在**同几处**，且只处理一次

**每轮升级的验证清单**（缺一不可）：

```bash
cd web && bun install --frozen-lockfile
bun run typecheck
bun run lint            # 全量 lint 噪声大，至少对涉及文件跑
bun run test
cd .. && go build ./...
```

> 注意：`go build ./...` 需要 `web/dist` 存在（`main.go` 用了 `//go:embed web/dist`），
> 所以要先 `bun run build`。

### 1.4 冲突热点（提前知道，别慌）

| 文件 | 为什么容易冲突 | 缓解 |
|---|---|---|
| `web/src/i18n/locales/*.json` | 上游频繁增删键；文件巨大 | 冲突时优先接受上游版本，然后 `bun run i18n:sync` 归一化；你的键在文件**末尾**，通常不冲突 |
| `summary-cards.tsx` | 概览页上游改动活跃 | 你重写过此文件，冲突需手工合并 |
| `stat-card.tsx` | 你加了 `accent-4` 色调与 `action` 插槽 | 冲突范围小 |
| `consumption-distribution-chart.tsx` | 你抽了 `use-vchart-theme` | 冲突范围小 |
| `controller/log.go` | 上游可能重构日志统计 | 改动仅 4 行，易解 |

### 1.5 必备：`CUSTOMIZATIONS.md`

在仓库根放一份清单，升级时按它逐项核对「我的定制还在不在」：

```markdown
# 本仓库相对上游的定制

基线：v1.0.0-rc.36
分支：custom/rc36-token-stats

## 1. 概览页 Token 统计（核心）
- 后端：/api/log/self/stat 与 /api/log/stat 新增响应字段 token
- 前端：概览页「用量概览」4 张卡；新增「各模型 Token 用量」柱状图
- 关键文件：token-usage-chart.tsx / lib/token-usage.ts

## 2. 新增 i18n 键（勿删）
Per Hour / Per Day / Per Week / Per Month / Granularity: /
Token Usage / Token Usage by Model / All Time / 90 Days /
Monitor token usage and request volume / 等

## 3. 共享组件改动
- StatCardTone 扩展 accent-4（stat-card.tsx + theme.css + theme-presets.css）
- 新增 ui/section-divider.tsx（models-filter-dialog 也改为复用它）

## 4. 测试基建
- test-setup.ts 增加 nsSeparator: false（对齐 src/i18n/config.ts）

## 升级后自检
- [ ] 概览页 4 张卡存在，第 1 张有【近24小时/今天】切换
- [ ] 「各模型 Token 用量」面板存在，头部显示「粒度：X」
- [ ] 选「全部」时 X 轴覆盖近半年、默认月聚合
- [ ] 第 4 张卡（Token 总计）有数字（说明后端字段还在）
```

---

## 2. CI/CD 方案

### 2.1 你的约束

- 部署目标是 **NAS（192.168.1.10）**，Docker 部署
- 本机访问 Docker Hub 不稳定（本次实测 `auth.docker.io` 多次超时）
- 镜像构建必须拉 `golang:1.26.1-alpine`、`oven/bun:1.4.0`、`debian:bookworm-slim` 三个基础镜像

**因此「在哪构建」比「怎么触发」更关键。**

### 2.2 三条路线对比

| | A. NAS 自建 Gitea + Runner | B. GitHub Actions → GHCR | C. 本地构建 + save/load |
|---|---|---|---|
| 构建位置 | NAS 本地 | GitHub 托管机 | 你的工作站 |
| 基础镜像拉取 | 走 NAS 网络（需镜像加速） | ✅ 畅通 | 走工作站网络 |
| NAS 拉镜像 | **不需要**（本地构建） | ⚠️ 需能访问 GHCR（国内常需代理） | **不需要**（docker load） |
| 自动化程度 | 高（push 即部署） | 高 | 低（手工两步） |
| NAS 负担 | 高（Go 编译 + 前端构建吃 CPU/内存） | 无 | 无 |
| 落地难度 | 中 | 低 | **最低** |

### 2.3 推荐：**B 为主 + C 兜底**（务实组合）

理由：GitHub 托管 runner 拉取基础镜像稳定，构建不吃 NAS 资源；NAS 侧只需 `docker compose pull`。
若 NAS 拉 GHCR 不稳，用 route C 兜底（或给 NAS 配镜像代理）。

#### 路线 B：GitHub Actions 构建并推送

`.github/workflows/custom-build.yml`：

```yaml
name: build custom image

on:
  push:
    tags: ['v*-custom.*']
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.4.0 }
      - name: frontend checks
        working-directory: web
        run: |
          bun install --frozen-lockfile
          bun run typecheck
          bun run test
      - uses: actions/setup-go@v5
        with: { go-version: '1.26.x' }
      - name: backend build
        run: |
          cd web && bun run build && cd ..
          go build ./...

  build:
    needs: verify
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.ref_name }}
            ghcr.io/${{ github.repository }}:latest-custom
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

> 关键点：**先 verify 再 build**。你的仓库带着测试，CI 应该在构建镜像前拦住回归。

#### NAS 侧部署

`docker-compose.yml`（把你原有的 env/volume 原样保留，只改 image 为固定 tag）：

```yaml
services:
  new-api:
    image: ghcr.io/<你>/new-api:v1.0.0-rc.36-custom.1   # 固定 tag，不用 latest
    container_name: new-api
    restart: always
    ports:
      - "53130:3000"
    environment:
      - TZ=Asia/Shanghai
      # ↓↓↓ 你原有的配置，务必原样搬过来（尤其 SQL_DSN）
      # - SQL_DSN=...
    volumes:
      - ./data:/data          # ← 数据卷，绝不可删
```

```bash
docker compose pull && docker compose up -d
```

⚠️ **绝对不要用 `docker compose down -v`** —— `-v` 会删除数据卷，那才是真正的数据丢失。

#### 路线 C：兜底（NAS 拉不动镜像时）

```bash
# 工作站
docker build -t new-api:v1.0.0-rc.36-custom.1 .
docker save new-api:v1.0.0-rc.36-custom.1 | gzip > new-api-custom.tgz

# 传到 NAS 并载入
scp new-api-custom.tgz <nas>:/volume1/docker/new-api/
ssh <nas> 'cd /volume1/docker/new-api && gunzip -c new-api-custom.tgz | docker load'
ssh <nas> 'cd /volume1/docker/new-api && docker compose up -d'
```

### 2.4 版本策略

| 类型 | 示例 | 用途 |
|---|---|---|
| 上游 tag | `v1.0.0-rc.36` | 只读基线，不部署 |
| 你的 tag | `v1.0.0-rc.36-custom.1` | **实际部署**，后缀递增 |
| 你的 tag | `v1.0.0-rc.37-custom.1` | 升级到新上游后重新计数 |

**永远部署带 `-custom.N` 的 tag，不要在 NAS 上用 `latest`** —— 否则出问题时无法判断跑的是哪版。

---

## 3. NAS 部署与数据保留

### 3.1 先摸清现状（在 NAS 上执行）

```bash
# 1) 找到容器与当前镜像
docker ps --format '{{.Names}}\t{{.Image}}' | grep -iE 'new-api|newapi'

# 2) 数据卷挂载在哪（最关键的一步）
docker inspect new-api --format '{{json .Mounts}}' | python3 -m json.tool

# 3) 数据库类型与连接串
docker inspect new-api --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -Ei 'dsn|sql|redis|data|log'

# 4) compose 文件位置（方便以后改 image）
docker inspect new-api \
  --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
```

**判读 `SQL_DSN`**：

| 情况 | 数据在哪 | 备份方式 |
|---|---|---|
| 无 `SQL_DSN` 或 `sqlite` | 容器内 `/data/*.db`（通常挂在宿主机某目录） | 直接复制 `.db` 文件 |
| `mysql://...` | 独立的 MySQL 容器/服务 | `mysqldump` |
| `postgres://...` | 独立 PG 服务 | `pg_dump` |

> 本机实测你的实例 `/api/status` 返回 `enable_data_export: true`，说明
> `quota_data` 聚合表在工作——**这是概览页与柱状图的数据来源，务必在备份范围内**。

### 3.2 备份（部署前必做）

```bash
# SQLite 场景（示例路径以 3.1 实际结果为准）
docker stop new-api
cp /volume1/docker/new-api/data/one-api.db \
   /volume1/docker/new-api/data/one-api.db.bak-$(date +%F)
docker start new-api

# MySQL 场景
docker exec <mysql容器> mysqldump -uroot -p'<密码>' --single-transaction \
  --routines --triggers <库名> | gzip > newapi-$(date +%F).sql.gz
```

**同时记录旧镜像，便于秒级回滚**：

```bash
docker tag new-api:v1.0.0-rc.36 new-api:rollback-rc36
```

### 3.3 部署步骤

```bash
cd <compose 目录>

# 1) 备份旧镜像 tag（若 3.2 未做）
docker tag "$(docker inspect new-api --format '{{.Config.Image}}')" new-api:rollback-rc36

# 2) 改 docker-compose.yml 里的 image 为新 tag

# 3) 拉取并重建容器（保留同一 volumes，数据不动）
docker compose pull
docker compose up -d

# 4) 验证
docker compose logs -f --tail=50 new-api
curl -s http://192.168.1.10:53130/api/status | head -c 300
```

**因为本次改动零 schema 变更**，容器启动时 `AutoMigrate` 不会做任何结构变更，
现有数据（用户、令牌、渠道、`logs`、`quota_data`）全部原样保留。

### 3.3.1 已备好的本地工具：`deploy/nas.sh`

为避免手敲长命令，仓库里带了配置 + 脚本：

```bash
cp deploy/nas.env.example deploy/nas.env   # 首次
vim deploy/nas.env                          # 填 DSM 账号、部署目录

./deploy/nas.sh check      # 连通性与配置自检（会先探测 SSH 端口）
./deploy/nas.sh init-key   # 生成专用 SSH 密钥并打印公钥
./deploy/nas.sh recon      # 抓取容器挂载/环境变量 → 判断数据库类型与卷路径
./deploy/nas.sh backup     # 备份数据库（自动识别 SQLite / PostgreSQL）
./deploy/nas.sh build      # 本地构建镜像
./deploy/nas.sh transfer   # docker save | ssh | docker load
./deploy/nas.sh deploy     # 切换镜像并重建容器（只 up -d，绝不动数据卷）
./deploy/nas.sh rollback   # 回滚到上一个镜像
./deploy/nas.sh logs       # 跟踪容器日志
```

- `deploy/nas.env` 已被 `.gitignore` 忽略，不会提交
- `deploy/nas.sh` 的 `deploy` 子命令**永远不会**执行 `docker compose down -v`
- 部署前会强制检查 compose 是否使用 `${NEWAPI_IMAGE}` 变量，避免误改错版本

**前置条件（群晖）**：控制面板 → 终端机和 SNMP → 勾选「启动 SSH 功能」。
然后把 `init-key` 打印的公钥加到：控制面板 → 用户与群组 → 你的账号 → 编辑 → 高级 → 用户密钥。

### 3.4 部署后自检清单

- [ ] 能正常登录（用户表完好）
- [ ] 概览页出现 **4 张卡**，第 1 张右上角有【近 24 小时 / 今天】切换
- [ ] 第 4 张「Token 总计」**有数字**（证明后端 `token` 字段生效）
- [ ] 「各模型 Token 用量」柱状图有数据；切「全部」时 X 轴覆盖近半年
- [ ] 使用日志页仍正常（`LogStatistics` 类型新增了字段）
- [ ] 数据看板页正常（`models-filter-dialog` 有改动）

### 3.5 回滚（1 分钟内）

```bash
# docker-compose.yml 把 image 改回 new-api:rollback-rc36
docker compose up -d
```

> 因为零 schema 变更，**回滚不需要恢复数据库**，这是本次改造最大的安全边际。

---

## 4. 建议的执行顺序

| 阶段 | 动作 | 产出 |
|---|---|---|
| **P0（今天）** | 建分支 + 4 个提交 + 打 tag | 改动不再有丢失风险 |
| **P1** | 建 fork/自建 Gitea，`origin` 指向它，push | 代码有远端备份 |
| **P2** | 按 3.1 摸清 NAS 的 DB 类型与卷路径，做一次备份 | 有可回滚的数据快照 |
| **P3** | 按路线 C 手工构建 + `save/load` 部署一次 | 验证改动在生产可用 |
| **P4** | 加 `CUSTOMIZATIONS.md` | 升级有据可依 |
| **P5** | 接 GitHub Actions（路线 B） | 自动化构建 |
| **P6** | NAS 侧 compose 固定 tag + 一键 `pull && up` | 半自动发布 |
| **P7** | 真跑一次上游升级（如 rc.37），按 1.3 流程走 | 验证升级路径可行 |

---

## 5. 三个最容易踩的坑

1. **游离 HEAD 上直接开发** → 一次误 `checkout` 全部改动消失。**P0 必须先做。**
2. **`docker compose down -v`** → 删数据卷，真·数据丢失。**永远只用 `up -d`。**
3. **在 NAS 上用 `latest` tag** → 出问题无法定位版本、无法回滚。**固定 `-custom.N` tag。**

---

## 附：一条命令确认「不需要迁移数据」

```bash
git diff --name-only v1.0.0-rc.36 -- model/ setting/ service/ main.go
# 输出为空 == 零 schema 变更 == 数据天然兼容
```
