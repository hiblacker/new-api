# 本仓库相对上游的定制

- **上游**：https://github.com/QuantumNous/new-api
- **基线 tag**：`v1.0.0-rc.37`（2026-10-16 由 `v1.0.0-rc.36` 升级合并，分叉点 `ea7cb0ba4`）
- **分支**：`main`（定制已并入主分支；`custom/rc36-token-stats` 保留为历史特性分支）
- **改动范围**：本文档 §1–§6；rc.36 → rc.37 的合并与冲突解决记录见合并提交 message
- **数据库变更**：**定制代码本身无** schema 变更（未动 `model/`、`setting/`、`service/`、`main.go`）；
  但**基线升级到 rc.37 会执行上游迁移**，见下方警告

> **定制代码本身**没有任何 schema 变更，历史上在 rc.36 上回滚镜像不需要迁移数据。
>
> ⚠️ **2026-10-16 起基线升到 rc.37，这个结论变了**：rc.37 引入了显式迁移并会在启动时自动执行 ——
> `model/option_primary_key_migration.go`（重建 options 表主键）、
> `model/prefill_group_migration.go`（重命名 prefill group 唯一索引）、
> `model/migration_dialector.go`（方言适配）。
>
> ⇒ **首次部署 rc.37 镜像前必须确认数据库备份成功**；一旦迁移已执行，
> 再回滚到 rc.36 镜像**不一定安全**（schema 已前滚），需要时用 `deploy/backups/` 里的 pg 备份还原。

---

## 1. 概览页 Token 统计（核心改动）

### 后端
- `controller/log.go`：`/api/log/stat` 与 `/api/log/self/stat` 的响应新增 `token` 字段
  （接出上游原本被注释掉的 `model.SumUsedToken`；管理端顺带修正了漏传 `token_name` 的问题）
- `controller/log_stat_test.go`：契约测试

### 前端
- `features/dashboard/components/overview/summary-cards.tsx`
  「用量概览」4 张卡：Token 总计／Token 用量（含【近 24 小时/今天】切换）／历史使用情况／请求计数。
  卡片顺序＝`useSummaryCardsConfig` 里的数组顺序；配色按卡片 key 绑定（`SUMMARY_CARD_TONES`），
  与槽位无关，改顺序不会让 4 张卡整体换色。
  切换器**只影响 Token 用量卡**，其余卡片沿用固定的近 24 小时趋势（两个独立查询）。
  - 标题右侧带单位总量：`StatCard.titleValue`，只对「总 Token 数」卡传入，
    用 `formatCompactNumber` + i18n 区域（与数据看板卡片同一换算），卡片正文仍是完整分组数字。
  - `bare`：使用日志页传 `bare`，即**不渲染面板外壳**（没有「用量概览」标题、说明小字、
    边框与内边距），4 张卡直接贴在页面上；概览页不传，保持原面板样式。
- `features/usage-logs/index.tsx`：
  - **只有 Common（文本）日志**顶部挂载 `<SummaryCards bare />`；绘图／任务日志不显示这 4 张卡。
  - Common 段**没有页面标题**：标题（「通用日志」）与「全部／仅自己」切换都去掉了，作用域固定为
    `all`（`UsageLogsProvider` 的默认值，也是 `resolveLogsViewAccess` 判定管理端视图的前提）。
    绘图／任务段保留标题与任务切换器。
  - 因为 Common 段既无标题也无 Actions，`components/layout/components/section-page-layout.tsx`
    增加了「breadcrumb／title／actions 全为空则不渲染头部区块」的判断，否则页面顶部会留一条白条。
- `features/usage-logs/components/common-logs-stats.tsx`：搜索区统计徽标由金额改为 Token 数
  （`t('Tokens')` + `formatNumber(stats.token)`）。该徽标不再随「隐藏敏感信息」开关打码——
  那个开关的职责是金额与账号标识，Token 数不属于敏感信息。
- `features/dashboard/components/overview/token-usage-chart.tsx`
  「各模型 Token 用量」堆叠柱状图：1/7/30 天/全部 预设 + 筛选弹窗（自定义范围与粒度）。
- `features/dashboard/lib/token-usage.ts`
  纯逻辑层：粒度规则、`hour/day/week/month` 分桶、`axisStartFor`（全部时间至少覆盖近半年）、
  设置的 localStorage 持久化与校验。
