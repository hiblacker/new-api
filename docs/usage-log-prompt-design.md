# 使用记录展示「用户提问」设计方案

- 状态：**方案 A（P1）已实现**；方案 B（独立表）仍为设计稿
- 日期：2026-10-23
- 影响范围：`service/`、`model/log_other.go`、`web/src/features/usage-logs/`、`web/src/features/system-settings/`

## 1. 需求

在「使用记录」（`web/src/features/usage-logs`）里能看到某条请求对应的**用户提问内容**，用于：

1. 管理员排障：知道用户到底发了什么导致报错 / 走了哪条分支。
2. 用量审计：识别滥用、调试 prompt。

非目标：出参内容、跨请求的完整对话回放、prompt 内容风控（另做）。

## 2. 现状与约束

### 2.1 写入链路

```
middleware/distributor → controller/relay.go（解析 body → dto.Request）
  → relay/*_handler.go（TextHelper 等）
  → service/text_quota.go / service/quota.go（算钱）
  → service/log_info_generate.go: GenerateTextOtherInfo()（组装 other）
  → model/log.go: RecordConsumeLog()（落库）
```

- `Log` 结构见 `model/log.go:56`，`Other string` 存一段 JSON。
- `Other` 由 `model.LogOther`（`model/log_other.go:37`）构造，**三档可见性**：
  - `SetPublic` → 顶层，日志所有者（普通用户查自己）可见；
  - `SetAdmin` → 塞进 `admin_info`，`formatUserLogs` 对普通用户整块剥离；
  - `SetRoot` → `root_info`，仅 root。
- 请求体解析后的对象挂在 `relayInfo.Request`（`relay/common/relay_info.go:185`，接口 `dto.Request`）。
- 计费成功后 `GenerateTextOtherInfo()` 是**唯一漏斗**：文本 / Claude / Gemini / 音频 / WSS 全部经过它（`service/text_quota.go:479,488`）。
- 失败请求走 `service/relay_error.go:63` → `model.RecordErrorLog`，同样带 `*LogOther`。

### 2.2 三个硬约束

**C1 — `other` 会随列表接口整行返回。**
`model/log.go:GetAllLogs` 用 `Find(&logs)` 取全列，`Other` 原样进 JSON。列表每页 20 条，若 `other` 里塞 2KB prompt，单次列表响应 +40KB，移动端与 ClickHouse 场景都会明显变慢。⇒ **写在 `other` 里的内容必须截断**。

**C2 — ClickHouse 日志表是手写 DDL。**
`model/main.go:436 clickHouseLogCreateTableSQL` 逐列列举（含 `other String`），`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列，也没有 ALTER 迁移逻辑。⇒ **给 `Log` 结构体加字段在 ClickHouse 日志库下会静默丢数据**；新表也只能走主库，或另写 ClickHouse DDL。

**C3 — 部分路径没有结构化请求。**
`pass-through` 全局开关 / 渠道级 `PassThroughBodyEnabled` 时可能不解析成 dto；`plugins/tasks` 的 JS 任务、MJ 任务、`service/task_billing.go` 的异步结算在落库时已无 `gin.Context` 与请求体。

## 3. 方案对比

| 维度 | A. 写进 `logs.other` | B. 独立表 `log_prompts` | C. 原始 body 归档 |
| --- | --- | --- | --- |
| schema 变更 | 无需 | 新表（ClickHouse 需单独 DDL） | 新表 + 对象存储 |
| 改动面 | 1 个提取器 + 1 处挂载 + 前端 1 段 | 提取器 + 写入队列 + 读取 API + 权限 + 清理 | 大量 |
| 保存内容 | 截断预览（默认 1000 字符） | 完整 prompt / 完整 messages | 原始字节 |
| 列表性能 | 有影响（必须截断） | 无影响（列表不加载） | 无影响 |
| 全文检索 | 不能（需 LIKE 全表） | 能（加列 / 索引） | 不能 |
| 权限粒度 | 复用 `LogOther` 三档 | 自定义 | 自定义 |
| 工作量 | 0.5–1 人日 | +2–3 人日 | +5 人日以上 |

**结论：P1 先做 A，验证需求是否真的常用；确认要检索历史 prompt 再上 B，A 的字段可直接复用为列表预览。**

## 4. 方案 A 详细设计（P1）

### 4.1 数据流

```
relayInfo.Request ──extractLastUserPrompt()──> string
                                        │
                          truncate(N) ──┤
                                        ▼
                     other.SetAdmin("prompt_preview", preview)
                                        │
                         + other.SetAdmin("prompt_chars", total)
                                        │  （可选）prompt_hash
                                        ▼
                             RecordConsumeLog / RecordErrorLog
