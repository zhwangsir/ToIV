package outbound

import (
	"strings"
	"testing"
)

func TestOutboundHostAllowedDefaultsAndEnv(t *testing.T) {
	t.Cleanup(ResetOutboundHostAllowlistExtras)
	ResetOutboundHostAllowlistExtras()
	t.Setenv(EnvOutboundHostAllowlist, " staging.toiv.example , [2001:db8::1]:8443 ")

	cases := []struct {
		host, port string
		want       bool
	}{
		{"toiv.wineryz.top", "443", true},
		{"toiv.wineryz.top", "8090", true}, // host-only default: any port
		{"updates.beefapi.com", "443", true},
		{"updates.beefapi.com", "8443", true}, // host-only default: any port
		{"localhost", "8090", true},
		{"127.0.0.1", "8090", true},
		{"::1", "8090", true},
		{"[::1]", "443", true},
		{"staging.toiv.example", "443", true},
		{"2001:db8::1", "8443", true},
		{"2001:db8::1", "443", false}, // port-qualified env entry
		{"evil.example", "443", false},
		{"", "443", false},
		{"toiv.wineryz.top.evil.example", "443", false},
	}
	for _, c := range cases {
		if got := OutboundHostAllowed(c.host, c.port); got != c.want {
			t.Errorf("OutboundHostAllowed(%q,%q)=%v want %v", c.host, c.port, got, c.want)
		}
	}
}

func TestAppendOutboundHostAllowlist(t *testing.T) {
	t.Cleanup(ResetOutboundHostAllowlistExtras)
	ResetOutboundHostAllowlistExtras()
	t.Setenv(EnvOutboundHostAllowlist, "")

	if OutboundHostAllowed("api.staging.test", "443") {
		t.Fatal("staging host should be denied before append")
	}
	AppendOutboundHostAllowlist("api.staging.test", "api.staging.test", "10.77.0.5:18090")
	if !OutboundHostAllowed("api.staging.test", "8090") {
		t.Fatal("appended host-only entry should allow any port")
	}
	if !OutboundHostAllowed("10.77.0.5", "18090") {
		t.Fatal("appended port-qualified entry should allow that port")
	}
	if OutboundHostAllowed("10.77.0.5", "18091") {
		t.Fatal("port-qualified extra must not allow other ports")
	}
}

func TestValidateAllowlistedOutboundURL(t *testing.T) {
	t.Cleanup(ResetOutboundHostAllowlistExtras)
	ResetOutboundHostAllowlistExtras()
	t.Setenv(EnvOutboundHostAllowlist, "")
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1:8090")

	if _, err := ValidateAllowlistedOutboundURL("https://toiv.wineryz.top/api/auth/me"); err != nil {
		t.Fatalf("production API should be allowed: %v", err)
	}
	if _, err := ValidateAllowlistedOutboundURL("https://updates.beefapi.com/beeftv/desktop-update.json"); err != nil {
		t.Fatalf("default updater CDN feed should be allowed: %v", err)
	}
	if _, err := ValidateAllowlistedOutboundURL("http://127.0.0.1:8090/api/h3/i2v"); err != nil {
		t.Fatalf("allowlisted loopback ToIV API should pass: %v", err)
	}

	for _, raw := range []string{"", "   ", "not-a-url", "://missing-host", "ftp://toiv.wineryz.top/", "https://user:pass@toiv.wineryz.top/"} {
		if _, err := ValidateAllowlistedOutboundURL(raw); err == nil {
			t.Errorf("ValidateAllowlistedOutboundURL(%q) should reject empty/malformed", raw)
		}
	}
	if _, err := ValidateAllowlistedOutboundURL("https://evil.example/exfil"); err == nil || !strings.Contains(err.Error(), "允许列表") {
		t.Fatalf("unlisted host should be rejected with allowlist message, err=%v", err)
	}
	// host on allowlist but private port not in private-upstream list
	if _, err := ValidateAllowlistedOutboundURL("http://127.0.0.1:8196/"); err == nil {
		t.Fatal("loopback unlisted port should still fail SSRF private check")
	}
}
