# 本仓库相对上游的定制

- **上游**：https://github.com/QuantumNous/new-api
- **基线 tag**：`v1.0.0-rc.36`
- **分支**：`custom/rc36-token-stats`
- **改动范围**：3 个功能提交（后端 1 + 前端 2 + 测试 1），共 28 个文件
- **数据库变更**：**无**（未动 `model/`、`setting/`、`service/`、`main.go`）

> 因为没有任何 schema 变更，升级或回滚镜像时**不需要迁移数据**。

---

## 1. 概览页 Token 统计（核心改动）

### 后端
- `controller/log.go`：`/api/log/stat` 与 `/api/log/self/stat` 的响应新增 `token` 字段
  （接出上游原本被注释掉的 `model.SumUsedToken`；管理端顺带修正了漏传 `token_name` 的问题）
- `controller/log_stat_test.go`：契约测试

### 前端
- `features/dashboard/components/overview/summary-cards.tsx`
  「用量概览」4 张卡：Token 用量（含【近 24 小时/今天】切换）／历史使用情况／请求计数／Token 总计。
  切换器**只影响第一张卡**，其余卡片沿用固定的近 24 小时趋势（两个独立查询）。
- `features/dashboard/components/overview/token-usage-chart.tsx`
  「各模型 Token 用量」堆叠柱状图：1/7/30 天/全部 预设 + 筛选弹窗（自定义范围与粒度）。
- `features/dashboard/lib/token-usage.ts`
  纯逻辑层：粒度规则、`hour/day/week/month` 分桶、`axisStartFor`（全部时间至少覆盖近半年）、
  设置的 localStorage 持久化与校验。

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
```

> ⚠️ 粒度标签**必须**用 `Per Hour` / `Per Day` / `Per Week` / `Per Month`。
> 共享的 `Week` / `Month` 在中文里译作「本周」「本月」（排行榜页在用），语义不符。

---

## 3. 共享组件改动

| 文件 | 改动 |
|---|---|
| `components/ui/stat-card.tsx` | `StatCardTone` 扩展 `accent-4`；标题在存在 `action` 时正确截断 |
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

- [ ] 概览页有 4 张卡，第 1 张右上角有【近 24 小时 / 今天】切换
- [ ] 切换「今天」时**只有第 1 张卡的折线变化**，另两张不动
- [ ] 「各模型 Token 用量」面板存在，头部显示「总计：X　粒度：Y」
- [ ] 第 4 张「Token 总计」有数字（说明后端 `token` 字段还在）
- [ ] 选「全部」→ 默认月聚合、X 轴覆盖近半年
- [ ] 7 天 → 30 天切换后粒度是「天」而非「小时」
- [ ] 筛选弹窗粒度下拉显示中文（小时/天/周/月），不是 `day`

---

## 6. 已知上游缺陷（未修，按需处理）

`time_granularity` 的**周**维度在数据看板（`processChartData`）里实际未聚合：
`formatChartTime(ts, 'week')` 依据每条数据自身日期生成标签，同周不同天会各自成柱。
后端也完全忽略 `default_time` 参数。本仓库的 Token 用量图**没有**复制该问题
（做了对齐到周一的正确分桶）。**选择：不修上游，保持改动最小。**
