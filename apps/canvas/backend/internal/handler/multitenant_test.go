package handler

import (
	"errors"
	"net/http/httptest"
	"testing"

	httptransport "infinite-canvas/backend/internal/transport/http"

	"github.com/gin-gonic/gin"
)

func TestPlatformAdminOnlyRoute(t *testing.T) {
	cases := []struct {
		method, path string
		want         bool
	}{
		{"GET", "/api/workspace/model-config", false},
		{"PUT", "/api/workspace/model-config", true},
		{"GET", "/api/assistant/host/config", true},
		{"POST", "/api/assistant/host/restart", true},
		{"POST", "/api/assistant/chat", false},
		{"GET", "/api/beefapi/connection", false},
		{"POST", "/api/beefapi/connection/start", true},
		{"GET", "/api/ops/clients", true},
		{"POST", "/api/ops/canvas.read", false},
		{"POST", "/api/agent-clients", true},
		{"POST", "/api/diagnostics/export", true},
		{"GET", "/api/eagle/items", true},
		{"POST", "/api/skills/install/github", true},
		{"GET", "/api/skills", false},
		{"GET", "/api/canvas-projects", false},
		{"DELETE", "/api/assets/x", false},
	}
	for _, tc := range cases {
		if got := PlatformAdminOnlyRoute(tc.method, tc.path); got != tc.want {
			t.Errorf("%s %s = %v, want %v", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestMultiTenantMiddlewareScopesAndGuards(t *testing.T) {
	gin.SetMode(gin.TestMode)
	resolver := fakeResolver{workspaces: map[string]string{"admin1": "legacyws", "u1": "u1"}}
	router := gin.New()
	router.Use(MultiTenantWorkspaceMiddleware(resolver, "/tmp/data"))
	router.GET("/api/health/live", func(c *gin.Context) { c.Status(204) })
	router.GET("/api/canvas-projects", func(c *gin.Context) {
		scope, err := CurrentWorkspace(c)
		if err != nil {
			c.Status(500)
			return
		}
		c.String(200, scope.ID)
	})
	router.PUT("/api/workspace/model-config", func(c *gin.Context) { c.Status(204) })
	do := func(method, path string, identity *httptransport.Identity) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		if identity != nil {
			r = r.WithContext(httptransport.WithIdentity(r.Context(), *identity))
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	if w := do("GET", "/api/health/live", nil); w.Code != 204 {
		t.Fatalf("health: %d", w.Code)
	}
	if w := do("GET", "/api/canvas-projects", nil); w.Code != 401 {
		t.Fatalf("no identity: %d", w.Code)
	}
	user := httptransport.Identity{UID: "u1", Role: httptransport.RoleUser, Kind: httptransport.IdentityUser}
	if w := do("GET", "/api/canvas-projects", &user); w.Code != 200 || w.Body.String() != "u1" {
		t.Fatalf("user scope: %d %s", w.Code, w.Body.String())
	}
	if w := do("PUT", "/api/workspace/model-config", &user); w.Code != 403 {
		t.Fatalf("tenant must not write platform config: %d", w.Code)
	}
	admin := httptransport.Identity{UID: "admin1", Role: httptransport.RoleAdmin, Kind: httptransport.IdentityUser}
	if w := do("GET", "/api/canvas-projects", &admin); w.Code != 200 || w.Body.String() != "legacyws" {
		t.Fatalf("admin scope: %d %s", w.Code, w.Body.String())
	}
	if w := do("PUT", "/api/workspace/model-config", &admin); w.Code != 204 {
		t.Fatalf("admin config write: %d", w.Code)
	}
}

type fakeResolver struct{ workspaces map[string]string }

func (f fakeResolver) EnsureIdentityWorkspace(subject string) (string, error) {
	if ws, ok := f.workspaces[subject]; ok {
		return ws, nil
	}
	return subject, nil
}
func (f fakeResolver) AssistantTurnWorkspace(string) (string, error) { return "", errors.New("none") }
func (f fakeResolver) DefaultWorkspaceID() (string, error)           { return "legacyws", nil }