- `i18n/locales/zh.json`、`zh-TW.json`：`Usage Logs` / `Usage logs` 两个键的中文文案
  由「使用日志」改为「使用记录」（繁体「使用紀錄」）。**只改中文**；菜单、个人资料页
  「边栏模块」开关、概览页快捷入口共用同一个 key，会一起变（英文仍为 Usage Logs）。

### 粒度规则（易被上游改坏，务必核对）

| 范围 | 可选粒度 | 默认 |
|---|---|---|
| 1 天 | 小时 | 小时 |
| 7 / 30 天 | 小时、天 | 天 |
| 全部 | 天、周、月 | 月 |
| 自定义 | 按实际跨度套用上述规则 | — |

点击预设会应用**该预设的默认粒度**（不沿用上一次的选择）。

---

## 2. 新增 i18n 键（**勿删**）

```
Token Usage / Tokens used / Total Tokens / Token Usage by Model
All-time token usage / 90 Days / All Time
Monitor token usage and request volume
Token Usage Filters
Choose the time range and how usage is aggregated into buckets.

Per Hour / Per Day / Per Week / Per Month      ← 粒度专用，勿改用 Week/Month
Granularity:                                    ← 头部「粒度：X」

Refresh overview / Refreshing... / Refresh settings / Auto refresh / Refresh interval (seconds)
Choose whether and how often to refresh the overview automatically.
Refresh usage logs / Choose whether and how often to refresh the usage logs automatically.
```

> ⚠️ 粒度标签**必须**用 `Per Hour` / `Per Day` / `Per Week` / `Per Month`。
> 共享的 `Week` / `Month` 在中文里译作「本周」「本月」（排行榜页在用），语义不符。

---

## 3. 共享组件改动

| 文件 | 改动 |
|---|---|
| `components/refresh-controls.tsx` | **新增**，概览页与使用日志页共用的刷新控件（手动刷新 + 自动刷新设置），共用偏好键 `dashboard_refresh_settings` |
| `components/ui/stat-card.tsx` | `StatCardTone` 扩展 `accent-4`；标题在存在 `action` 时正确截断；新增可选 `titleValue`（标题右侧的带单位数值） |
| `styles/theme.css`、`theme-presets.css` | 新增 `--overview-accent-4` |
| `components/ui/section-divider.tsx` | **新增**，两个筛选弹窗共用（`models-filter-dialog` 已改为复用它） |
| `hooks/use-vchart-theme.ts` | **新增**，VChart 主题同步；`consumption-distribution-chart` 已改为复用它 |
| `features/usage-logs/{types,constants}.ts` | `LogStatistics` 新增 `token` 字段 |

---

## 4. 测试基建

- `web/src/test-setup.ts` 增加 `nsSeparator: false`，对齐 `src/i18n/config.ts`。
  否则测试里 `t('Total:')` 会被当成命名空间解析，渲染为空串
  （曾导致断言「因为错误原因而通过」）。

---

## 5. 升级上游后的自检清单

```bash
cd web && bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run test
bun run build && cd .. && go build ./...
```

功能自检：

- [ ] 概览页有 4 张卡，顺序为 Token 总计／Token 用量／历史使用情况／请求计数
- [ ] 「Token 总计」卡标题右侧有带单位数值（如 `1.2M`），正文仍是完整数字
- [ ] 使用日志（Common）页顶部是同样 4 张卡（第 3 张仍是「历史使用情况」），且不渲染面板标题与边框
- [ ] 使用日志（Common）段没有页面标题，也没有「全部／仅自己」切换（固定为全部）
- [ ] 使用日志搜索区的统计徽标显示 Token，不再显示金额
- [ ] 绘图／任务日志段保留自己的页面标题，且不出现这 4 张卡
- [ ] 第 2 张（Token 用量）右上角有【近 24 小时 / 今天】切换
- [ ] 切换「今天」时**只有 Token 用量卡的折线变化**，另两张不动
- [ ] 「各模型 Token 用量」面板存在，头部显示「总计：X　粒度：Y」
- [ ] 第 1 张「Token 总计」有数字（说明后端 `token` 字段还在）
- [ ] 选「全部」→ 默认月聚合、X 轴覆盖近半年
- [ ] 7 天 → 30 天切换后粒度是「天」而非「小时」
- [ ] 筛选弹窗粒度下拉显示中文（小时/天/周/月），不是 `day`
- [ ] 中文界面左侧菜单是「使用记录」（英文仍是 Usage Logs）
- [ ] 使用日志（Common）页点刷新，或等自动刷新（默认 30 秒）后，**四张卡片数值都跟着变**
- [ ] 系统设置 → 维护 → 日志维护 有「记录用户提问」开关与字符数输入，开关默认关闭
- [ ] 打开开关后发一条文本请求，使用记录详情弹窗出现「用户提问」区块，且普通用户视角看不到

