package generation

import (
	"strings"
	"unicode/utf8"
)

// 2026-10-08:参数类失败(如 ToIV H3 422 "最长支持 60 秒…")原先只显示泛化文案
// "模型不接受当前参数…",用户看不到上游给出的具体原因。当上游消息是面向用户的
// 中文短句时,把它作为原因直接展示(已经过 sanitizeProviderText 脱敏、截断)。

const (
	invalidParamsDetailPrefix   = "参数不被接受："
	maxInvalidParamsDetailRunes = 60
)

// invalidParamsDetail 返回可直接展示给用户的上游参数错误短句;不合适时返回空串。
func invalidParamsDetail(providerMessage string) string {
	message := strings.TrimSpace(providerMessage)
	// 被脱敏过(提示词回显、凭据头)的消息不展示;只有上游本身写成中文短句时才透出。
	if message == "" || strings.Contains(message, "[已隐藏]") || !looksLikeUserFacingChinese(message) {
		return ""
	}
	message = strings.TrimRight(message, "。.;；!！ ")
	if utf8.RuneCountInString(message) > maxInvalidParamsDetailRunes {
		message = truncateRunes(message, maxInvalidParamsDetailRunes) + "…"
	}
	return message
}

// persistedInvalidParamsDetail 识别已落库的 "参数不被接受：…" 文案,重新分类时保持原样。
func persistedInvalidParamsDetail(text string) (Failure, bool) {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, invalidParamsDetailPrefix) {
		return Failure{}, false
	}
	reason := text
	if index := strings.Index(reason, "排查编号："); index >= 0 {
		reason = reason[:index]
	}
	reason = strings.TrimRight(strings.TrimSpace(reason), "。")
	if reason == invalidParamsDetailPrefix {
		return Failure{}, false
	}
	requestID, taskID := persistedReferenceIDs(text)
	return Failure{Category: CategoryInvalidParams, Reason: reason, RequestID: requestID, TaskID: taskID, Structured: true}, true
}
