package desktopupdate

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/outbound"
)

func allowLocalUpdaterHosts(t *testing.T) {
	t.Helper()
	t.Cleanup(outbound.ResetOutboundHostAllowlistExtras)
	outbound.ResetOutboundHostAllowlistExtras()
	// httptest TLS servers bind loopback; host allowlist already includes them,
	// but SSRF still needs an explicit private-upstream pin (any port).
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1,localhost,::1")
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "false")
}

func TestNormalizeFeedURLAllowlist(t *testing.T) {
	allowLocalUpdaterHosts(t)
	t.Setenv(outbound.EnvOutboundHostAllowlist, "")

	if got, err := normalizeFeedURL("https://127.0.0.1:8443/desktop-update.json"); err != nil {
		t.Fatalf("allowlisted loopback feed should pass: %v", err)
	} else if !strings.Contains(got, "127.0.0.1:8443") {
		t.Fatalf("unexpected normalize result %q", got)
	}
	if got, err := normalizeFeedURL("https://updates.beefapi.com/beeftv/desktop-update.json"); err != nil {
		t.Fatalf("default CDN feed must pass without CANVAS_OUTBOUND_HOST_ALLOWLIST: %v", err)
	} else if !strings.Contains(got, "updates.beefapi.com") {
		t.Fatalf("unexpected normalize result %q", got)
	}

	for _, raw := range []string{"", "   ", "not-a-url", "http://127.0.0.1:8443/feed", "ftp://toiv.wineryz.top/feed"} {
		if _, err := normalizeFeedURL(raw); err == nil {
			t.Errorf("normalizeFeedURL(%q) should reject empty/non-https", raw)
		}
	}
	if _, err := normalizeFeedURL("https://evil.example/exfil.json"); err == nil || !strings.Contains(err.Error(), "允许列表") {
		t.Fatalf("unlisted host should fail allowlist, err=%v", err)
	}
}

func TestNormalizeFeedURLEnvAllowlistExtends(t *testing.T) {
	allowLocalUpdaterHosts(t)
	// Host-only env entry; SSRF still applies after the positive gate.
	t.Setenv(outbound.EnvOutboundHostAllowlist, "toiv.wineryz.top")
	if _, err := normalizeFeedURL("https://toiv.wineryz.top/desktop-update.json"); err != nil {
		t.Fatalf("env/default production host should pass: %v", err)
	}
	t.Setenv(outbound.EnvOutboundHostAllowlist, "")
	if _, err := normalizeFeedURL("https://evil.example/exfil.json"); err == nil {
		t.Fatal("cleared env must not allow unlisted hosts")
	}
}

func TestHTTPSRedirectsAllowlist(t *testing.T) {
	allowLocalUpdaterHosts(t)
	t.Setenv(outbound.EnvOutboundHostAllowlist, "")

	req := &http.Request{URL: mustURL(t, "https://127.0.0.1:8443/next")}
	if err := httpsRedirects(req, nil); err != nil {
		t.Fatalf("allowlisted redirect should pass: %v", err)
	}
	req = &http.Request{URL: mustURL(t, "https://evil.example/next")}
	if err := httpsRedirects(req, nil); err == nil || !strings.Contains(err.Error(), "允许列表") {
		t.Fatalf("unlisted redirect should fail allowlist, err=%v", err)
	}
	req = &http.Request{URL: mustURL(t, "http://127.0.0.1:8443/next")}
	if err := httpsRedirects(req, nil); err == nil {
		t.Fatal("http redirect must stay rejected")
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
