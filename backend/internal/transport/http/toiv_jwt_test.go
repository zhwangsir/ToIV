package httptransport

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func newTestToivAuth(t *testing.T, hits *int32) (*ToivJWTAuth, *httptest.Server) {
	t.Helper()
	toiv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/me" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		atomic.AddInt32(hits, 1)
		if r.Header.Get("Authorization") == "Bearer good-token" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"user":{"id":"f659936d40144aa59b83c41d22314e0f","email":"admin"}}`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	auth := &ToivJWTAuth{BaseURL: toiv.URL, Client: toiv.Client(), CacheTTL: time.Minute}
	return auth, toiv
}

func TestToivJWTAuthBearerVerdicts(t *testing.T) {
	var hits int32
	auth, toiv := newTestToivAuth(t, &hits)
	defer toiv.Close()

	good := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	good.Header.Set("Authorization", "Bearer good-token")
	if !auth.Authenticate(good) {
		t.Fatal("valid bearer should authenticate")
	}
	if !auth.Authenticate(good) {
		t.Fatal("cached valid bearer should authenticate")
	}
	if n := atomic.LoadInt32(&hits); n != 1 {
		t.Fatalf("introspection hits = %d, want 1 (cache)", n)
	}

	bad := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	bad.Header.Set("Authorization", "Bearer revoked")
	if auth.Authenticate(bad) {
		t.Fatal("invalid bearer must fail")
	}
	if auth.Authenticate(bad) {
		t.Fatal("invalid bearer must fail again (never cached)")
	}
	if n := atomic.LoadInt32(&hits); n != 3 {
		t.Fatalf("introspection hits = %d, want 3 (no negative caching)", n)
	}

	plain := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	plain.Header.Set("Authorization", "Basic Zm9vOmJhcg==")
	if auth.Authenticate(plain) {
		t.Fatal("non-bearer scheme must not authenticate")
	}
	if auth.Authenticate(httptest.NewRequest(http.MethodGet, "/api/projects", nil)) {
		t.Fatal("missing header must not authenticate")
	}
}

func TestRequireGateIdentityOrAcceptsEither(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	gate := GateIdentity{UID: "u1", Key: key}
	var hits int32
	auth, toiv := newTestToivAuth(t, &hits)
	defer toiv.Close()

	handler := RequireGateIdentityOr(gate, auth.Authenticate)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health/live" && !GateAuthenticated(r) {
			t.Error("authenticated request must carry the gate-authenticated context flag")
		}
		w.WriteHeader(http.StatusOK)
	}))

	// Gate-signed request still passes.
	signed := httptest.NewRequest(http.MethodPost, "/api/projects", nil)
	signed.Header.Set(GateIdentityHeader, SignGateIdentity(key, "u1", time.Now().Unix(), "POST", "/api/projects"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, signed)
	if rec.Code != http.StatusOK {
		t.Fatalf("gate-signed request = %d, want 200", rec.Code)
	}

	// Bearer request passes without the gate header.
	bearer := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	bearer.Header.Set("Authorization", "Bearer good-token")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, bearer)
	if rec.Code != http.StatusOK {
		t.Fatalf("bearer request = %d, want 200", rec.Code)
	}

	// Neither credential: 401 with the gate reason.
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/projects", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous request = %d, want 401", rec.Code)
	}

	// Health stays open.
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health/live", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health/live = %d, want 200", rec.Code)
	}
}

func TestRequireAlternativeAuth(t *testing.T) {
	var hits int32
	auth, toiv := newTestToivAuth(t, &hits)
	defer toiv.Close()
	handler := RequireAlternativeAuth(auth.Authenticate)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))

	bearer := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	bearer.Header.Set("Authorization", "Bearer good-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, bearer)
	if rec.Code != http.StatusOK {
		t.Fatalf("bearer request = %d, want 200", rec.Code)
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/projects", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous request = %d, want 401", rec.Code)
	}
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health/live", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health/live = %d, want 200", rec.Code)
	}
}
