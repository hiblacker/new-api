package model

import (
	"errors"
	"time"

	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// CodexUsageThread 保存官方订阅账号下每个 Codex 线程的 token 消耗。
//
// 数据由本地采集器从 Codex 的 state_5.sqlite 提取后上报。只采集 creator_account_id
// 非空的线程 —— 那部分才是通过 ChatGPT 订阅（官方登录）产生的消耗；走自建中转渠道
// 的历史线程没有账号标识，不会进入这张表。
type CodexUsageThread struct {
	Id              int    `json:"id" gorm:"primaryKey"`
	ThreadId        string `json:"thread_id" gorm:"size:128;uniqueIndex"`
	AccountId       string `json:"account_id" gorm:"size:64;index"`
	Model           string `json:"model" gorm:"size:64;index"`
	TokensUsed      int64  `json:"tokens_used"`
	Title           string `json:"title" gorm:"size:255"`
	Source          string `json:"source" gorm:"size:64"`
	Originator      string `json:"originator" gorm:"size:64"`
	ThreadCreatedAt int64  `json:"thread_created_at" gorm:"index"`
	ThreadUpdatedAt int64  `json:"thread_updated_at" gorm:"index"`
	SyncedAt        int64  `json:"synced_at"`
}

// CodexUsageSnapshot 保存官方用量接口（backend-api/wham/usage）在某一时刻的快照。
// 该接口只返回窗口占用百分比与重置时间，不返回 token 数，因此与线程表分开展示。
type CodexUsageSnapshot struct {
	Id                   int     `json:"id" gorm:"primaryKey"`
	AccountId            string  `json:"account_id" gorm:"size:64;uniqueIndex"`
	PlanType             string  `json:"plan_type" gorm:"size:32"`
	Email                string  `json:"email" gorm:"size:128"`
	Allowed              bool    `json:"allowed"`
	LimitReached         bool    `json:"limit_reached"`
	PrimaryUsedPercent   int     `json:"primary_used_percent"`
	PrimaryWindowSeconds int64   `json:"primary_window_seconds"`
	PrimaryResetAt       int64   `json:"primary_reset_at"`
	SecondaryUsedPercent int     `json:"secondary_used_percent"`
	SecondaryWindowSeconds int64 `json:"secondary_window_seconds"`
	SecondaryResetAt     int64   `json:"secondary_reset_at"`
	CreditsBalance       float64 `json:"credits_balance"`
	CapturedAt           int64   `json:"captured_at"`
}

type CodexUsageDayStat struct {
	Day        string `json:"day"`
	Threads    int64  `json:"threads"`
	TokensUsed int64  `json:"tokens_used"`
}

type CodexUsageModelStat struct {
	Model      string `json:"model"`
	Threads    int64  `json:"threads"`
	TokensUsed int64  `json:"tokens_used"`
}

// CodexUsageSummary 是页面一次性拉取的聚合结果。
type CodexUsageSummary struct {
	AccountId    string               `json:"account_id"`
	TotalTokens  int64                `json:"total_tokens"`
	TotalThreads int64                `json:"total_threads"`
	TodayTokens  int64                `json:"today_tokens"`
	TodayThreads int64                `json:"today_threads"`
	RecentTokens int64                `json:"recent_tokens"`
	Daily        []CodexUsageDayStat  `json:"daily"`
	Models       []CodexUsageModelStat `json:"models"`
	Threads      []CodexUsageThread   `json:"threads"`
	Snapshot     *CodexUsageSnapshot  `json:"snapshot"`
	SyncedAt     int64                `json:"synced_at"`
}

// UpsertCodexUsageThreads 按 thread_id 覆盖写入，重复上报幂等。
func UpsertCodexUsageThreads(threads []CodexUsageThread) error {
	if len(threads) == 0 {
		return nil
	}
	now := time.Now().Unix()
	for i := range threads {
		threads[i].SyncedAt = now
	}
	return DB.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "thread_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"account_id", "model", "tokens_used", "title", "source",
			"originator", "thread_created_at", "thread_updated_at", "synced_at",
		}),
	}).CreateInBatches(&threads, 100).Error
}

