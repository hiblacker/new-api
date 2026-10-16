package controller

import (
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestGetUserQuotaDatesFlushesPendingQuotaData(t *testing.T) {
	previousDB := model.DB
	previousCache := model.CacheQuotaData
	previousExportEnabled := common.DataExportEnabled
	t.Cleanup(func() {
		model.DB = previousDB
		model.CacheQuotaDataLock.Lock()
		model.CacheQuotaData = previousCache
		model.CacheQuotaDataLock.Unlock()
		common.DataExportEnabled = previousExportEnabled
	})

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.QuotaData{}))
	model.DB = db
	common.DataExportEnabled = true

	model.CacheQuotaDataLock.Lock()
	model.CacheQuotaData = make(map[string]*model.QuotaData)
	model.CacheQuotaDataLock.Unlock()
	model.LogQuotaData(model.QuotaDataLogParams{
		UserID:    7,
		Username:  "alice",
		ModelName: "gpt-live",
		CreatedAt: 4800,
		TokenUsed: 42,
		Quota:     7,
	})

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest("GET", "/api/data/self?start_timestamp=3000&end_timestamp=5000", nil)
	c.Set("id", 7)

	GetUserQuotaDates(c)

	require.Equal(t, 200, recorder.Code)
	var payload struct {
		Success bool              `json:"success"`
		Data    []model.QuotaData `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &payload))
	require.True(t, payload.Success)
	require.Len(t, payload.Data, 1)
	require.Equal(t, "gpt-live", payload.Data[0].ModelName)
	require.Equal(t, 42, payload.Data[0].TokenUsed)
}
