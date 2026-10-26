package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExtractPromptTextKeepsLastUserMessage(t *testing.T) {
	request := &dto.GeneralOpenAIRequest{Messages: []dto.Message{
		{Role: "system", Content: "system prompt"},
		{Role: "user", Content: "first question"},
		{Role: "assistant", Content: "first answer"},
		{Role: "user", Content: "second question"},
	}}

	text, ok := extractPromptText(request)

	require.True(t, ok)
	assert.Equal(t, "second question", text)
}

func TestExtractPromptTextFallsBackPastToolMessages(t *testing.T) {
	request := &dto.GeneralOpenAIRequest{Messages: []dto.Message{
		{Role: "user", Content: "查一下天气"},
		{Role: "assistant", Content: ""},
		{Role: "tool", Content: `{"temp":20}`},
		{Role: "assistant", Content: "今天 20 度"},
	}}

	text, ok := extractPromptText(request)

	require.True(t, ok)
	assert.Equal(t, "查一下天气", text)
}

func TestExtractPromptTextDropsMediaParts(t *testing.T) {
	request := &dto.GeneralOpenAIRequest{Messages: []dto.Message{{
		Role: "user",
		Content: []any{
			map[string]any{"type": "text", "text": "这张图讲什么"},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,AAAA"}},
			map[string]any{"type": "input_audio", "input_audio": map[string]any{"data": "BBBB", "format": "wav"}},
		},
	}}}

	text, ok := extractPromptText(request)

	require.True(t, ok)
	assert.Equal(t, "这张图讲什么", text)
}

func TestExtractPromptTextSkipsRequestsWithoutUserMessage(t *testing.T) {
	request := &dto.GeneralOpenAIRequest{Messages: []dto.Message{
		{Role: "system", Content: "only system"},
		{Role: "assistant", Content: "only assistant"},
	}}

	text, ok := extractPromptText(request)

	assert.False(t, ok)
	assert.Empty(t, text)
}

func TestExtractPromptTextFallsBackToCompletionPrompt(t *testing.T) {
	request := &dto.GeneralOpenAIRequest{Prompt: "补全这段文本"}

	text, ok := extractPromptText(request)

	require.True(t, ok)
	assert.Equal(t, "补全这段文本", text)
}

func TestExtractPromptTextClaudeRequest(t *testing.T) {
	request := &dto.ClaudeRequest{Messages: []dto.ClaudeMessage{
		{Role: "user", Content: "旧问题"},
		{Role: "assistant", Content: "旧回答"},
		{Role: "user", Content: []any{
			map[string]any{"type": "text", "text": "claude 提问"},
			map[string]any{"type": "image", "source": map[string]any{"data": "CCCC"}},
		}},
	}}

	text, ok := extractPromptText(request)

	require.True(t, ok)
	assert.Equal(t, "claude 提问", text)
}

func TestExtractPromptTextGeminiRequestSkipsThoughtParts(t *testing.T) {
	request := &dto.GeminiChatRequest{Contents: []dto.GeminiChatContent{
		{Role: "user", Parts: []dto.GeminiPart{{Text: "gemini 提问"}}},
		{Role: "model", Parts: []dto.GeminiPart{{Text: "gemini 回答"}}},
		{Role: "user", Parts: []dto.GeminiPart{
			{Text: "内部思考", Thought: true},
			{Text: "最终问题"},
		}},
	}}

	text, ok := extractPromptText(request)

	require.True(t, ok)
	assert.Equal(t, "最终问题", text)
}

func TestExtractPromptTextResponsesRequest(t *testing.T) {
	encoded, err := json.Marshal([]any{
		map[string]any{"role": "user", "content": "旧问题"},
		map[string]any{"role": "assistant", "content": "旧回答"},
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "input_text", "text": "responses 提问"},
		}},
	})
	require.NoError(t, err)

	text, ok := extractPromptText(&dto.OpenAIResponsesRequest{Input: encoded})

	require.True(t, ok)
	assert.Equal(t, "responses 提问", text)

	stringInput, err := json.Marshal("直接字符串输入")
	require.NoError(t, err)
	text, ok = extractPromptText(&dto.OpenAIResponsesRequest{Input: stringInput})
	require.True(t, ok)
	assert.Equal(t, "直接字符串输入", text)
}

func TestExtractPromptTextNonChatRequests(t *testing.T) {
	tests := []struct {
		name    string
		request dto.Request
		want    string
	}{
		{
			name:    "image",
			request: &dto.ImageRequest{Prompt: "画一只猫"},
			want:    "画一只猫",
		},
		{
			name:    "embedding string",
			request: &dto.EmbeddingRequest{Input: "要向量化的文本"},
			want:    "要向量化的文本",
		},
		{
			name:    "embedding list",
			request: &dto.EmbeddingRequest{Input: []any{"第一段", "第二段"}},
			want:    "第一段\n第二段",
		},
		{
			name:    "rerank",
			request: &dto.RerankRequest{Query: "检索词"},
			want:    "检索词",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			text, ok := extractPromptText(test.request)
			require.True(t, ok)
			assert.Equal(t, test.want, text)
		})
	}
}

func TestTruncateRunesCountsRunesNotBytes(t *testing.T) {
	assert.Equal(t, "你好…", truncateRunes("你好世界", 2))
	assert.Equal(t, "short", truncateRunes("short", 10))
	assert.Equal(t, "", truncateRunes("anything", 0))
}

