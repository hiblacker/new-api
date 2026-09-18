# new-api 群晖 NAS 部署说明

当前部署方式是在本机完成镜像构建，通过 SSH 将镜像文件传到 NAS，再由 NAS 上的固定脚本以 root 权限完成备份、更新、健康检查和失败回滚。NAS 不需要拉取源码或成品镜像。

## 前置条件

- 本机已安装并启动 Docker，能够执行 `docker info`。
- NAS 已安装 Container Manager，并已启用 SSH。
- NAS 上已有可正常运行的 `compose.yaml` 和 `.env`。
- Compose 中的应用服务名为 `new-api`，数据库服务名为 `postgres`。
- DSM 登录账号可以通过 `sudo` 执行 root 命令。

部署脚本不会执行 `docker compose down -v`，不会删除数据卷。

## 首次配置

创建本地配置：

```bash
cp deploy/nas.env.example deploy/nas.env
```

修改 `deploy/nas.env`：

```dotenv
NAS_HOST=192.168.1.10
NAS_SSH_PORT=22
NAS_SSH_USER=<DSM 登录账号>
NAS_SSH_KEY=~/.ssh/id_ed25519_newapi_nas

NAS_DEPLOY_DIR=/volume1/docker/new-apiv1
NAS_COMPOSE_FILE=compose.yaml
NAS_API_URL=http://192.168.1.10:53130

IMAGE_NAME=new-api
IMAGE_TAG=
```

`IMAGE_TAG` 留空时，每次部署自动生成 `local-YYYYMMDD-HHMMSS`。只有需要固定版本名时才填写。`deploy/nas.env` 已被 Git 忽略。

如果尚未配置 SSH 密钥：

```bash
./deploy/nas.sh init-key
```

将输出的公钥添加到 DSM 登录账号，然后执行自检：

```bash
./deploy/nas.sh check
```

## 一键部署

网络可以访问 Docker Hub 时：

```bash
./deploy/nas.sh deploy
```

Docker Hub 认证或拉取超时时，使用镜像源构建：

```bash
./deploy/nas.sh deploy --mirror
```

镜像源构建使用以下版本标签，不使用 digest：

```text
docker.m.daocloud.io/oven/bun:1.4.0
docker.m.daocloud.io/library/golang:1.26.1-alpine
docker.m.daocloud.io/library/debian:bookworm-slim
```

如需提前拉取：

```bash
docker pull docker.m.daocloud.io/oven/bun:1.4.0
docker pull docker.m.daocloud.io/library/golang:1.26.1-alpine
docker pull docker.m.daocloud.io/library/debian:bookworm-slim
```

部署流程如下：

1. 检查并按需修补 NAS 上的 Compose 镜像变量，同时保留原文件备份。
2. 将 `remote-deploy.sh` 上传到 NAS。
3. 在本机构建并导出镜像。
4. 通过 SCP 将压缩镜像传到 NAS。
5. 提示输入一次 NAS sudo 密码。
6. 记录回滚镜像、备份 PostgreSQL、载入新镜像并重建应用容器。
7. 检查 `/api/status`；新版本不健康时自动回滚。

## 日常操作

```bash
./deploy/nas.sh rollback  # 回滚到上一个成功部署的镜像
./deploy/nas.sh backup    # 立即备份 PostgreSQL
./deploy/nas.sh logs      # 查看应用容器最近 200 行日志
./deploy/nas.sh recon     # 查看容器、镜像、挂载和磁盘信息
./deploy/nas.sh prune     # 清理 168 小时以上的悬空镜像和构建缓存
```

备份保存在 NAS 的 `<NAS_DEPLOY_DIR>/deploy/backups/`，最多保留最近 10 份。部署日志保存在 `<NAS_DEPLOY_DIR>/deploy/remote-deploy.log`。

## 常见问题

### Docker Hub 拉取超时

使用镜像源构建：

```bash
./deploy/nas.sh deploy --mirror
```

### SCP 报 SFTP subsystem 错误

脚本已使用 `scp -O` 强制传统 SCP 协议。确认 NAS 已启用 SSH，且 `NAS_SSH_PORT` 填写正确。

### NAS 上提示需要 root

脚本只在上线阶段调用一次 sudo。输入 DSM 登录账号的 sudo 密码即可；不需要配置免密 sudo。

### 部署失败后的检查

```bash
./deploy/nas.sh logs
./deploy/nas.sh recon
```

也可以在 NAS 上查看：

```text
<NAS_DEPLOY_DIR>/deploy/remote-deploy.log
```

部署完成后，按照仓库根目录 [CUSTOMIZATIONS.md](../CUSTOMIZATIONS.md) 的自检清单验证定制功能。