// UpsertCodexUsageSnapshot 每个账号只保留最新一份快照。
func UpsertCodexUsageSnapshot(snapshot *CodexUsageSnapshot) error {
	if snapshot == nil {
		return nil
	}
	if snapshot.CapturedAt == 0 {
		snapshot.CapturedAt = time.Now().Unix()
	}
	return DB.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "account_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"plan_type", "email", "allowed", "limit_reached",
			"primary_used_percent", "primary_window_seconds", "primary_reset_at",
			"secondary_used_percent", "secondary_window_seconds", "secondary_reset_at",
			"credits_balance", "captured_at",
		}),
	}).Create(snapshot).Error
}

// GetCodexUsageSummary 汇总某账号（accountId 为空时汇总全部）的用量。
//
// 按天聚合放在 Go 侧完成，避免 strftime / date() 这类方言函数，
// 保证 SQLite / MySQL / PostgreSQL 行为一致。
func GetCodexUsageSummary(accountId string, days int) (*CodexUsageSummary, error) {
	if days <= 0 {
		days = 30
	}
	var all []CodexUsageThread
	q := DB.Model(&CodexUsageThread{})
	if accountId != "" {
		q = q.Where("account_id = ?", accountId)
	}
	if err := q.Order("thread_updated_at desc").Find(&all).Error; err != nil {
		return nil, err
	}

	loc := time.Local
	now := time.Now()
	todayKey := now.Format("2006-01-02")
	recentSince := now.AddDate(0, 0, -days).Unix()

	dailyMap := make(map[string]*CodexUsageDayStat)
	modelMap := make(map[string]*CodexUsageModelStat)
	summary := &CodexUsageSummary{
		AccountId:    accountId,
		Daily:        []CodexUsageDayStat{},
		Models:       []CodexUsageModelStat{},
		Threads:      []CodexUsageThread{},
	}
	for _, t := range all {
		summary.TotalTokens += t.TokensUsed
		summary.TotalThreads++
		if t.TokensUsed <= 0 {
			continue
		}
		day := time.Unix(t.ThreadUpdatedAt, 0).In(loc).Format("2006-01-02")
		stat, ok := dailyMap[day]
		if !ok {
			stat = &CodexUsageDayStat{Day: day}
			dailyMap[day] = stat
		}
		stat.Threads++
		stat.TokensUsed += t.TokensUsed

		if day == todayKey {
			summary.TodayTokens += t.TokensUsed
			summary.TodayThreads++
		}
		if t.ThreadUpdatedAt >= recentSince {
			summary.RecentTokens += t.TokensUsed
		}

		modelName := t.Model
		if modelName == "" {
			modelName = "(未记录)"
		}
		ms, ok := modelMap[modelName]
		if !ok {
			ms = &CodexUsageModelStat{Model: modelName}
			modelMap[modelName] = ms
		}
		ms.Threads++
		ms.TokensUsed += t.TokensUsed
	}

	for _, stat := range dailyMap {
		summary.Daily = append(summary.Daily, *stat)
	}
	for _, ms := range modelMap {
		summary.Models = append(summary.Models, *ms)
	}
	sortCodexUsage(summary)

	// 明细最多返回 200 条，避免页面过重
	if len(all) > 200 {
		summary.Threads = all[:200]
	} else {
		summary.Threads = all
	}

	snapshot, err := GetLatestCodexUsageSnapshot(accountId)
	if err != nil {
		return nil, err
	}
	summary.Snapshot = snapshot
	if snapshot != nil {
		summary.SyncedAt = snapshot.CapturedAt
	}
	return summary, nil
}

// sortCodexUsage 对按天与按模型的聚合结果排序（天升序、模型按消耗降序）。
func sortCodexUsage(summary *CodexUsageSummary) {
	days := summary.Daily
	for i := 1; i < len(days); i++ {
		for j := i; j > 0 && days[j-1].Day > days[j].Day; j-- {
			days[j-1], days[j] = days[j], days[j-1]
		}
	}
	models := summary.Models
	for i := 1; i < len(models); i++ {
		for j := i; j > 0 && models[j-1].TokensUsed < models[j].TokensUsed; j-- {
			models[j-1], models[j] = models[j], models[j-1]
		}
	}
}

