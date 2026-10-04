package main

import (
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"strings"
	"testing"
)

// desktopAssetChain mimics the Wails AssetServer order: Middleware → embedded
// assets → Handler (desktopAssetHandler).
func desktopAssetChain(t *testing.T, app *DesktopApp) http.Handler {
	t.Helper()
	dist, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		t.Fatal(err)
	}
	files := http.FileServer(http.FS(dist))
	handler := desktopAssetHandler{app: app}
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == "/" || (r.Method == http.MethodGet && path.Ext(p) == "" && !strings.HasPrefix(p, "/api") && !strings.HasPrefix(p, "/__desktop/")) {
			idx, err := fs.ReadFile(dist, "index.html")
			if err != nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(idx)
			return
		}
		if _, err := fs.Stat(dist, strings.TrimPrefix(p, "/")); err == nil {
			files.ServeHTTP(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	return toivGateMiddleware(app)(inner)
}

func TestToIVGateSignedOut(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TOIV_API_BASE", "http://127.0.0.1:1") // unreachable on purpose
	app := newDesktopApp(root)
	app.enableToIV(root)
	h := desktopAssetChain(t, app)

	for _, p := range []string{"/", "/login", "/projects/abc"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		body := rec.Body.String()
		if rec.Code != 200 || !strings.Contains(body, "<form") || strings.Contains(body, "<!--SPA_CSS-->") || strings.Contains(body, "<!--GATE_STYLE-->") {
			t.Fatalf("%s: want login page, got %d %.200s", p, rec.Code, body)
		}
	}
	for _, p := range []string{"/api/projects", "/__desktop/runtime-config", "/auth/me", "/auth/status"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: want 401, got %d", p, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"email":"","password":""}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty login: want 400, got %d", rec.Code)
	}
	if app.runtime() != nil {
		t.Fatal("backend must not start while signed out")
	}
}

func TestToIVJWTExpiry(t *testing.T) {
	if jwtUnexpired("not-a-jwt") {
		t.Fatal("garbage token must count as expired")
	}
}

// TestToIVDesktopServe exposes the exact desktop asset chain on a loopback
// port so the WebView flow can be driven with a real browser. Manual only:
//
//	TOIV_DESKTOP_SERVE=127.0.0.1:8395 go test -run TestToIVDesktopServe -timeout 60m
func TestToIVDesktopServe(t *testing.T) {
	addr := os.Getenv("TOIV_DESKTOP_SERVE")
	if addr == "" {
		t.Skip("set TOIV_DESKTOP_SERVE to run")
	}
	root := os.Getenv("CANVAS_DESKTOP_DATA_DIR")
	if root == "" {
		root = t.TempDir()
	}
	app := newDesktopApp(root)
	g := app.enableToIV(root)
	toivAllowPrivateUpstream(g.apiBase())
	toivAllowPrivateUpstream(g.llmBase())
	t.Setenv("ENABLE_PROVIDER_PLUGINS", "true")
	if err := prepareDesktopApp(app); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("serving desktop asset chain on http://%s", addr)
	chain := desktopAssetChain(t, app)
	// The real WebView sends Origin wails://wails (macOS); desktop-only writes check it.
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o == "http://"+addr {
			r.Header.Set("Origin", "wails://wails")
		}
		chain.ServeHTTP(w, r)
	})}
	_ = srv.Serve(ln)
}

func TestToIVLLMBase(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TOIV_API_BASE", "")
	t.Setenv("TOIV_LLM_BASE", "")
	g := newToIVGate(root)
	if got := g.llmBase(); got != "https://toiv.wineryz.top/api/llm/v1" {
		t.Fatalf("default llmBase = %q", got)
	}
	t.Setenv("TOIV_API_BASE", "https://toiv.example.test")
	if got := g.llmBase(); got != "https://toiv.example.test/api/llm/v1" {
		t.Fatalf("derived llmBase = %q", got)
	}
	t.Setenv("TOIV_LLM_BASE", "https://x.example/v1/")
	if got := g.llmBase(); got != "https://x.example/v1" {
		t.Fatalf("env llmBase = %q", got)
	}
	raw, _ := toivGateFS.ReadFile("toivgate/model-config.template.example.json")
	if strings.Contains(string(raw), "192.168.") {
		t.Fatal("embedded template must not carry an internal LLM address")
	}
}
