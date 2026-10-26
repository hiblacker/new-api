package service

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
)

const (
	logPromptPreviewKey = "prompt_preview"
	logPromptCharsKey   = "prompt_chars"

	defaultLogPromptMaxChars = 500
	maxLogPromptMaxChars     = 4000
)

// Context blocks that agent clients (Claude Code, WorkBuddy, Codex) inject into
// the user message. Their content is prompt scaffolding rather than anything the
// user typed, so the whole block is dropped before the preview is stored.
var promptContextBlockRegexps = []*regexp.Regexp{
	regexp.MustCompile(`(?is)<system-reminder\b[^>]*>.*?</system-reminder\s*>`),
	regexp.MustCompile(`(?is)<image_local_path\b[^>]*>.*?</image_local_path\s*>`),
	regexp.MustCompile(`(?is)<codex_internal_context\b[^>]*>.*?</codex_internal_context\s*>`),
}

// Unterminated variants of the blocks above: everything from that point on is
// scaffolding as well.
var promptUnclosedTags = []string{"<system-reminder", "<codex_internal_context"}

// Tags that only wrap the real user text: keep the content, drop the tags.
var promptWrapperTagRegexp = regexp.MustCompile(`(?is)</?user_query\b[^>]*>`)

var promptBlankLineRegexp = regexp.MustCompile(`\n{3,}`)

// appendPromptPreview stores a truncated preview of the user prompt on the log.
// The preview is nested under other.admin_info, so model.formatUserLogs strips
// it from ordinary users' log views while admins can still audit requests.
// Only the last user message is kept: clients resend the whole conversation on
// every turn, so the tail entry is the one that belongs to this request.
func appendPromptPreview(relayInfo *relaycommon.RelayInfo, other *model.LogOther) {
	if other == nil || relayInfo == nil || !common.LogPromptEnabled {
		return
	}
	text, ok := extractPromptText(relayInfo.Request)
	if !ok {
		return
	}
	totalChars := utf8.RuneCountInString(text)
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	limit := common.LogPromptMaxChars
	if limit <= 0 {
		limit = defaultLogPromptMaxChars
	}
	if limit > maxLogPromptMaxChars {
		limit = maxLogPromptMaxChars
	}
	other.SetAdmin(logPromptPreviewKey, truncateRunes(text, limit))
	other.SetAdmin(logPromptCharsKey, totalChars)
}

// extractPromptText returns the text of the last user message for the request
// formats that carry a prompt. Media attachments are dropped: only text parts
// are kept so that base64 payloads never reach the log database.
func extractPromptText(req dto.Request) (string, bool) {
	if req == nil {
		return "", false
	}
	switch r := req.(type) {
	case *dto.GeneralOpenAIRequest:
		if r == nil {
			return "", false
		}
		if text := lastUserMessageText(r.Messages); text != "" {
			return text, true
		}
		if text := contentToText(r.Prompt); text != "" {
			return text, true
		}
	case *dto.ClaudeRequest:
		if r == nil {
			return "", false
		}
		for i := len(r.Messages) - 1; i >= 0; i-- {
			if !strings.EqualFold(r.Messages[i].Role, "user") {
				continue
			}
			if text := cleanUserText(contentToText(r.Messages[i].Content)); text != "" {
				return text, true
			}
		}
		if text := contentToText(r.Prompt); text != "" {
			return text, true
		}
	case *dto.GeminiChatRequest:
		if r == nil {
			return "", false
		}
		for i := len(r.Contents) - 1; i >= 0; i-- {
			if !strings.EqualFold(r.Contents[i].Role, "user") {
				continue
			}
			if text := cleanUserText(geminiPartsText(r.Contents[i].Parts)); text != "" {
				return text, true
			}
		}
	case *dto.OpenAIResponsesRequest:
		if r == nil {
			return "", false
		}
		if text := cleanUserText(responsesInputText(r.Input)); text != "" {
			return text, true
		}
	case *dto.ImageRequest:
		if r == nil {
			return "", false
		}
		if strings.TrimSpace(r.Prompt) != "" {
			return r.Prompt, true
		}
	case *dto.EmbeddingRequest:
		if r == nil {
			return "", false
		}
		if text := contentToText(r.Input); text != "" {
			return text, true
		}
	case *dto.RerankRequest:
		if r == nil {
			return "", false
		}
		if strings.TrimSpace(r.Query) != "" {
			return r.Query, true
		}
	}
	return "", false
}

