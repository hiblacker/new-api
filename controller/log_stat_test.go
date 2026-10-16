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

// The overview page reads `token` from the per-user log statistics endpoint to
// render its all-time token total, so the response contract is load-bearing.
func TestLogsSelfStatReportsConsumeTokenUsage(t *testing.T) {
	previousLogDB := model.LOG_DB
	t.Cleanup(func() { model.LOG_DB = previousLogDB })

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Log{}))
	model.LOG_DB = db

	require.NoError(t, db.Create(&[]model.Log{
		// Counted: an ordinary consume log.
		{Type: model.LogTypeConsume, Username: "alice", ModelName: "gpt", PromptTokens: 100, CompletionTokens: 50, CreatedAt: 1000},
		// Counted: a second consume log in a different hour.
		{Type: model.LogTypeConsume, Username: "alice", ModelName: "gpt", PromptTokens: 7, CompletionTokens: 3, CreatedAt: 2000},
		// Excluded: top-ups and system logs are not token usage.
		{Type: model.LogTypeTopup, Username: "alice", ModelName: "gpt", PromptTokens: 999, CompletionTokens: 999, CreatedAt: 1500},
		{Type: model.LogTypeSystem, Username: "alice", ModelName: "gpt", PromptTokens: 888, CompletionTokens: 888, CreatedAt: 1500},
		// Excluded: another user's usage.
		{Type: model.LogTypeConsume, Username: "bob", ModelName: "gpt", PromptTokens: 500, CompletionTokens: 500, CreatedAt: 1500},
	}).Error)

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("GET", "/api/log/self/stat", nil)
	c.Set("username", "alice")

	GetLogsSelfStat(c)

	require.Equal(t, 200, recorder.Code)

	var payload struct {
		Success bool `json:"success"`
		Data    struct {
			Token int `json:"token"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	assert.True(t, payload.Success)
	assert.Equal(t, 160, payload.Data.Token)

	// An explicit range must narrow the total to the matching consume logs.
	recorder = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(
		"GET", "/api/log/self/stat?start_timestamp=1900&end_timestamp=2100", nil)
	c.Set("username", "alice")

	GetLogsSelfStat(c)

	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	assert.Equal(t, 10, payload.Data.Token)
}