```

### 4.2 后端改动清单

| 文件 | 改动 |
| --- | --- |
| `service/log_prompt.go`（新建） | `extractPromptPreview(req dto.Request) (text string, totalChars int)`；纯函数，便于表驱动测试 |
| `service/log_info_generate.go` | `GenerateTextOtherInfo()` 末尾调用 `appendPromptPreview(...)`；新增该函数（开关判断 + 截断 + 写 scope） |
| `service/relay_error.go` | `RecordErrorLog` 之前复用同一函数（`other` 已有变量） |
| `common/constants.go` | 新增 `LogPromptEnabled bool`、`LogPromptMaxChars int` |
| `model/option.go` | `updateOptionMap` 同上两处（初始化 + `SetOption` 分支），与 `LogConsumeEnabled` 完全同构 |
| `web/src/features/system-settings/...` | 见 4.6 |

### 4.3 提取规则矩阵

统一原则：**取最后一条 `role == "user"` 的消息；只取文本；多模态附件丢弃；取不到就不写字段（而不是写空串）**。

| 协议 | 类型（`relaykit/dto`） | 取值 |
| --- | --- | --- |
| OpenAI Chat | `*GeneralOpenAIRequest` | `Messages` 倒序找 `role=="user"` → `Message.StringContent()`（内部处理 string / `[]MediaContent`，只拼 `text` part） |
| OpenAI 补全 | `*GeneralOpenAIRequest` | `Messages` 空时回退 `Prompt`（`any`，string 或 []string 拼接） |
| Claude Messages | `*ClaudeRequest` | `Messages` 倒序找 `role=="user"` → `Content` 为 string 直接用；为 `[]any` 时拼 `type=="text"` 的 `text` |
| Gemini | `*GeminiChatRequest` | `Contents` 倒序找 `Role=="user"` → `Parts[].Text` 拼接（`Thought==true` 跳过） |
| OpenAI Responses | `*OpenAIResponsesRequest` | `Input`（`json.RawMessage`）→ 解成数组后取 `role=="user"` 的 `content`，字符串则直接用，数组取 `type=="input_text"` 的 `text` |
| 图片生成 | `*ImageRequest` | `Prompt` |
| Embedding | `*EmbeddingRequest` | `Input`（string / []string / [][]int，只取前 3 段字符串） |
| Rerank | `*RerankRequest` | `Query` |
| 音频转写 | `*AudioRequest` | 无文本输入，跳过（只记文件名可选） |
| 其他 / nil | — | 跳过 |

> 注意：`relayInfo.Request` 是**转换前**的原始请求（`TextHelper` 里 `applySystemPromptIfNeeded` 作用在 `common.DeepCopy` 出来的副本上），所以记录到的是用户真实发出的内容，不含被覆盖的 system prompt。这是期望行为。

### 4.4 写入格式

```json
{
  "prompt_preview": "帮我写一个快速排序…",   // 已截断
  "prompt_chars": 2183,                     // 原文长度，用于前端提示「已截断」
  "prompt_role": "user",                    // 固定值，预留 multi-turn 扩展
  "admin_info": { "...": "..." }
}
```

- 默认写 **`SetAdmin`**（`admin_info.prompt_preview`），因为「看到所有用户问了什么」属于内容级审计权限，普通用户日志视图不暴露他人内容；`formatUserLogs` 会自动剥离。
- 若产品希望用户也能在「我的使用记录」里回看自己的提问，改用 `SetPublic`，此时字段放顶层，且**必须**同步确认 `legacySensitiveLogOtherKeys` 不会误删（`prompt_*` 不在列表内，安全）。
- 截断策略：`maxChars` 默认 500、硬上限 4000；超长时保留前 `maxChars` 并在末尾追加 `…`。**不要**截断字节，按 rune 截断避免中文乱码。

### 4.5 开关与配置

- `LogPromptEnabled`（默认 `false`）：关闭时零开销，不解析、不写库。
- `LogPromptMaxChars`（默认 500，范围 100–4000）。
- 建议首次上线默认关闭，管理员在「系统设置 → 维护 → 日志维护」里手动打开，并在描述文案里明确写「将记录用户输入内容，请确认合规要求」。

### 4.6 前端改动清单

| 文件 | 改动 |
| --- | --- |
| `web/src/features/usage-logs/types.ts` | `LogOtherData` 增加 `admin_info.prompt_preview?/prompt_chars?` 与顶层同名可选字段 |
| `.../components/dialogs/details-dialog.tsx` | Overview 之后插入一个 `DetailSection label={t('User Prompt')}`：`pre` 等宽字体 + `max-h-40 overflow-auto` + 复制按钮（复用 `useCopyToClipboard`）；`prompt_chars > len(preview)` 时显示「已截断」标签 |
| `.../components/usage-logs-mobile-card.tsx` | 可选：卡片折叠区内加一行摘要（`line-clamp-2`） |
| `web/src/features/system-settings/maintenance/log-settings-section.tsx` | 在「记录配额消耗」开关后加一个 `SettingsSwitchItem` + 一个数字输入（最大字符数），沿用 `zod` schema 与 `updateOption` 的既有写法 |
| `web/src/i18n/locales/{en,zh,zh-TW,fr,ru,ja,vi}.json` | 新增 `User Prompt`、`The prompt sent by the user for this request`、`Record user prompts`、`Truncated`、`Prompt max chars` 等 key |

### 4.7 性能

- 关闭开关：无解析、无序列化，0 成本。
- 开启：每请求多一次字符串拼接 + JSON 序列化（几百字节），可忽略。
- 列表响应增大约 `N × maxChars × ~3B`（中文）。500 字符 ≈ 1.5KB/条，20 条 ≈ 30KB → 可接受；若觉得大，把 A 的默认值降到 200，或直接上 B。

## 5. 方案 B 详细设计（P2，按需）

仅在需要「完整 prompt / 关键词检索 / 不受 500 字限制」时实施。

### 5.1 表结构

```sql
CREATE TABLE log_prompts (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,     -- SQLite: INTEGER PRIMARY KEY AUTOINCREMENT
  request_id    VARCHAR(64)  NOT NULL,                 -- 关联 logs.request_id（已建索引）
  user_id       INT          NOT NULL,
  token_id      INT          DEFAULT 0,
  model_name    VARCHAR(128) DEFAULT '',
  created_at    BIGINT       NOT NULL,
  prompt        TEXT         NOT NULL,                 -- 截断上限另设（默认 20k rune）
  prompt_chars  INT          DEFAULT 0,
  truncated     BOOLEAN      DEFAULT FALSE,
  prompt_hash   CHAR(32)     DEFAULT '',               -- md5(原文)，用于去重/聚类
  UNIQUE KEY uk_request_id (request_id)
);
```

- 建表：加入 `model/main.go:337` 的 `AutoMigrate` 列表（主库）。若日志库配置为 ClickHouse，需在 `migrateLOGDB` 里单独 `LOG_DB.AutoMigrate(&LogPrompt{})`（GORM 的 ClickHouse 驱动能力需先验证；不行则退化为「prompt 一律存主库」）。
- 清理：挂到 `DeleteOldLogBatch`（`model/log.go:705`）同一批任务里按 `created_at` 删。

### 5.2 写入

- **异步、best-effort**：在 `GenerateTextOtherInfo` 里把提取结果塞进一个带缓冲 channel（size 1024），单个 worker 每 200ms 或攒 50 条批量 `CreateInBatches`。
- 队列满 / 写库失败：直接丢弃并计数打点，**绝不影响计费主流程**。
- 好处：计费路径零 IO 阻塞；坏处：进程崩溃会丢最后一批（可接受）。

### 5.3 读取 API

```
GET /api/log/prompt?request_id=xxx
```

- 权限矩阵（见 §7）：`AdminAuth` 路由返回全部；`UserAuth` 路由先用 `logs.user_id` 校验归属，不匹配返回 404（避免探测）。
- 响应：`{ prompt, prompt_chars, truncated, created_at }`。
- 前端：详情弹窗打开时才拉（`enabled: !!request_id && open`），列表接口不带 prompt。

### 5.4 容量估算

| 日请求量 | 平均 prompt | 日增 | 30 天保留 |
| --- | --- | --- | --- |
| 1 万 | 800 字符 ≈ 2.4KB | ~24MB | ~720MB |
| 10 万 | 800 字符 ≈ 2.4KB | ~240MB | ~7GB |

⇒ 必须配合保留期（默认 30 天）与 `truncated` 上限，否则会挤爆 NAS 上的 PostgreSQL。

## 6. 覆盖矩阵与边界

| 场景 | 能否记录 | 处理 |
| --- | --- | --- |
| OpenAI Chat / Claude / Gemini / Responses | 能 | A 方案覆盖 |
| 图片生成 / Embedding / Rerank | 能 | A 方案覆盖 |
| 全局或渠道 pass-through | **可能不能** | `relayInfo.Request` 可能为 nil → 跳过；若要补，需在 `GetBodyStorage` 后对 raw JSON 做一次 `messages` 提取（额外成本，P2 再做） |
| JS 任务插件 / MJ 任务 | **不能** | 落库在异步回调，无 `gin.Context` 与请求体 |
| Responses WebSocket | 能 | `Request` 已在 `responses_websocket.go:713` 传入 |
| 一次请求多次重试 | 只写最终一条 | `request_id` 全程一致；失败 attempt 的 error 日志会各自带 prompt，属预期 |
| 多模态图片 / 音频 base64 | 丢弃附件 | 只取 text part，避免 DB 爆炸（单张图 base64 可达数 MB） |
| 超长 prompt（贴整本书） | 截断 | 按 rune 截断 + `prompt_chars` 标注原文长度 |
| 用户主动撤回/敏感内容 | 无法处理 | 靠开关 + 保留期 + 权限控制兜底，需在文档里告知 |

## 7. 权限矩阵

| 查看者 | A + `SetAdmin`（推荐） | A + `SetPublic` | B |
| --- | --- | --- | --- |
| 普通用户查自己日志 | 不可见 | 可见自己的 | 可配（建议可见自己的） |
| 管理员（`AdminAuth`） | 可见全部用户 | 可见全部用户 | 可见全部 |
| root | 可见 | 可见 | 可见 |
| 其他用户 | 不可见 | 不可见 | 不可见 |

合规提示：`SetAdmin` 只解决「谁能看到」，不解决「该不该存」。多用户 SaaS 场景必须默认关闭 + 明确告知 + 保留期；这是本方案唯一需要产品决策的点。

## 8. 测试计划

后端（`go test`）：

1. `service/log_prompt_test.go`：表驱动覆盖 §4.3 每一行 + 空消息 + 只有 system + 多模态混合 + 超长截断 + 非 UTF8 边界。
2. `service/log_info_generate_test.go`：开关关闭时不写字段；开启时 `admin_info.prompt_preview` 存在且长度 ≤ `maxChars`。
3. `model/log_other` 投影测试：普通用户视图里 `admin_info` 被剥离（已有同类测试可加法）。

前端（`vitest`）：

4. `details-dialog` 渲染 prompt 段落、截断提示、无字段时不渲染空 div。
5. `log-settings-section` 新增开关的提交 payload 正确。

门禁（按 `CUSTOMIZATIONS.md` §5）：

```bash
cd web && NODE=~/.nvm/versions/node/v22.23.2/bin/node
$NODE node_modules/.bin/tsgo -b
$NODE node_modules/.bin/vitest run --maxWorkers=2
$NODE node_modules/.bin/rsbuild build
cd .. && GOWORK=off ~/.local/go-toolchain/go/bin/go build ./...
```

> 只对改动文件 lint（`oxlint <files>`），不要跑全仓 `oxlint .`（上游遗留 293 error）。

## 9. 工作量

| 阶段 | 内容 | 估时 |
| --- | --- | --- |
| P1-A | 提取器 + 开关 + 挂载 + 前端详情 + i18n + 测试 | 0.5–1 人日 |
| P1-A+ | 错误日志覆盖 + 移动端卡片 + 设置页 | +0.5 人日 |
| P2-B | 表 + 异步队列 + 读取 API + 权限 + 清理 + 测试 | +2–3 人日 |

实施后须同步 `CUSTOMIZATIONS.md`（新增一节「使用记录展示用户提问」），因为这是相对上游的行为改动，升级时需自检。

## 10. 开放问题（需产品/运维决策）

1. **只存最后一条 user，还是整段对话？** 建议 P1 只存最后一条；多轮上下文对排障帮助有限，对存储压力却是数量级差异。
2. **普通用户能否看到自己的提问？** 影响 `SetAdmin` / `SetPublic` 的选择。
3. **是否需要按关键词搜 prompt？** 需要则直接上 B，不要用 A + `LIKE` 硬凑（全表扫描且 `other` 是 JSON 字符串）。
4. **保留多久？** 建议与现有日志清理周期一致（默认 30 天），并复用同一清理任务。
5. **ClickHouse 日志库的用户是否需要此功能？** 若需要，B 方案需额外写 ClickHouse DDL 与写入适配，成本 +1 人日。
