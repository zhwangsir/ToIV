package httptransport

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testUserIdentity(t *testing.T) (*UserIdentity, []byte, time.Time) {
	t.Helper()
	key := []byte("0123456789abcdef0123456789abcdef-test-key")
	networks, err := ParseCIDRList(DefaultTrustedProxyCIDRs)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	return &UserIdentity{Key: key, TrustedProxies: networks, Now: func() time.Time { return now }}, key, now
}

func identityRequest(method, target, remote, header string) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	r.RemoteAddr = remote
	if header != "" {
		r.Header.Set(UserIdentityHeader, header)
	}
	return r
}

func TestUserIdentityVerify(t *testing.T) {
	u, key, now := testUserIdentity(t)
	uid := "7a757fb1aaaabbbbccccddddeeeeffff"
	good := SignUserIdentity(key, uid, RoleUser, now.Unix(), "GET", "/api/canvas-projects")
	cases := []struct {
		name, method, target, remote, header string
		status                               int
		reason                               string
	}{
		{"valid", "GET", "/api/canvas-projects?x=1", "127.0.0.1:5000", good, 0, ""},
		{"missing", "GET", "/api/canvas-projects", "127.0.0.1:5000", "", 401, "user_identity_required"},
		{"untrusted peer", "GET", "/api/canvas-projects", "203.0.113.9:5000", good, 403, "user_identity_untrusted_peer"},
		{"other method", "DELETE", "/api/canvas-projects", "127.0.0.1:5000", good, 401, "user_identity_invalid"},
		{"other path", "GET", "/api/assets", "127.0.0.1:5000", good, 401, "user_identity_invalid"},
		{"forged key", "GET", "/api/canvas-projects", "127.0.0.1:5000", SignUserIdentity([]byte("ffffffffffffffffffffffffffffffffffff"), uid, RoleUser, now.Unix(), "GET", "/api/canvas-projects"), 401, "user_identity_invalid"},
		{"role escalation", "GET", "/api/canvas-projects", "127.0.0.1:5000", "v1." + uid + ".admin." + good[len("v1."+uid+".user."):], 401, "user_identity_invalid"},
		{"expired", "GET", "/api/canvas-projects", "127.0.0.1:5000", SignUserIdentity(key, uid, RoleUser, now.Add(-2*time.Minute).Unix(), "GET", "/api/canvas-projects"), 401, "user_identity_expired"},
		{"future", "GET", "/api/canvas-projects", "127.0.0.1:5000", SignUserIdentity(key, uid, RoleUser, now.Add(2*time.Minute).Unix(), "GET", "/api/canvas-projects"), 401, "user_identity_expired"},
		{"bad role", "GET", "/api/canvas-projects", "127.0.0.1:5000", SignUserIdentity(key, uid, "root", now.Unix(), "GET", "/api/canvas-projects"), 401, "user_identity_invalid"},
		{"bad uid", "GET", "/api/canvas-projects", "127.0.0.1:5000", SignUserIdentity(key, "../x", RoleUser, now.Unix(), "GET", "/api/canvas-projects"), 401, "user_identity_invalid"},
		{"garbage", "GET", "/api/canvas-projects", "127.0.0.1:5000", "v1.only.three", 401, "user_identity_invalid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			identity, status, reason := u.Verify(identityRequest(tc.method, tc.target, tc.remote, tc.header))
			if status != tc.status || reason != tc.reason {
				t.Fatalf("got %d %q, want %d %q", status, reason, tc.status, tc.reason)
			}
			if status == 0 && (identity.UID != uid || identity.Role != RoleUser || identity.Kind != IdentityUser) {
				t.Fatalf("unexpected identity %+v", identity)
			}
		})
	}
}

