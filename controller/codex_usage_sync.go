package controller

import (
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

type codexUsageSyncRequest struct {
	AccountId string                       `json:"account_id"`
	Threads   []model.CodexUsageThread     `json:"threads"`
	Requests  []model.CodexUsageLogRequest `json:"requests"`
	Snapshot  *model.CodexUsageSnapshot    `json:"snapshot"`
}

// SyncCodexUsage 接收本地采集器上报的官方订阅用量。
//
// 采集器读取本机 Codex 的 state_5.sqlite，只挑 creator_account_id 非空的线程，
// 并顺带抓一次官方 wham/usage 快照，一起推到这里。
func SyncCodexUsage(c *gin.Context) {
	var req codexUsageSyncRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiError(c, err)
		return
	}
	if len(req.Threads) == 0 && req.Snapshot == nil && len(req.Requests) == 0 {
		common.ApiErrorMsg(c, "no usage data provided")
		return
	}

	// 采集端可能只给了顶层 account_id，这里补齐到每条记录
	if req.AccountId != "" {
		for i := range req.Threads {
			if req.Threads[i].AccountId == "" {
				req.Threads[i].AccountId = req.AccountId
			}
		}
		if req.Snapshot != nil && req.Snapshot.AccountId == "" {
			req.Snapshot.AccountId = req.AccountId
		}
	}

	if err := model.UpsertCodexUsageThreads(req.Threads); err != nil {
		common.SysError("failed to upsert codex usage threads: " + err.Error())
		common.ApiError(c, err)
		return
	}
	if err := model.UpsertCodexUsageSnapshot(req.Snapshot); err != nil {
		common.SysError("failed to upsert codex usage snapshot: " + err.Error())
		common.ApiError(c, err)
		return
	}

	// 单次请求写入使用日志，失败只记日志、不阻断整体同步
	insertedLogs := 0
	if len(req.Requests) > 0 {
		n, logErr := model.InsertCodexUsageLogs(req.Requests, req.AccountId)
		if logErr != nil {
			common.SysError("failed to insert codex usage logs: " + logErr.Error())
		} else {
			insertedLogs = n
		}
	}

	common.ApiSuccess(c, gin.H{
		"threads":   len(req.Threads),
		"requests":  len(req.Requests),
		"logs":      insertedLogs,
		"snapshot":  req.Snapshot != nil,
		"synced_at": time.Now().Unix(),
	})
}

// GetCodexUsageSummary 返回页面所需的聚合数据，account_id 为空表示全部账号。
func GetCodexUsageSummary(c *gin.Context) {
	accountId := c.Query("account_id")
	days, err := strconv.Atoi(c.DefaultQuery("days", "30"))
	if err != nil {
		days = 30
	}
	summary, err := model.GetCodexUsageSummary(accountId, days)
	if err != nil {
		common.SysError("failed to get codex usage summary: " + err.Error())
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, summary)
}
