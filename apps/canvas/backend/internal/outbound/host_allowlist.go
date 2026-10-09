package outbound

import (
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
)

// EnvOutboundHostAllowlist extends the default ToIV/local hosts that desktop
// (and any caller of ValidateAllowlistedOutboundURL) may contact. Entries are
// comma-separated "host" (any port) or "host:port" / "[ipv6]:port".
const EnvOutboundHostAllowlist = "CANVAS_OUTBOUND_HOST_ALLOWLIST"

// defaultOutboundHosts are always allowed. Production API, desktop updater CDN
// (updates.beefapi.com), plus local loopback for TOIV_API_BASE overrides during
// development and desktop smoke tests.
var defaultOutboundHosts = []string{
	"toiv.wineryz.top",
	"updates.beefapi.com",
	"localhost",
	"127.0.0.1",
	"::1",
}

var (
	extraOutboundHostsMu sync.Mutex
	extraOutboundHosts   []string // process-local additions (desktop registers apiBase)
)

// AppendOutboundHostAllowlist registers hosts for this process (e.g. TOIV_API_BASE).
// Empty / duplicate entries are ignored. Does not mutate the env string.
func AppendOutboundHostAllowlist(hosts ...string) {
	extraOutboundHostsMu.Lock()
	defer extraOutboundHostsMu.Unlock()
	for _, raw := range hosts {
		host, port := splitAllowlistEntry(raw)
		if host == "" {
			continue
		}
		entry := host
		if port != "" {
			entry = net.JoinHostPort(host, port)
		}
		dup := false
		for _, existing := range extraOutboundHosts {
			if existing == entry {
				dup = true
				break
			}
		}
		if !dup {
			extraOutboundHosts = append(extraOutboundHosts, entry)
		}
	}
}

// ResetOutboundHostAllowlistExtras clears process-local extras (tests only).
func ResetOutboundHostAllowlistExtras() {
	extraOutboundHostsMu.Lock()
	extraOutboundHosts = nil
	extraOutboundHostsMu.Unlock()
}

// OutboundHostAllowed reports whether host[:port] is on the default list,
// CANVAS_OUTBOUND_HOST_ALLOWLIST, or process-local extras. No DNS lookup.
func OutboundHostAllowed(host string, port string) bool {
	host = normalizeOutboundHost(strings.Trim(host, "[]"))
	port = strings.TrimSpace(port)
	if host == "" {
		return false
	}
	if matchOutboundAllowlistEntries(defaultOutboundHosts, host, port) {
		return true
	}
	if matchOutboundAllowlistEntries(strings.Split(os.Getenv(EnvOutboundHostAllowlist), ","), host, port) {
		return true
	}
	extraOutboundHostsMu.Lock()
	extras := append([]string(nil), extraOutboundHosts...)
	extraOutboundHostsMu.Unlock()
	return matchOutboundAllowlistEntries(extras, host, port)
}

func matchOutboundAllowlistEntries(entries []string, host, port string) bool {
	for _, configured := range entries {
		entryHost, entryPort := splitAllowlistEntry(configured)
		if entryHost == "" || entryHost != host {
			continue
		}
		if entryPort == "" || entryPort == port {
			return true
		}
	}
	return false
}

// ValidateAllowlistedOutboundURL rejects empty/malformed URLs and hosts outside
// the positive allowlist, then applies the existing SSRF checks in ValidateOutboundURL.
func ValidateAllowlistedOutboundURL(rawURL string) (*url.URL, error) {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return nil, BadAuthRequest("出站地址无效")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Hostname() == "" || !parsed.IsAbs() {
		return nil, BadAuthRequest("出站地址无效")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return nil, BadAuthRequest("出站地址只支持 http/https")
	}
	if parsed.User != nil {
		return nil, BadAuthRequest("出站地址不允许包含认证信息")
	}
	if !OutboundHostAllowed(parsed.Hostname(), effectivePort(parsed)) {
		return nil, BadAuthRequest("出站目标不在允许列表")
	}
	return ValidateOutboundURL(trimmed)
}
