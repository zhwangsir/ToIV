package handler

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 覆盖 CANVAS_OPS_TRUSTED_ORIGINS 的统一来源准入：
//   · 回环请求（桌面/CLI/同机宿主子进程）行为不变；
//   · Web 入口经反向代理（Host 被改写为后端回环地址、Origin 是前端入口）
//     由可信 Origin 精确匹配放行；
//   · 保留外部 Host 的代理形态要求「可信 Origin + 回环 RemoteAddr」双条件；
//   · 未配置环境变量时不放开任何非同源请求。
func TestIsTrustedOpsSourceRules(t *testing.T) {
	const trustedEnv = "http://192.168.71.47:3100"
	cases := []struct {
		name       string
		env        string // CANVAS_OPS_TRUSTED_ORIGINS
		host       string
		remote     string
		origin     string
		want       bool
		wantLoopback bool // isLoopbackRequest 的期望（仅回环 Host 用例有意义）
	}{
		{"loopback no origin keeps legacy behavior", "", "127.0.0.1:18090", "127.0.0.1:5555", "", true, true},
		{"loopback same origin without env", "", "127.0.0.1:18090", "127.0.0.1:5555", "http://127.0.0.1:18090", true, true},
		// 生产 Web 入口形态：Next 反向代理把 Host 改写为后端回环地址，Origin 是前端入口。
		{"proxied web origin via trusted list", trustedEnv, "127.0.0.1:8290", "127.0.0.1:40000", "http://192.168.71.47:3100", true, true},
		{"untrusted origin via proxy", trustedEnv, "127.0.0.1:8290", "127.0.0.1:40000", "http://evil.example", false, false},
		{"trusted origin wrong port", trustedEnv, "127.0.0.1:8290", "127.0.0.1:40000", "http://192.168.71.47:3101", false, false},
		{"trusted origin scheme mismatch", trustedEnv, "127.0.0.1:8290", "127.0.0.1:40000", "https://192.168.71.47:3100", false, false},
		{"origin with path never matches", trustedEnv, "127.0.0.1:8290", "127.0.0.1:40000", "http://192.168.71.47:3100/evil", false, false},
		{"missing origin on loopback host is same-origin read", trustedEnv, "127.0.0.1:8290", "127.0.0.1:40000", "", true, true},
		// 未配置：同请求形态必须维持原拒绝。
		{"unconfigured env rejects web origin", "", "127.0.0.1:8290", "127.0.0.1:40000", "http://192.168.71.47:3100", false, false},
		// 保留外部 Host 的代理形态：可信 Origin 必须精确匹配，且来源仍须是本机代理。
		{"preserved host trusted origin", trustedEnv, "192.168.71.47:3100", "127.0.0.1:40000", "http://192.168.71.47:3100", true, false},
		{"preserved host missing origin", trustedEnv, "192.168.71.47:3100", "127.0.0.1:40000", "", false, false},
		{"preserved host untrusted origin", trustedEnv, "192.168.71.47:3100", "127.0.0.1:40000", "http://evil.example", false, false},
		{"preserved host remote not loopback", trustedEnv, "192.168.71.47:3100", "10.0.0.9:5555", "http://192.168.71.47:3100", false, false},
		{"preserved host unconfigured env", "", "192.168.71.47:3100", "127.0.0.1:40000", "http://192.168.71.47:3100", false, false},
		// 归一化：默认端口省略、大小写、尾斜杠。
		{"default port elision matches", "http://example.test", "127.0.0.1:8290", "127.0.0.1:40000", "http://example.test:80", true, true},
		{"https default port elision", "https://example.test", "127.0.0.1:8290", "127.0.0.1:40000", "https://example.test:443", true, true},
		{"case-insensitive scheme and host", "HTTP://Example.Test:8443", "127.0.0.1:8290", "127.0.0.1:40000", "http://example.test:8443", true, true},
		{"config trailing slash matches", "http://192.168.71.47:3100/", "127.0.0.1:8290", "127.0.0.1:40000", "http://192.168.71.47:3100", true, true},
		// 多值配置 + 非法条目跳过。
		{"multiple origins second entry", "ftp://bad, junk,, http://10.0.0.5:3100", "127.0.0.1:8290", "127.0.0.1:40000", "http://10.0.0.5:3100", true, true},
		{"invalid entries alone never match", "ftp://bad, junk", "127.0.0.1:8290", "127.0.0.1:40000", "http://10.0.0.5:3100", false, false},
		{"wildcard is not supported", "http://*", "127.0.0.1:8290", "127.0.0.1:40000", "http://anything.example", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CANVAS_OPS_TRUSTED_ORIGINS", tc.env)
			t.Setenv("BEEFTV_ALLOWED_ORIGINS", "")
			req := httptest.NewRequest(http.MethodGet, "http://"+tc.host+"/api/assistant/status", nil)
			req.Host = tc.host
			req.RemoteAddr = tc.remote
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if got := isTrustedOpsSource(req); got != tc.want {
				t.Fatalf("isTrustedOpsSource=%v want %v", got, tc.want)
			}
			if got := isLoopbackRequest(req); got != tc.wantLoopback {
				t.Fatalf("isLoopbackRequest=%v want %v", got, tc.wantLoopback)
			}
		})
	}
}