func GetLatestCodexUsageSnapshot(accountId string) (*CodexUsageSnapshot, error) {	var snapshot CodexUsageSnapshot
	q := DB.Model(&CodexUsageSnapshot{})
	if accountId != "" {
		q = q.Where("account_id = ?", accountId)
	}
	err := q.Order("captured_at desc").First(&snapshot).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &snapshot, nil
}

// ---------------------------------------------------------------------------
// 单次请求写入使用日志（logs 表）
// ---------------------------------------------------------------------------

const (
	// CodexUsageLogTokenName 作为日志的令牌名，便于在“使用记录”里筛选
	CodexUsageLogTokenName = "Codex 订阅"
	// CodexUsageLogUsername 作为日志的用户名标识
	CodexUsageLogUsername = "codex-subscription"
)

// CodexUsageLogRequest 是采集器上报的单次请求用量，来源于会话 JSONL 的 token_usage_record。
type CodexUsageLogRequest struct {
	RequestId        string `json:"request_id"`
	ThreadId         string `json:"thread_id"`
	Model            string `json:"model"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	CachedTokens     int    `json:"cached_tokens"`
	TotalTokens      int    `json:"total_tokens"`
	CreatedAt        int64  `json:"created_at"`
	// Content 是这条请求所属那一轮的用户提问，用于「使用记录」里的提问列
	Content string `json:"content"`
}

// InsertCodexUsageLogs 把 Codex 的单次请求写入 logs 表。
//
// 幂等：以 request_id（OpenAI 返回的 response id）+ 固定 token_name 去重，
// 采集器重复上报不会产生重复日志。Quota 固定为 0 —— 订阅制消耗不产生账单，
// 不能影响额度统计。
func InsertCodexUsageLogs(reqs []CodexUsageLogRequest, accountId string) (int, error) {
	if len(reqs) == 0 {
		return 0, nil
	}

	ids := make([]string, 0, len(reqs))
	for _, r := range reqs {
		if r.RequestId != "" {
			ids = append(ids, r.RequestId)
		}
	}
	existing := make(map[string]struct{}, len(ids))
	if len(ids) > 0 {
		var found []string
		if err := LOG_DB.Model(&Log{}).
			Where("token_name = ? AND request_id IN ?", CodexUsageLogTokenName, ids).
			Pluck("request_id", &found).Error; err != nil {
			return 0, err
		}
		for _, id := range found {
			existing[id] = struct{}{}
		}
	}

	logs := make([]Log, 0, len(reqs))
	for _, r := range reqs {
		if r.RequestId == "" {
			continue
		}
		if _, ok := existing[r.RequestId]; ok {
			// 已入库但提问为空的，补上内容（早期版本没采集 content）
			if r.Content != "" {
				LOG_DB.Model(&Log{}).
					Where("request_id = ? AND token_name = ? AND (content IS NULL OR content = '')",
						r.RequestId, CodexUsageLogTokenName).
					Update("content", r.Content)
			}
			continue
		}
		createdAt := r.CreatedAt
		if createdAt == 0 {
			createdAt = time.Now().Unix()
		}
		other, _ := common.Marshal(map[string]any{
			"provider":      "codex-subscription",
			"account_id":    accountId,
			"thread_id":     r.ThreadId,
			"cache_tokens":  r.CachedTokens,
			"total_tokens":  r.TotalTokens,
		})
		logs = append(logs, Log{
			UserId:           0,
			CreatedAt:        createdAt,
			Type:             LogTypeConsume,
			Content:          r.Content,
			Username:         CodexUsageLogUsername,
			TokenName:        CodexUsageLogTokenName,
			ModelName:        r.Model,
			Quota:            0,
			PromptTokens:     r.PromptTokens,
			CompletionTokens: r.CompletionTokens,
			IsStream:         true,
			ChannelId:        0,
			Group:            "codex",
			RequestId:        r.RequestId,
			Other:            string(other),
		})
	}

	if len(logs) == 0 {
		return 0, nil
	}
	if err := LOG_DB.CreateInBatches(&logs, 100).Error; err != nil {
		return 0, err
	}
	return len(logs), nil
}
