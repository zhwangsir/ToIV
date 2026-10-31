package outbound

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// 2026-10-08:允许列表支持端口级条目(127.0.0.1:8090),生产只放行 ToIV API 端口。
func TestAllowedPrivateUpstreamPortQualifiedEntries(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", " 127.0.0.1:8090 , [::1]:8090, legacy.internal ")
	cases := []struct {
		host, port string
		want       bool
	}{
		{"127.0.0.1", "8090", true},
		{"127.0.0.1", "8196", false},
		{"127.0.0.1", "", false},
		{"::1", "8090", true},
		{"[::1]", "8090", true},
		{"::1", "8091", false},
		{"legacy.internal", "1234", true},
		{"legacy.internal", "", true},
		{"127.0.0.2", "8090", false},
	}
	for _, c := range cases {
		if got := AllowedPrivateUpstream(c.host, c.port); got != c.want {
			t.Errorf("AllowedPrivateUpstream(%q,%q)=%v want %v", c.host, c.port, got, c.want)
		}
	}
	if AllowedPrivateUpstreamHost("127.0.0.1") {
		t.Error("port-qualified entry must not allow host-only checks")
	}
}

func TestValidateURLsHonourPortQualifiedAllowlist(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1:8090")
	for _, ok := range []string{"http://127.0.0.1:8090/api/h3/i2v", "http://127.0.0.1:8090"} {
		if _, err := ValidateOutboundURL(ok); err != nil {
			t.Errorf("ValidateOutboundURL(%q) error = %v", ok, err)
		}
		if _, err := ValidateCustomRelayURL(ok); err != nil {
			t.Errorf("ValidateCustomRelayURL(%q) error = %v", ok, err)
		}
	}
	for _, bad := range []string{"http://127.0.0.1:8196/", "http://127.0.0.1/", "https://127.0.0.1:8205/", "http://127.0.0.1:18090/"} {
		if _, err := ValidateOutboundURL(bad); err == nil {
			t.Errorf("ValidateOutboundURL(%q) should be blocked", bad)
		}
		if _, err := ValidateCustomRelayURL(bad); err == nil {
			t.Errorf("ValidateCustomRelayURL(%q) should be blocked", bad)
		}
	}
}

// 拨号层也按端口判定:即使 URL 校验被绕过(如重定向/代理以外的直连),其他端口照样被拦。
func TestOutboundTransportDialBlocksUnlistedLoopbackPort(t *testing.T) {
	allowed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	defer allowed.Close()
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "leak") }))
	defer other.Close()
	allowedURL, _ := url.Parse(allowed.URL)
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1:"+allowedURL.Port())
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("http_proxy", "")
	client := &http.Client{Transport: newOutboundTransport(resolveOutboundHostPort), Timeout: 5 * time.Second}
	resp, err := client.Get(allowed.URL)
	if err != nil {
		t.Fatalf("allowed port: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "ok" {
		t.Fatalf("allowed body = %q", body)
	}
	if _, err := client.Get(other.URL); err == nil || !strings.Contains(err.Error(), "不允许访问本机") {
		t.Fatalf("unlisted loopback port should be blocked at dial, err = %v", err)
	}
}
