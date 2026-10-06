package httptransport

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const (
	testUID   = "7a757fb132b84e8e90b033dae7584f75"
	otherUID  = "9c00aa11bb22cc33dd44ee55ff667788"
	testKey   = "0123456789abcdef0123456789abcdef-user-a"
	otherKey  = "fedcba9876543210fedcba9876543210-user-b"
	forgedKey = "attacker-guess-attacker-guess-attacker"
)

func gateServer(now time.Time) http.Handler {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !GateAuthenticated(r) && r.URL.Path != "/api/health/live" && r.URL.Path != "/api/ops" {
			w.WriteHeader(http.StatusTeapot)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	return RequireGateIdentity(GateIdentity{
		UID: testUID, Key: []byte(testKey), Now: func() time.Time { return now },
		Exempt: func(r *http.Request) bool { return r.URL.Path == "/api/ops" && r.Header.Get("X-Test-Host") == "1" },
	})(ok)
}

func TestGateIdentityMatrix(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	h := gateServer(now)
	ts := now.Unix()
	cases := []struct {
		name   string
		method string
		path   string
		header string
		extra  map[string]string
		want   int
	}{
		{"valid", "GET", "/api/canvas-projects/x?y=1", SignGateIdentity([]byte(testKey), testUID, ts, "GET", "/api/canvas-projects/x"), nil, 200},
		{"no header", "GET", "/api/tasks", "", nil, 401},
		{"forged owner header only", "GET", "/api/tasks", "", map[string]string{"X-Beeftv-Owner": "x"}, 401},
		{"forged signature (wrong key)", "GET", "/api/tasks", SignGateIdentity([]byte(forgedKey), testUID, ts, "GET", "/api/tasks"), nil, 401},
		{"garbage", "GET", "/api/tasks", "v1.abc", nil, 401},
		{"expired (+2 min old)", "GET", "/api/tasks", SignGateIdentity([]byte(testKey), testUID, ts-120, "GET", "/api/tasks"), nil, 401},
		{"future (+2 min)", "GET", "/api/tasks", SignGateIdentity([]byte(testKey), testUID, ts+120, "GET", "/api/tasks"), nil, 401},
		{"other user's identity (own key)", "GET", "/api/tasks", SignGateIdentity([]byte(otherKey), otherUID, ts, "GET", "/api/tasks"), nil, 403},
		{"other uid with this key", "GET", "/api/tasks", SignGateIdentity([]byte(testKey), otherUID, ts, "GET", "/api/tasks"), nil, 403},
		{"replay on another path", "GET", "/api/canvas-projects", SignGateIdentity([]byte(testKey), testUID, ts, "GET", "/api/tasks"), nil, 401},
		{"replay with another method", "DELETE", "/api/tasks", SignGateIdentity([]byte(testKey), testUID, ts, "GET", "/api/tasks"), nil, 401},
		{"health exempt", "GET", "/api/health/live", "", nil, 200},
		{"host ops exempt", "GET", "/api/ops", "", map[string]string{"X-Test-Host": "1"}, 200},
		{"ops without host token", "GET", "/api/ops", "", nil, 401},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if tc.header != "" {
				req.Header.Set(GateIdentityHeader, tc.header)
			}
			for k, v := range tc.extra {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("%s: got %d want %d (%s)", tc.name, rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

func TestLoadGateIdentity(t *testing.T) {
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "gate_key")
	if err := os.WriteFile(keyFile, []byte(testKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	short := filepath.Join(dir, "short")
	_ = os.WriteFile(short, []byte("short"), 0o600)
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if g, err := LoadGateIdentity(env(nil)); g != nil || err != nil {
		t.Fatalf("unset should disable: %v %v", g, err)
	}
	if _, err := LoadGateIdentity(env(map[string]string{"BEEFTV_GATE_UID": testUID})); err == nil {
		t.Fatal("uid without key must fail closed")
	}
	if _, err := LoadGateIdentity(env(map[string]string{"BEEFTV_GATE_UID": testUID, "BEEFTV_GATE_KEY_FILE": short})); err == nil {
		t.Fatal("short key must fail")
	}
	if _, err := LoadGateIdentity(env(map[string]string{"BEEFTV_GATE_UID": testUID, "BEEFTV_GATE_KEY_FILE": filepath.Join(dir, "missing")})); err == nil {
		t.Fatal("missing key must fail")
	}
	g, err := LoadGateIdentity(env(map[string]string{"BEEFTV_GATE_UID": testUID, "BEEFTV_GATE_KEY_FILE": keyFile}))
	if err != nil || g == nil || g.UID != testUID || string(g.Key) != testKey {
		t.Fatalf("load: %v %+v", err, g)
	}
}