func lastUserMessageText(messages []dto.Message) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if !strings.EqualFold(messages[i].Role, "user") {
			continue
		}
		if text := cleanUserText(messageContentText(&messages[i])); text != "" {
			return text
		}
	}
	return ""
}

// cleanUserText removes agent scaffolding from a user message so the preview
// holds what the person actually asked. Context blocks are dropped entirely,
// while <user_query> wrappers keep their inner text.
func cleanUserText(text string) string {
	if text == "" {
		return ""
	}
	objective := codexGoalObjective(text)
	for _, pattern := range promptContextBlockRegexps {
		text = pattern.ReplaceAllString(text, "")
	}
	text = promptWrapperTagRegexp.ReplaceAllString(text, "")
	for _, tag := range promptUnclosedTags {
		if index := strings.Index(text, tag); index >= 0 {
			text = text[:index]
		}
	}
	text = promptBlankLineRegexp.ReplaceAllString(text, "\n\n")
	text = strings.TrimSpace(text)
	if text == "" {
		// Goal-mode turns carry no text of their own; the standing objective is
		// the closest thing to what the person asked for.
		return objective
	}
	return text
}

// codexGoalObjective returns the <objective> payload of a Codex goal-mode
// message, which is the only user-meaningful part of that internal context.
func codexGoalObjective(text string) string {
	if !strings.Contains(text, "<codex_internal_context") {
		return ""
	}
	_, afterOpen, ok := strings.Cut(text, "<objective>")
	if !ok {
		return ""
	}
	objective, _, ok := strings.Cut(afterOpen, "</objective>")
	if !ok {
		return ""
	}
	return strings.TrimSpace(objective)
}

// messageContentText keeps only text parts, whether Content holds a plain
// string or a media array holding image/audio/file parts.
func messageContentText(message *dto.Message) string {
	if message == nil {
		return ""
	}
	if text, ok := message.Content.(string); ok {
		return text
	}
	var builder strings.Builder
	for _, part := range message.ParseContent() {
		if part.Text == "" {
			continue
		}
		builder.WriteString(part.Text)
	}
	return builder.String()
}

func geminiPartsText(parts []dto.GeminiPart) string {
	var builder strings.Builder
	for _, part := range parts {
		if part.Thought || part.Text == "" {
			continue
		}
		builder.WriteString(part.Text)
	}
	return builder.String()
}

// contentToText normalizes the loosely typed content fields used by Claude and
// Embedding requests: a plain string, a list of strings, or a list of content
// parts where only text parts are kept.
func contentToText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []string:
		return strings.Join(typed, "\n")
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			switch entry := item.(type) {
			case string:
				if entry != "" {
					parts = append(parts, entry)
				}
			case map[string]any:
				if !isTextPart(entry) {
					continue
				}
				if text, ok := entry["text"].(string); ok && text != "" {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func isTextPart(part map[string]any) bool {
	partType, _ := part["type"].(string)
	if partType == "" {
		return true
	}
	return partType == "text" || strings.HasSuffix(partType, "_text")
}

// responsesInputText reads the last user entry from the OpenAI Responses API
// `input` field, which accepts either a bare string or a list of items.
func responsesInputText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var decoded any
	if err := common.Unmarshal(raw, &decoded); err != nil {
		return ""
	}
	switch typed := decoded.(type) {
	case string:
		return typed
	case []any:
		for i := len(typed) - 1; i >= 0; i-- {
			entry, ok := typed[i].(map[string]any)
			if !ok {
				continue
			}
			role, _ := entry["role"].(string)
			if !strings.EqualFold(role, "user") {
				continue
			}
			if text := contentToText(entry["content"]); text != "" {
				return text
			}
		}
	}
	return ""
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit]) + "…"
}
