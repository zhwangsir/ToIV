package httptransport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ToivJWTAuth lets the canvas API accept the product's own login tokens directly (M4-4).
// It introspects Authorization: Bearer <token> against ToIV GET /api/auth/me — the exact
// contract the login gate has used since M3b — so no signing secret is shared with this
// process. Positive verdicts are cached for a short window (the gate caches 60 s too);
// negatives are never cached, so revoked tokens stop working on the very next request.
type ToivJWTAuth struct {
	BaseURL  string        // e.g. http://127.0.0.1:8090 (loopback to the ToIV API)
	Client   *http.Client  // defaults to a 5 s timeout client
	CacheTTL time.Duration // defaults to 60 s
	Now      func() time.Time

	mu    sync.Mutex
	cache map[string]time.Time // sha256(token) -> verdict valid until
}

const toivAuthCacheLimit = 256

func (a *ToivJWTAuth) ttl() time.Duration {
	if a.CacheTTL > 0 {
		return a.CacheTTL
	}
	return 60 * time.Second
}

func (a *ToivJWTAuth) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

func (a *ToivJWTAuth) client() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return &http.Client{Timeout: 5 * time.Second}
}

// Authenticate reports whether the request carries a currently-valid ToIV bearer token.
func (a *ToivJWTAuth) Authenticate(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if token == "" || len(token) > 4096 {
		return false
	}
	sum := sha256.Sum256([]byte(token))
	key := hex.EncodeToString(sum[:])
	now := a.now()
	a.mu.Lock()
	if a.cache == nil {
		a.cache = make(map[string]time.Time)
	}
	if exp, ok := a.cache[key]; ok && now.Before(exp) {
		a.mu.Unlock()
		return true
	}
	a.mu.Unlock()

	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(a.BaseURL, "/")+"/api/auth/me", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := a.client().Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var body struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.User.ID == "" {
		return false
	}
	a.mu.Lock()
	if len(a.cache) >= toivAuthCacheLimit {
		a.cache = make(map[string]time.Time) // single-admin deployment: a full reset is fine
	}
	a.cache[key] = now.Add(a.ttl())
	a.mu.Unlock()
	return true
}

func withGateAuthenticated(r *http.Request) context.Context {
	return context.WithValue(r.Context(), gateIdentityKey{}, true)
}

// RequireGateIdentityOr keeps the M6a gate-signed identity as the primary check and accepts
// the alternative authenticator (ToIV bearer) as a second, independent way in. Either way in
// marks the request GateAuthenticated, because downstream code only asks "did the front door
// vouch for this request", not which lock it turned.
func RequireGateIdentityOr(gate GateIdentity, alt func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		gated := RequireGateIdentity(gate)(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/health/live" && alt != nil && alt(r) {
				next.ServeHTTP(w, r.WithContext(withGateAuthenticated(r)))
				return
			}
			gated.ServeHTTP(w, r)
		})
	}
}

// RequireAlternativeAuth guards the API when only an alternative authenticator is configured
// (M4-4 end state: the gate is retired, ToIV bearer tokens are the only way in).
func RequireAlternativeAuth(alt func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/health/live" || (alt != nil && alt(r)) {
				next.ServeHTTP(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": http.StatusUnauthorized, "data": nil, "msg": "请求未通过登录网关校验", "reason": "toiv_identity_required"})
		})
	}
}

// LoadToivJWTAuth reads CANVAS_TOIV_AUTH_BASE. Unset: disabled (nil). Set but malformed: error,
// so a typo never silently opens (or closes) the front door.
func LoadToivJWTAuth(getenv func(string) string) (*ToivJWTAuth, error) {
	base := strings.TrimSpace(getenv("CANVAS_TOIV_AUTH_BASE"))
	if base == "" {
		return nil, nil
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("CANVAS_TOIV_AUTH_BASE 必须是 http(s)://host:port")
	}
	return &ToivJWTAuth{BaseURL: base}, nil
}
