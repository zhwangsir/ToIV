package httptransport

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// GateIdentityHeader carries the identity the login gate asserts for a proxied request.
// Format: v1.<uid>.<unix-seconds>.<hex HMAC-SHA256>, MAC over
// "v1\n<uid>\n<unix>\n<METHOD>\n<request path without query>" with a key that only the gate
// and this one per-user backend know. Anything else (missing, forged, stale, or signed for
// another user) is rejected before routing.
const GateIdentityHeader = "X-Beeftv-Gate-Auth"

const (
	gateIdentityVersion     = "v1"
	DefaultGateIdentitySkew = 60 * time.Second
	minGateKeyBytes         = 32
)

type GateIdentity struct {
	UID    string
	Key    []byte
	Skew   time.Duration
	Now    func() time.Time
	Exempt func(*http.Request) bool
}

type gateIdentityKey struct{}

// GateAuthenticated reports whether the request carried a valid gate identity.
func GateAuthenticated(r *http.Request) bool {
	ok, _ := r.Context().Value(gateIdentityKey{}).(bool)
	return ok
}

func gatePath(requestURI string) string {
	if i := strings.IndexByte(requestURI, '?'); i >= 0 {
		requestURI = requestURI[:i]
	}
	if requestURI == "" {
		return "/"
	}
	return requestURI
}

func gateMAC(key []byte, uid string, ts int64, method, requestURI string) []byte {
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "%s\n%s\n%d\n%s\n%s", gateIdentityVersion, uid, ts, strings.ToUpper(method), gatePath(requestURI))
	return mac.Sum(nil)
}

// SignGateIdentity builds the header value (used by tests and Go-side callers; the gate signs in JS).
func SignGateIdentity(key []byte, uid string, ts int64, method, requestURI string) string {
	return fmt.Sprintf("%s.%s.%d.%s", gateIdentityVersion, uid, ts, hex.EncodeToString(gateMAC(key, uid, ts, method, requestURI)))
}

// Verify returns 0 when the request is authenticated, otherwise the HTTP status and reason.
func (g GateIdentity) Verify(r *http.Request) (int, string) {
	raw := strings.TrimSpace(r.Header.Get(GateIdentityHeader))
	if raw == "" {
		return http.StatusUnauthorized, "gate_identity_required"
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 4 || parts[0] != gateIdentityVersion || parts[1] == "" {
		return http.StatusUnauthorized, "gate_identity_invalid"
	}
	ts, err := strconv.ParseInt(parts[2], 10, 64)
	sig, hexErr := hex.DecodeString(parts[3])
	if err != nil || hexErr != nil || len(sig) != sha256.Size {
		return http.StatusUnauthorized, "gate_identity_invalid"
	}
	if parts[1] != g.UID {
		return http.StatusForbidden, "gate_identity_mismatch"
	}
	now := time.Now
	if g.Now != nil {
		now = g.Now
	}
	skew := g.Skew
	if skew <= 0 {
		skew = DefaultGateIdentitySkew
	}
	if delta := now().Unix() - ts; delta > int64(skew/time.Second) || delta < -int64(skew/time.Second) {
		return http.StatusUnauthorized, "gate_identity_expired"
	}
	requestURI := r.RequestURI
	if requestURI == "" && r.URL != nil {
		requestURI = r.URL.RequestURI()
	}
	if !hmac.Equal(sig, gateMAC(g.Key, g.UID, ts, r.Method, requestURI)) {
		return http.StatusUnauthorized, "gate_identity_invalid"
	}
	return 0, ""
}

func RequireGateIdentity(g GateIdentity) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/health/live" || (g.Exempt != nil && g.Exempt(r)) {
				next.ServeHTTP(w, r)
				return
			}
			if status, reason := g.Verify(r); status != 0 {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("Cache-Control", "no-store")
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": status, "data": nil, "msg": "请求未通过登录网关校验", "reason": reason})
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), gateIdentityKey{}, true)))
		})
	}
}

// LoadGateIdentity reads BEEFTV_GATE_UID / BEEFTV_GATE_KEY_FILE. Neither set: disabled (nil).
// Only one set, unreadable or short key: error, so a misconfigured pool backend never starts open.
func LoadGateIdentity(getenv func(string) string) (*GateIdentity, error) {
	uid := strings.TrimSpace(getenv("BEEFTV_GATE_UID"))
	keyFile := strings.TrimSpace(getenv("BEEFTV_GATE_KEY_FILE"))
	if uid == "" && keyFile == "" {
		return nil, nil
	}
	if uid == "" || keyFile == "" {
		return nil, errors.New("BEEFTV_GATE_UID 与 BEEFTV_GATE_KEY_FILE 必须同时设置")
	}
	raw, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, fmt.Errorf("读取网关签名密钥：%w", err)
	}
	key := []byte(strings.TrimSpace(string(raw)))
	if len(key) < minGateKeyBytes {
		return nil, errors.New("网关签名密钥过短")
	}
	return &GateIdentity{UID: uid, Key: key}, nil
}