func TestNormalizeOpsOriginRejectsNonOriginValues(t *testing.T) {
	for _, raw := range []string{
		"", "   ", "junk", "ftp://example.test", "http://", "http:///path",
		"http://example.test/path", "http://example.test/?q=1", "http://example.test/#f",
		"http://user:pass@example.test", "http://*", "http://*.example.test",
	} {
		if _, ok := normalizeOpsOrigin(raw); ok {
			t.Fatalf("normalizeOpsOrigin(%q) unexpectedly accepted", raw)
		}
	}
	for _, raw := range []string{
		"http://127.0.0.1:8290", "https://example.test", "http://example.test/",
		"http://[::1]:8290", "HTTP://Example.TEST",
	} {
		if _, ok := normalizeOpsOrigin(raw); !ok {
			t.Fatalf("normalizeOpsOrigin(%q) unexpectedly rejected", raw)
		}
	}
}

// 路由级验证：/assistant/status 在 Web 入口（Host 已被代理改写为回环、Origin 是前端入口）
// 接受可信 Origin、拒绝非可信 Origin；未配置时维持 403。
func TestAssistantStatusAcceptsTrustedWebOrigin(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	call := func(origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:18090/api/assistant/status", nil)
		req.Host = "127.0.0.1:18090"
		req.RemoteAddr = "127.0.0.1:40000"
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		env.router.ServeHTTP(w, req)
		return w
	}
	t.Setenv("CANVAS_OPS_TRUSTED_ORIGINS", "http://192.168.71.47:3100")
	if w := call("http://192.168.71.47:3100"); w.Code != http.StatusOK {
		t.Fatalf("trusted web origin: %d %s", w.Code, w.Body.String())
	}
	if w := call("http://evil.example"); w.Code != http.StatusForbidden {
		t.Fatalf("untrusted origin: %d %s", w.Code, w.Body.String())
	}
	if w := call(""); w.Code != http.StatusOK {
		t.Fatalf("same-origin read without Origin header: %d %s", w.Code, w.Body.String())
	}
	t.Setenv("CANVAS_OPS_TRUSTED_ORIGINS", "")
	if w := call("http://192.168.71.47:3100"); w.Code != http.StatusForbidden {
		t.Fatalf("unconfigured env must keep 403: %d %s", w.Code, w.Body.String())
	}
}

// 拒绝日志包含来源画像（Host/Origin/远端），不包含凭据头。
func TestOpsSourceDeniedLogsOriginWithoutCredentials(t *testing.T) {
	t.Setenv("CANVAS_OPS_TRUSTED_ORIGINS", "http://192.168.71.47:3100")
	var captured bytes.Buffer
	original := log.Writer()
	log.SetOutput(&captured)
	t.Cleanup(func() { log.SetOutput(original) })

	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8290/api/assistant/ui-session", strings.NewReader("{}"))
	req.Host = "127.0.0.1:8290"
	req.RemoteAddr = "127.0.0.1:40000"
	req.Header.Set("Origin", "http://evil.example")
	req.Header.Set("Authorization", "Bearer secret-token")
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = req

	opsSourceDenied(c, "只接受本机同源请求")

	if !strings.Contains(captured.String(), `origin="http://evil.example"`) {
		t.Fatalf("log missing origin: %s", captured.String())
	}
	if !strings.Contains(captured.String(), "ops_source_denied") {
		t.Fatalf("log missing marker: %s", captured.String())
	}
	if strings.Contains(captured.String(), "secret-token") {
		t.Fatalf("log must not contain credentials: %s", captured.String())
	}
}
