package controller

import (
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// The today-token card shows the prompt/completion/cache split, and cached
// tokens are only stored inside the log `other` payload, so the endpoint
// contract (including its tolerance of malformed payloads) is load-bearing.
func TestLogsSelfTokenStatReportsTokenBreakdown(t *testing.T) {
	previousLogDB := model.LOG_DB
	t.Cleanup(func() { model.LOG_DB = previousLogDB })

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Log{}))
	model.LOG_DB = db

	require.NoError(t, db.Create(&[]model.Log{
		// Counted: cache tokens come from the `other` payload.
		{Type: model.LogTypeConsume, Username: "alice", ModelName: "gpt", PromptTokens: 100, CompletionTokens: 50, CreatedAt: 1000, Other: `{"cache_tokens":40}`},
		// Counted: a log without any cache usage must not lose its tokens.
		{Type: model.LogTypeConsume, Username: "alice", ModelName: "gpt", PromptTokens: 7, CompletionTokens: 3, CreatedAt: 2000, Other: `{"model_ratio":1}`},
		// Counted: an empty or malformed `other` payload is not an error.
		{Type: model.LogTypeConsume, Username: "alice", ModelName: "gpt", PromptTokens: 5, CompletionTokens: 1, CreatedAt: 2500},
		{Type: model.LogTypeConsume, Username: "alice", ModelName: "gpt", PromptTokens: 2, CompletionTokens: 1, CreatedAt: 2600, Other: `{"cache_tokens":`},
		// Excluded: not token usage, or another user's usage.
		{Type: model.LogTypeTopup, Username: "alice", ModelName: "gpt", PromptTokens: 999, CompletionTokens: 999, CreatedAt: 1500},
		{Type: model.LogTypeConsume, Username: "bob", ModelName: "gpt", PromptTokens: 500, CompletionTokens: 500, CreatedAt: 1500, Other: `{"cache_tokens":500}`},
	}).Error)

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("GET", "/api/log/self/token_stat", nil)
	c.Set("username", "alice")

	GetLogsSelfTokenStat(c)

	require.Equal(t, 200, recorder.Code)

	var payload struct {
		Success bool                      `json:"success"`
		Data    model.TokenUsageBreakdown `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	assert.True(t, payload.Success)
	assert.Equal(t, int64(114), payload.Data.PromptTokens)
	assert.Equal(t, int64(55), payload.Data.CompletionTokens)
	assert.Equal(t, int64(40), payload.Data.CacheTokens)

	// An explicit range must narrow the breakdown to the matching consume logs.
	recorder = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(
		"GET", "/api/log/self/token_stat?start_timestamp=1900&end_timestamp=2100", nil)
	c.Set("username", "alice")

	GetLogsSelfTokenStat(c)

	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	assert.Equal(t, int64(7), payload.Data.PromptTokens)
	assert.Equal(t, int64(3), payload.Data.CompletionTokens)
	assert.Zero(t, payload.Data.CacheTokens)
}