---

## 6. 页面刷新控件（概览页 + 使用日志页共用）

- `components/refresh-controls.tsx`：**通用**刷新控件（手动刷新按钮 + 刷新设置弹窗），
  调用方传入 `queries`（哪些查询参与刷新，手动与自动都用它）与 `label` / `description`
  （按钮 aria-label 与弹窗说明，各页自己的文案）。
  手动刷新走 `refetchQueries`（保留旧数据，不闪空白）；自动刷新按间隔重取；开关与间隔
  （10/15/30/60/120/300 秒）存在 localStorage
  **`dashboard_refresh_settings`**——两个页面共用同一份偏好，默认开启、30 秒，页面不可见时跳过。
- `hooks/use-refresh-cooldown.ts`（从 `features/dashboard/hooks/` 移到通用 `hooks/`）：
  点击后维持 2 秒最短忙碌态，否则「点完看不出反应」。
- 各页包装组件（只定义查询范围与文案）：
  - `features/dashboard/components/overview/overview-refresh-controls.tsx`：
    `dashboard/overview/*`、`status`、`perf-metrics-summary`
  - `features/usage-logs/components/usage-logs-refresh-controls.tsx`：`logs`、`usage-logs-stats`、
    `status`，外加**四张头部卡片各自的前缀**——`dashboard/overview/account`（历史使用情况、请求计数）、
    `dashboard/overview/summary-sparklines`（Token 用量）、`dashboard/overview/lifetime-tokens`（Token 总计）。
    逐条列出而不写宽的 `dashboard/overview` 前缀，免得以后概览页新增查询被悄悄带进刷新范围。
    回归测试 `features/usage-logs/__tests__/refresh.test.tsx` 断言**手动刷新与定时刷新后
    四张卡片的渲染数值都变化**（把范围缩到只剩 `logs` 会立刻失败）
- 位置：概览页在页面标题右侧的 Actions；使用日志页在筛选工具栏右侧的操作区
  （Common 与绘图／任务两套工具栏都挂了，走 `LogsFilterToolbar.actionStart`）。
- `hooks/use-overview-account.ts`：概览页统一取当前账号（`/api/user/self` 兜底 auth store）。
- `uptime-panel.tsx`、`token-usage-chart.tsx`：从手写 `useEffect` 改为 react-query，
  这样刷新控件能按前缀一起重取。
- `controller/usedata.go`：`/api/data` 与 `/api/data/self` 在 `DataExportEnabled` 时先
  `SaveQuotaDataCache()`，否则刚刷新时读到的还是内存里尚未落库的聚合。

---

## 7. 已知上游缺陷（未修，按需处理）

`time_granularity` 的**周**维度在数据看板（`processChartData`）里实际未聚合：
`formatChartTime(ts, 'week')` 依据每条数据自身日期生成标签，同周不同天会各自成柱。
后端也完全忽略 `default_time` 参数。本仓库的 Token 用量图**没有**复制该问题
（做了对齐到周一的正确分桶）。**选择：不修上游，保持改动最小。**

---

## 8. 顶栏不再显示更新检查入口（2026-10-16）

- `components/layout/components/app-header.tsx`（应用顶栏）与
  `components/layout/components/public-header.tsx`（公开页顶栏）：
  **移除** `<SystemUpdateAction />` 及其 import。
  （rc.37 起该入口会在顶栏渲染当前版本号，版本串对用户无参考价值，
  最终选择连同入口一起从顶栏去掉。）
- **系统维护里的更新检查完整保留**：
  `features/system-settings/maintenance/update-checker-section.tsx` 仍使用
  `<SystemUpdateAction compact={false} />`（系统设置 → 维护 → 更新检查）。
