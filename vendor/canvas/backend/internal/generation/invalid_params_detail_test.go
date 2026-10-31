package generation

import (
	"strings"
	"testing"
)

func TestInvalidParamsShowsShortUpstreamReason(t *testing.T) {
	body := `{"detail":"最长支持 60 秒(分段续写安全上限),当前请求 99 秒,请缩短时长"}`
	f := ClassifyHTTP(422, "Unprocessable Entity", body)
	if f.Category != CategoryInvalidParams {
		t.Fatalf("category = %s", f.Category)
	}
	want := "参数不被接受：最长支持 60 秒(分段续写安全上限),当前请求 99 秒,请缩短时长"
	if got := f.UserMessage(); got != want {
		t.Fatalf("UserMessage = %q, want %q", got, want)
	}
	// 落库后再分类(任务详情读取)必须保持同一文案与类目。
	again := ClassifyText(f.UserMessage())
	if again.Category != CategoryInvalidParams || again.UserMessage() != want {
		t.Fatalf("reclassified = %s %q", again.Category, again.UserMessage())
	}
}

func TestInvalidParamsDetailTruncatesAndKeepsDebugIDs(t *testing.T) {
	long := strings.Repeat("参数", 50)
	f := ClassifyHTTP(400, "", `{"code":"invalid_parameter","message":"`+long+`","request_id":"req-abcdef123"}`)
	msg := f.UserMessage()
	if !strings.HasPrefix(msg, "参数不被接受：") || !strings.Contains(msg, "…") || !strings.Contains(msg, "请求 req-abcdef123") {
		t.Fatalf("UserMessage = %q", msg)
	}
	again := ClassifyText(msg)
	if again.Category != CategoryInvalidParams || again.RequestID != "req-abcdef123" || again.UserMessage() != msg {
		t.Fatalf("reclassified = %s %q %q", again.Category, again.RequestID, again.UserMessage())
	}
}

func TestInvalidParamsKeepsGenericCopyForNonChineseOrEmpty(t *testing.T) {
	for _, body := range []string{
		`{"detail":[{"type":"less_than_equal","loc":["body","duration"],"msg":"Input should be less than or equal to 60"}]}`,
		`{"error":{"code":"invalid_request","message":"bad value for field x"}}`,
		`{"error":{"message":"invalid parameter: prompt=生成油画肖像"}}`,
		``,
	} {
		f := ClassifyHTTP(422, "", body)
		if f.Category != CategoryInvalidParams {
			t.Fatalf("%q category = %s", body, f.Category)
		}
		if strings.HasPrefix(f.UserMessage(), "参数不被接受：") {
			t.Fatalf("%q should keep generic copy, got %q", body, f.UserMessage())
		}
	}
}

func TestInvalidParamsDetailDoesNotLeakSecrets(t *testing.T) {
	f := ClassifyHTTP(422, "", `{"detail":"时长非法 api_key=sk-abcdef0123456789 见 https://internal.example/x?token=abc"}`)
	msg := f.UserMessage()
	if strings.Contains(msg, "sk-") || strings.Contains(msg, "https://") || strings.Contains(msg, "token=") {
		t.Fatalf("leaked: %q", msg)
	}
}