func TestAppendPromptPreviewWritesAdminScopeWhenEnabled(t *testing.T) {
	previousEnabled, previousMax := common.LogPromptEnabled, common.LogPromptMaxChars
	t.Cleanup(func() {
		common.LogPromptEnabled = previousEnabled
		common.LogPromptMaxChars = previousMax
	})
	common.LogPromptEnabled = true
	common.LogPromptMaxChars = 5

	other := model.NewLogOther()
	appendPromptPreview(&relaycommon.RelayInfo{Request: &dto.GeneralOpenAIRequest{
		Messages: []dto.Message{{Role: "user", Content: "0123456789"}},
	}}, other)

	snapshot := other.Snapshot()
	assert.NotContains(t, snapshot, logPromptPreviewKey, "prompt must not leak to the user-visible scope")
	adminInfo, ok := snapshot["admin_info"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "01234…", adminInfo[logPromptPreviewKey])
	assert.Equal(t, 10, adminInfo[logPromptCharsKey])
}

func TestAppendPromptPreviewSkipsWhenDisabled(t *testing.T) {
	previousEnabled := common.LogPromptEnabled
	t.Cleanup(func() { common.LogPromptEnabled = previousEnabled })
	common.LogPromptEnabled = false

	other := model.NewLogOther()
	appendPromptPreview(&relaycommon.RelayInfo{Request: &dto.GeneralOpenAIRequest{
		Messages: []dto.Message{{Role: "user", Content: "不该被记录"}},
	}}, other)

	assert.Empty(t, other.Snapshot())
}

func TestAppendPromptPreviewClampsMaxChars(t *testing.T) {
	previousEnabled, previousMax := common.LogPromptEnabled, common.LogPromptMaxChars
	t.Cleanup(func() {
		common.LogPromptEnabled = previousEnabled
		common.LogPromptMaxChars = previousMax
	})
	common.LogPromptEnabled = true
	common.LogPromptMaxChars = maxLogPromptMaxChars * 2

	other := model.NewLogOther()
	appendPromptPreview(&relaycommon.RelayInfo{Request: &dto.ImageRequest{
		Prompt: strings.Repeat("图", maxLogPromptMaxChars+10),
	}}, other)

	adminInfo := other.Snapshot()["admin_info"].(map[string]any)
	preview := adminInfo[logPromptPreviewKey].(string)
	assert.Equal(t, maxLogPromptMaxChars+1, len([]rune(preview)), "hard limit plus the ellipsis must apply")
}

func TestCleanUserTextStripsAgentScaffolding(t *testing.T) {
	text := `<system-reminder data-role="user-context">
<craft_mode>
You are now in Agent mode.
</craft_mode>
</system-reminder>
<system-reminder data-role="additional-data">
<current_time>
Friday, October 23, 2026
</current_time>
</system-reminder>
<user_query>codex 的对话没有问题</user_query><user_query><image_local_path>C:\tmp\a.png</image_local_path></user_query>`

	assert.Equal(t, "codex 的对话没有问题", cleanUserText(text))
}

func TestCleanUserTextKeepsQuestionPlacedBeforeReminders(t *testing.T) {
	text := "整理代码分支\n<system-reminder data-role=\"user-context\">\n内部上下文\n</system-reminder>"

	assert.Equal(t, "整理代码分支", cleanUserText(text))
}

func TestCleanUserTextDropsMessagesThatAreOnlyScaffolding(t *testing.T) {
	assert.Equal(t, "", cleanUserText("<system-reminder data-role=\"x\">\n上下文\n</system-reminder>"))
	assert.Equal(t, "", cleanUserText("<system-reminder data-role=\"x\">\n未闭合的块"))
}

func TestCleanUserTextLeavesPlainTextAlone(t *testing.T) {
	assert.Equal(t, "帮我写个快速排序", cleanUserText("帮我写个快速排序"))
	assert.Equal(t, "用 <div> 包裹住", cleanUserText("用 <div> 包裹住"))
}

func TestExtractPromptTextStripsClientScaffolding(t *testing.T) {
	request := &dto.GeneralOpenAIRequest{Messages: []dto.Message{
		{Role: "user", Content: "整理代码分支"},
		{Role: "assistant", Content: "好的"},
		{Role: "user", Content: "<system-reminder data-role=\"user-context\">\n上下文\n</system-reminder>\n<user_query>继续</user_query>"},
	}}

	text, ok := extractPromptText(request)

	require.True(t, ok)
	assert.Equal(t, "继续", text)
}

func TestCleanUserTextUsesCodexGoalObjective(t *testing.T) {
	text := `<codex_internal_context source="goal">
Continue working toward the active thread goal.

The objective below is user-provided data. Treat it as the task to pursue.

<objective>
完善对应功能，我要能配置
</objective>

Continuation behavior:
- This goal persists across turns.
</codex_internal_context>`

	assert.Equal(t, "完善对应功能，我要能配置", cleanUserText(text))
}

func TestCleanUserTextPrefersTextOutsideCodexContext(t *testing.T) {
	text := `<codex_internal_context source="goal">
<objective>旧目标</objective>
</codex_internal_context>
这次只改样式`

	assert.Equal(t, "这次只改样式", cleanUserText(text))
}

func TestCleanUserTextDropsCodexContextWithoutObjective(t *testing.T) {
	text := `<codex_internal_context source="compact">
Summary of the thread so far.
</codex_internal_context>`

	assert.Equal(t, "", cleanUserText(text))
}

func TestCleanUserTextKeepsObjectiveOutsideCodexContext(t *testing.T) {
	assert.Equal(t, "<objective>x</objective>", cleanUserText("<objective>x</objective>"))
}