- 组件 `features/system-update/**` 与其测试**完全保持上游原样**未改，
  因此升级上游时只需重放这两个 header 的删除（若上游改了这两个 header 需人工确认）。

### 相关：构建期版本戳（部署侧，非产品定制）

上游 `VERSION` 是空文件（`f4450040b`），真实版本由 CI 在构建时写入。
本地构建若不处理，`/api/status` 的 `version` 为空、更新弹窗会显示「未知版本」。
`deploy/nas.sh` 现在会在构建前把镜像 tag 写进 `VERSION`、构建后（含中断）还原，
详见 `deploy/README.md`。

---

## 9. 使用记录展示用户提问（2026-10-23）

### 后端
- `service/log_prompt.go`（新增）：`extractPromptText` 按协议从 `relayInfo.Request` 取**最后一条
  `role=user` 消息**的文本 —— OpenAI Chat／补全、Claude、Gemini、Responses、图片 `prompt`、
  Embedding `input`、Rerank `query`。图片／音频等附件一律丢弃，只保留 text part（防止 base64 进库）。
- `service/log_info_generate.go`：`GenerateTextOtherInfo()` 调用 `appendPromptPreview()`。该函数是
  文本／Claude／Gemini／音频／WSS／图片／Embedding／Rerank 计费成功日志的唯一漏斗，一处覆盖全部。
- `service/relay_error.go`：`ProcessChannelError` 的失败日志也挂一次。
- `cleanUserText`：截断前先剥离客户端注入的脚手架（`<system-reminder>`、`<image_local_path>`、
  `<codex_internal_context>`，并去掉 `<user_query>` 包裹）；Codex goal 模式消息没有用户正文，
  退回取 `<objective>` 内容；清洗后为空则不写预览。
- 落库位置：`other.admin_info.prompt_preview` + `other.admin_info.prompt_chars`（**admin 作用域**，
  `model.formatUserLogs` 会把 `admin_info` 整块从普通用户视图剥离）。按 rune 截断，超长补 `…`。
- 开关：`LogPromptEnabled`（默认 **false**）、`LogPromptMaxChars`（默认 500，硬上限 4000），
  注册在 `common/constants.go` 与 `model/option.go`。

### 前端
- `features/usage-logs/components/dialogs/details-dialog.tsx`：详情弹窗新增「User Prompt」区块
  （等宽换行 + 复制按钮 + 截断提示）。
- `features/system-settings/maintenance/log-settings-section.tsx`：日志维护页新增开关与字符数输入
  （`zodResolver` 需 `as Resolver<Values, unknown, Values>`，否则 `z.coerce.number` 会破坏泛型推导）。
- `features/usage-logs/types.ts`：`LogOtherData.admin_info` 增加 `prompt_preview` / `prompt_chars`。
- i18n：7 个 locale 各新增 6 个 key。

### 测试
- `service/log_prompt_test.go`：表驱动覆盖各协议、tool 消息回退、多模态丢附件、rune 截断、开关关闭。
- `web/src/features/usage-logs/components/__tests__/prompt-preview.test.tsx`：详情弹窗三条用例。

### 注意
- 开启后列表接口的 `other` 会变大（每条 ≤ `LogPromptMaxChars`），是已知取舍；要存全文需另立表
  （见 `docs/usage-log-prompt-design.md` 方案 B）。
- `pass-through` 直传、JS 任务插件、MJ 任务、异步结算路径拿不到结构化请求，记录不到，属预期。
- ClickHouse 日志库无 schema 变更（仍写 `other` 字符串列）。

### 构建 / 部署（2026-10-23 补充）
- `Dockerfile` 的 `builder2` 阶段 `ENV` 追加 `GOPROXY=https://goproxy.cn,direct`；
  `deploy/Dockerfile.mirror` 同步同一改动。原因：`docker build` 的容器拿不到宿主代理，
  默认 `proxy.golang.org` 直连超时，`go mod download` 必挂。
- 部署前自检：`docker images | grep -E 'debian|golang|oven/bun'` 三个基础镜像必须都在本地，
  否则构建会去连 Docker Hub。2026-10-23 曾因本地缓存被清空、`debian:bookworm-slim` 缺失而失败，
  最终用 `docker pull docker.1ms.run/library/debian:bookworm-slim` + `docker tag` 成官方名解决。