func TestRequireIdentityDoors(t *testing.T) {
	u, key, now := testUserIdentity(t)
	gateKey := []byte("gate-key-0123456789abcdef0123456789")
	gate := &GateIdentity{UID: "platformadmin", Key: gateKey, Now: func() time.Time { return now }}
	var seen Identity
	handler := RequireIdentity(IdentityPolicy{User: u, Gate: gate,
		HostExempt: func(r *http.Request) bool { return r.Header.Get("X-Host") == "ok" },
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, _ = IdentityFrom(r)
		w.WriteHeader(204)
	}))
	run := func(r *http.Request) int {
		seen = Identity{}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, r)
		return rec.Code
	}
	if code := run(identityRequest("GET", "/api/health/live", "198.51.100.1:1", "")); code != 204 {
		t.Fatalf("health must stay open, got %d", code)
	}
	if code := run(identityRequest("GET", "/api/canvas-projects", "127.0.0.1:1", "")); code != 401 {
		t.Fatalf("no identity: got %d", code)
	}
	r := identityRequest("GET", "/api/canvas-projects", "127.0.0.1:1", SignUserIdentity(key, "u1", RoleUser, now.Unix(), "GET", "/api/canvas-projects"))
	if code := run(r); code != 204 || seen.UID != "u1" || seen.Kind != IdentityUser || !ToivAuthenticated(r.WithContext(WithIdentity(r.Context(), seen))) {
		t.Fatalf("user door: %d %+v", code, seen)
	}
	r = identityRequest("GET", "/api/workspace/model-config", "127.0.0.1:1", "")
	r.Header.Set(GateIdentityHeader, SignGateIdentity(gateKey, "platformadmin", now.Unix(), "GET", "/api/workspace/model-config"))
	if code := run(r); code != 204 || seen.Kind != IdentityPlatform || seen.Role != RoleAdmin {
		t.Fatalf("platform door: %d %+v", code, seen)
	}
	r = identityRequest("GET", "/api/workspace/model-config", "203.0.113.5:1", "")
	r.Header.Set(GateIdentityHeader, SignGateIdentity(gateKey, "platformadmin", now.Unix(), "GET", "/api/workspace/model-config"))
	if code := run(r); code != 403 {
		t.Fatalf("platform door from untrusted peer: %d", code)
	}
	r = identityRequest("POST", "/api/ops/x", "127.0.0.1:1", "")
	r.Header.Set("X-Host", "ok")
	if code := run(r); code != 204 || seen.Kind != IdentityAssistantHost {
		t.Fatalf("host door: %d %+v", code, seen)
	}
	// A direct browser request with a bearer token is refused when the direct door is off.
	r = identityRequest("GET", "/api/canvas-projects", "127.0.0.1:1", "")
	r.Header.Set("Authorization", "Bearer something")
	if code := run(r); code != 401 {
		t.Fatalf("bearer without direct door: %d", code)
	}
}

func TestParseCIDRList(t *testing.T) {
	networks, err := ParseCIDRList("127.0.0.1, 100.64.0.0/10,::1")
	if err != nil || len(networks) != 3 {
		t.Fatalf("parse: %v %d", err, len(networks))
	}
	if !peerInNetworks("100.77.80.100:3100", networks) || peerInNetworks("8.8.8.8:1", networks) || !peerInNetworks("[::1]:9", networks) {
		t.Fatal("membership")
	}
	if _, err := ParseCIDRList(" , "); err == nil {
		t.Fatal("empty list must fail")
	}
	if _, err := ParseCIDRList("nope/99"); err == nil {
		t.Fatal("bad cidr must fail")
	}
}

// TestUserIdentityCrossLanguageVector pins the wire format shared with apps/web
// lib/studioIdentity.ts (tests/studioIdentity.test.ts asserts the same value).
func TestUserIdentityCrossLanguageVector(t *testing.T) {
	got := SignUserIdentity([]byte("0123456789abcdef0123456789abcdef-test-key"), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", RoleUser, 1800000000, "POST", "/api/canvas-projects/画布 1")
	want := "v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.user.1800000000.e2a2034ddab6f2075390bc4dd908f7441d448a0efa9f0c5eebb1825344580f23"
	if got != want {
		t.Fatalf("vector drifted: %s", got)
	}
}
