package httptransport

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// UserIdentityHeader is the per-request identity that the ToIV Next server asserts after it
// has verified the user's ToIV JWT itself (M7 multi-tenant). canvas-api never sees the JWT
// on this path; it trusts the header only when
//
//   - the TCP peer is the local/intranet proxy (CANVAS_TRUSTED_PROXY_CIDRS, loopback by default),
//   - the HMAC verifies with the key shared with the Next server (CANVAS_USER_IDENTITY_KEY_FILE),
//   - the timestamp is within ±60 s and the MAC binds the request method and path.
//
// Format: v1.<uid>.<role>.<unix-seconds>.<hex HMAC-SHA256>, MAC over
// "toiv-user\nv1\n<uid>\n<role>\n<unix>\n<METHOD>\n<decoded request path without query>".
const UserIdentityHeader = "X-ToIV-User"

const (
	userIdentityDomain  = "toiv-user"
	userIdentityVersion = "v1"
	minUserKeyBytes     = 32
)

// Roles the Next server may assert. Anything else is rejected.
const (
	RoleAdmin = "admin"
	RoleUser  = "user"
)

var identityUIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,36}$`)

// IdentityKind tells which door a request came through.
type IdentityKind string

const (
	// IdentityUser: signed X-ToIV-User from the trusted Next proxy.
	IdentityUser IdentityKind = "user"
	// IdentityToivBearer: optional direct ToIV bearer/cookie door (off unless CANVAS_TOIV_DIRECT_AUTH=1).
	IdentityToivBearer IdentityKind = "toiv-bearer"
	// IdentityPlatform: gate-signed ops identity (refresh script, admin tooling). Maps to the
	// platform owner (BEEFTV_GATE_UID) and is the only door that may read channel secrets.
	IdentityPlatform IdentityKind = "platform"
	// IdentityAssistantHost: the built-in assistant child process calling the ops entry from
	// loopback with its host token; its workspace is resolved from the turn it acts for.
	IdentityAssistantHost IdentityKind = "assistant-host"
)

// Identity is the verified caller of one request.
type Identity struct {
	UID  string
	Role string
	Kind IdentityKind
}

func (i Identity) IsAdmin() bool { return i.Role == RoleAdmin }

type requestIdentityKey struct{}

// IdentityFrom returns the identity attached by RequireIdentity.
func IdentityFrom(r *http.Request) (Identity, bool) {
	if r == nil {
		return Identity{}, false
	}
	return IdentityFromContext(r.Context())
}

func IdentityFromContext(ctx context.Context) (Identity, bool) {
	if ctx == nil {
		return Identity{}, false
	}
	value, ok := ctx.Value(requestIdentityKey{}).(Identity)
	return value, ok
}

// WithIdentity attaches an identity (used by RequireIdentity and tests).
func WithIdentity(ctx context.Context, identity Identity) context.Context {
	ctx = context.WithValue(ctx, requestIdentityKey{}, identity)
	ctx = context.WithValue(ctx, gateIdentityKey{}, true)
	if identity.Kind == IdentityUser || identity.Kind == IdentityToivBearer {
		// A verified product login is the trust source the assistant UI session accepts.
		ctx = context.WithValue(ctx, toivIdentityKey{}, true)
	}
	return ctx
}

// UserIdentity verifies X-ToIV-User.
type UserIdentity struct {
	Key            []byte
	Skew           time.Duration
	Now            func() time.Time
	TrustedProxies []*net.IPNet
}

func userIdentityPath(r *http.Request) string {
	if r.URL != nil && r.URL.Path != "" {
		return r.URL.Path
	}
	return "/"
}

func userIdentityMAC(key []byte, uid, role string, ts int64, method, path string) []byte {
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "%s\n%s\n%s\n%s\n%d\n%s\n%s", userIdentityDomain, userIdentityVersion, uid, role, ts, strings.ToUpper(method), path)
	return mac.Sum(nil)
}

// SignUserIdentity builds the header value. path is the decoded request path as canvas-api
// sees it (e.g. /api/canvas-projects), without the query string.
func SignUserIdentity(key []byte, uid, role string, ts int64, method, path string) string {
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	return fmt.Sprintf("%s.%s.%s.%d.%s", userIdentityVersion, uid, role, ts, hex.EncodeToString(userIdentityMAC(key, uid, role, ts, method, path)))
}

// TrustedPeer reports whether remoteAddr belongs to the configured proxy networks.
func (u UserIdentity) TrustedPeer(remoteAddr string) bool {
	return peerInNetworks(remoteAddr, u.TrustedProxies)
}

func peerInNetworks(remoteAddr string, networks []*net.IPNet) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return false
	}
	for _, network := range networks {
		if network != nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

// Verify returns the identity, or a non-zero HTTP status and a reason.
func (u UserIdentity) Verify(r *http.Request) (Identity, int, string) {
	raw := strings.TrimSpace(r.Header.Get(UserIdentityHeader))
	if raw == "" {
		return Identity{}, http.StatusUnauthorized, "user_identity_required"
	}
	if !u.TrustedPeer(r.RemoteAddr) {
		return Identity{}, http.StatusForbidden, "user_identity_untrusted_peer"
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 5 || parts[0] != userIdentityVersion {
		return Identity{}, http.StatusUnauthorized, "user_identity_invalid"
	}
	uid, role := parts[1], parts[2]
	if !identityUIDPattern.MatchString(uid) || (role != RoleAdmin && role != RoleUser) {
		return Identity{}, http.StatusUnauthorized, "user_identity_invalid"
	}
	ts, err := strconv.ParseInt(parts[3], 10, 64)
	sig, hexErr := hex.DecodeString(parts[4])
	if err != nil || hexErr != nil || len(sig) != sha256.Size {
		return Identity{}, http.StatusUnauthorized, "user_identity_invalid"
	}
	now := time.Now
	if u.Now != nil {
		now = u.Now
	}
	skew := u.Skew
	if skew <= 0 {
		skew = DefaultGateIdentitySkew
	}
	if delta := now().Unix() - ts; delta > int64(skew/time.Second) || delta < -int64(skew/time.Second) {
		return Identity{}, http.StatusUnauthorized, "user_identity_expired"
	}
	if len(u.Key) < minUserKeyBytes || !hmac.Equal(sig, userIdentityMAC(u.Key, uid, role, ts, r.Method, userIdentityPath(r))) {
		return Identity{}, http.StatusUnauthorized, "user_identity_invalid"
	}
	return Identity{UID: uid, Role: role, Kind: IdentityUser}, 0, ""
}

// DefaultTrustedProxyCIDRs: only loopback unless the operator widens it.
const DefaultTrustedProxyCIDRs = "127.0.0.0/8,::1/128"

func ParseCIDRList(raw string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			if ip := net.ParseIP(part); ip != nil && ip.To4() != nil {
				part += "/32"
			} else {
				part += "/128"
			}
		}
		_, network, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("CANVAS_TRUSTED_PROXY_CIDRS 无效: %q", part)
		}
		out = append(out, network)
	}
	if len(out) == 0 {
		return nil, errors.New("CANVAS_TRUSTED_PROXY_CIDRS 不能为空")
	}
	return out, nil
}

// LoadUserIdentity reads CANVAS_USER_IDENTITY_KEY_FILE and CANVAS_TRUSTED_PROXY_CIDRS.
// Unset key file: multi-tenant mode is off (nil). Set but unreadable/short: error, so a
// misconfigured instance never starts open.
func LoadUserIdentity(getenv func(string) string) (*UserIdentity, error) {
	keyFile := strings.TrimSpace(getenv("CANVAS_USER_IDENTITY_KEY_FILE"))
	if keyFile == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, fmt.Errorf("读取用户身份签名密钥：%w", err)
	}
	key := []byte(strings.TrimSpace(string(raw)))
	if len(key) < minUserKeyBytes {
		return nil, errors.New("用户身份签名密钥过短（至少 32 字节）")
	}
	cidrs := strings.TrimSpace(getenv("CANVAS_TRUSTED_PROXY_CIDRS"))
	if cidrs == "" {
		cidrs = DefaultTrustedProxyCIDRs
	}
	networks, err := ParseCIDRList(cidrs)
	if err != nil {
		return nil, err
	}
	return &UserIdentity{Key: key, TrustedProxies: networks}, nil
}

// IdentityPolicy is the multi-tenant front door. Exactly one identity is attached to every
// request that reaches the router; anything else is answered 401/403 before routing.
type IdentityPolicy struct {
	User *UserIdentity
	// Gate: the gate-signed ops identity, accepted only from a trusted peer. It is the
	// platform owner (admin) and the only door allowed to read channel secrets.
	Gate *GateIdentity
	// HostExempt: built-in assistant host ops calls (loopback + host token).
	HostExempt func(*http.Request) bool
	// Toiv: optional direct ToIV bearer/cookie introspection. Nil unless explicitly enabled.
	Toiv func(*http.Request) (uid, role string, ok bool)
}

func writeIdentityError(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"code": status, "data": nil, "msg": "请求未通过身份校验", "reason": reason})
}

func RequireIdentity(p IdentityPolicy) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/health/live" {
				next.ServeHTTP(w, r)
				return
			}
			if strings.TrimSpace(r.Header.Get(UserIdentityHeader)) != "" {
				if p.User == nil {
					writeIdentityError(w, http.StatusUnauthorized, "user_identity_disabled")
					return
				}
				identity, status, reason := p.User.Verify(r)
				if status != 0 {
					writeIdentityError(w, status, reason)
					return
				}
				next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), identity)))
				return
			}
			if p.Gate != nil && strings.TrimSpace(r.Header.Get(GateIdentityHeader)) != "" {
				if p.User != nil && !p.User.TrustedPeer(r.RemoteAddr) {
					writeIdentityError(w, http.StatusForbidden, "gate_identity_untrusted_peer")
					return
				}
				if status, reason := p.Gate.Verify(r); status != 0 {
					writeIdentityError(w, status, reason)
					return
				}
				next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), Identity{UID: p.Gate.UID, Role: RoleAdmin, Kind: IdentityPlatform})))
				return
			}
			if p.HostExempt != nil && p.HostExempt(r) {
				next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), Identity{Role: RoleUser, Kind: IdentityAssistantHost})))
				return
			}
			if p.Toiv != nil {
				if uid, role, ok := p.Toiv(r); ok {
					next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), Identity{UID: uid, Role: role, Kind: IdentityToivBearer})))
					return
				}
			}
			writeIdentityError(w, http.StatusUnauthorized, "toiv_identity_required")
		})
	}
}
