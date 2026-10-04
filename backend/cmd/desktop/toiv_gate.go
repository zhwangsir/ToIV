package main

// ToIV desktop login (M4-1).
//
// The desktop app is a ToIV client: before the canvas UI loads the user signs in with their
// ToIV account (proxied to the ToIV API, default http://100.77.80.100:8090, override with
// TOIV_API_BASE or <root>/toiv.json {"apiBase": "..."}). Each ToIV user gets an isolated
// local workspace (<root>/users/<uid>), the bundled toiv-h3 plugin channel is provisioned
// with that user's JWT so H3 jobs run as them in ToIV, and the session token is stored at
// <root>/session.json (0600). The login/startup pages are the same BeefTV-token pages the
// staging web gate serves.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

//go:embed toivgate/*.html toivgate/*.json
var toivGateFS embed.FS

const defaultToIVAPIBase = "http://100.77.80.100:8090"

var (
	errToIVNotLoggedIn = errors.New("请先登录 ToIV 账号")
	toivUIDPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

type toivUser struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type toivSession struct {
	Token   string    `json:"token"`
	User    toivUser  `json:"user"`
	APIBase string    `json:"apiBase"`
	SavedAt time.Time `json:"savedAt"`
}

type toivGate struct {
	root   string
	client *http.Client

	mu      sync.RWMutex
	session *toivSession
}

func newToIVGate(root string) *toivGate {
	return &toivGate{root: root, client: &http.Client{Timeout: 20 * time.Second}}
}

func (g *toivGate) apiBase() string {
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv("TOIV_API_BASE")), "/"); v != "" {
		return v
	}
	var cfg struct {
		APIBase string `json:"apiBase"`
	}
	if raw, err := os.ReadFile(filepath.Join(g.root, "toiv.json")); err == nil && json.Unmarshal(raw, &cfg) == nil {
		if v := strings.TrimRight(strings.TrimSpace(cfg.APIBase), "/"); v != "" {
			return v
		}
	}
	return defaultToIVAPIBase
}

func (g *toivGate) sessionPath() string { return filepath.Join(g.root, "session.json") }

func (g *toivGate) current() *toivSession {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.session
}

func (g *toivGate) userDataDir(uid string) string { return filepath.Join(g.root, "users", uid) }

// loadSession restores the saved session if ToIV still accepts the token. When ToIV is
// unreachable an unexpired token is kept so local canvases stay usable offline.
func (g *toivGate) loadSession(ctx context.Context) *toivSession {
	raw, err := os.ReadFile(g.sessionPath())
	if err != nil {
		return nil
	}
	var s toivSession
	if json.Unmarshal(raw, &s) != nil || s.Token == "" || !toivUIDPattern.MatchString(s.User.ID) {
		return nil
	}
	user, status, err := g.me(ctx, s.Token)
	switch {
	case err == nil && status == http.StatusOK && user.ID == s.User.ID:
		s.User = user
	case err != nil && jwtUnexpired(s.Token):
		// offline: keep the unexpired session
	default:
		_ = os.Remove(g.sessionPath())
		return nil
	}
	g.mu.Lock()
	g.session = &s
	g.mu.Unlock()
	return &s
}

func (g *toivGate) saveSession(s *toivSession) error {
	if err := os.MkdirAll(g.root, 0o700); err != nil {
		return err
	}
	raw, _ := json.Marshal(s)
	tmp := g.sessionPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, g.sessionPath()); err != nil {
		return err
	}
	g.mu.Lock()
	g.session = s
	g.mu.Unlock()
	return nil
}

func (g *toivGate) clearSession() {
	_ = os.Remove(g.sessionPath())
	g.mu.Lock()
	g.session = nil
	g.mu.Unlock()
}

func (g *toivGate) do(ctx context.Context, method, p, token string, body any) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, g.apiBase()+p, rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, out, nil
}

func (g *toivGate) me(ctx context.Context, token string) (toivUser, int, error) {
	status, raw, err := g.do(ctx, http.MethodGet, "/api/auth/me", token, nil)
	if err != nil || status != http.StatusOK {
		return toivUser{}, status, err
	}
	var env struct {
		User *struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
			Name        string `json:"name"`
			Username    string `json:"username"`
			Email       string `json:"email"`
		} `json:"user"`
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Email       string `json:"email"`
	}
	if json.Unmarshal(raw, &env) != nil {
		return toivUser{}, status, errors.New("ToIV /api/auth/me: bad response")
	}
	u := toivUser{ID: env.ID, Name: env.DisplayName, Email: env.Email}
	if env.User != nil {
		u = toivUser{ID: env.User.ID, Name: firstNonEmpty(env.User.DisplayName, env.User.Name, env.User.Username), Email: env.User.Email}
	}
	if !toivUIDPattern.MatchString(u.ID) {
		return toivUser{}, status, errors.New("ToIV /api/auth/me: missing user id")
	}
	return u, status, nil
}

func (g *toivGate) login(ctx context.Context, email, password string) (*toivSession, int, string) {
	status, raw, err := g.do(ctx, http.MethodPost, "/api/auth/login", "", map[string]string{"email": email, "password": password})
	if err != nil {
		return nil, http.StatusBadGateway, "无法连接 ToIV（" + g.apiBase() + "）"
	}
	var res struct {
		Token   string `json:"token"`
		Detail  any    `json:"detail"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &res)
	if status != http.StatusOK || res.Token == "" {
		msg := "账号或密码错误"
		if d, ok := res.Detail.(string); ok && d != "" {
			msg = d
		} else if res.Message != "" {
			msg = res.Message
		}
		return nil, http.StatusUnauthorized, msg
	}
	user, _, err := g.me(ctx, res.Token)
	if err != nil {
		return nil, http.StatusUnauthorized, "ToIV 令牌校验失败"
	}
	return &toivSession{Token: res.Token, User: user, APIBase: g.apiBase(), SavedAt: time.Now()}, http.StatusOK, ""
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func jwtUnexpired(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Exp float64 `json:"exp"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.Exp == 0 {
		return false
	}
	return time.Unix(int64(claims.Exp), 0).After(time.Now())
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ---------- DesktopApp integration ----------

// The gate lives outside DesktopApp (which Wails binds and reflects), like the runtime registry.
var toivGates sync.Map // *DesktopApp -> *toivGate

func (a *DesktopApp) gate() *toivGate {
	if v, ok := toivGates.Load(a); ok {
		return v.(*toivGate)
	}
	return nil
}

func (a *DesktopApp) enableToIV(root string) *toivGate {
	g := newToIVGate(root)
	toivGates.Store(a, g)
	return g
}

// activateToIVUser points the app at the user's workspace and (re)starts the local backend.
func (a *DesktopApp) activateToIVUser(ctx context.Context, s *toivSession) error {
	dir := a.gate().userDataDir(s.User.ID)
	a.mu.RLock()
	switching := a.runtime() != nil && a.dataDir != dir
	a.mu.RUnlock()
	if switching {
		if err := a.stop(ctx); err != nil {
			return err
		}
	}
	if err := a.start(ctx); err != nil { // start() resolves the per-user data dir from the session
		return err
	}
	return a.provisionToIVChannels(ctx, s)
}

// provisionToIVChannels merges the bundled ToIV model template into the user's workspace once
// and keeps the H3 channel credential equal to the user's current ToIV JWT.
func (a *DesktopApp) provisionToIVChannels(ctx context.Context, s *toivSession) error {
	stateFile := filepath.Join(a.gate().userDataDir(s.User.ID), "toiv_state.json")
	var st struct {
		Provisioned bool   `json:"provisioned"`
		TokenHash   string `json:"tokenHash"`
		APIBase     string `json:"apiBase"`
	}
	if raw, err := os.ReadFile(stateFile); err == nil {
		_ = json.Unmarshal(raw, &st)
	}
	base := a.gate().apiBase()
	if st.Provisioned && st.TokenHash == tokenHash(s.Token) && st.APIBase == base {
		return nil
	}
	status, raw := a.localAPI(ctx, http.MethodGet, "/api/workspace/model-config", nil)
	if status != http.StatusOK {
		return fmt.Errorf("读取模型配置失败（%d）", status)
	}
	var cur struct {
		Data struct {
			Config   map[string]any `json:"config"`
			Revision any            `json:"revision"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &cur); err != nil || cur.Data.Config == nil {
		return errors.New("模型配置格式无效")
	}
	cfg := cur.Data.Config
	if !st.Provisioned {
		tplRaw, err := toivGateFS.ReadFile("toivgate/model-config.template.example.json")
		if err != nil {
			return err
		}
		var tpl map[string]any
		if err := json.Unmarshal(tplRaw, &tpl); err != nil {
			return err
		}
		tplChannels, _ := tpl["channels"].([]any)
		ids := map[string]bool{}
		for _, c := range tplChannels {
			if m, ok := c.(map[string]any); ok {
				ids[fmt.Sprint(m["id"])] = true
			}
		}
		merged := []any{}
		if existing, ok := cfg["channels"].([]any); ok {
			for _, c := range existing {
				if m, ok := c.(map[string]any); ok && ids[fmt.Sprint(m["id"])] {
					continue
				}
				merged = append(merged, c)
			}
		}
		for k, v := range tpl {
			cfg[k] = v
		}
		cfg["channels"] = append(merged, tplChannels...)
	}
	channels, _ := cfg["channels"].([]any)
	for _, c := range channels {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		profiles, _ := m["modelProfiles"].([]any)
		for _, p := range profiles {
			pm, _ := p.(map[string]any)
			if pm != nil && (pm["protocol"] == "toiv-h3" || pm["model"] == "h3-t2v") {
				m["apiKey"] = s.Token
				m["baseUrl"] = base
				break
			}
		}
	}
	status, raw = a.localAPI(ctx, http.MethodPut, "/api/workspace/model-config", map[string]any{"config": cfg, "expectedRevision": cur.Data.Revision})
	if status != http.StatusOK {
		return fmt.Errorf("写入 ToIV 渠道失败（%d）：%s", status, strings.TrimSpace(string(raw)))
	}
	st.Provisioned, st.TokenHash, st.APIBase = true, tokenHash(s.Token), base
	out, _ := json.Marshal(st)
	return os.WriteFile(stateFile, out, 0o600)
}

// localAPI calls the in-process backend with the desktop launch token.
func (a *DesktopApp) localAPI(ctx context.Context, method, p string, body any) (int, []byte) {
	a.mu.RLock()
	rt := a.runtime()
	a.mu.RUnlock()
	if rt == nil {
		return 0, nil
	}
	var rd io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, p, rd).WithContext(ctx)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-Desktop-Token", rt.LaunchToken())
	rec := httptest.NewRecorder()
	rt.Handler().ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// toivAllowPrivateUpstream lets the backend reach a ToIV API on a private / tailnet address.
func toivAllowPrivateUpstream(apiBase string) {
	u, err := url.Parse(apiBase)
	if err != nil || u.Hostname() == "" {
		return
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); ip == nil && host != "localhost" {
		return // public DNS name: no exception needed
	}
	cur := strings.TrimSpace(os.Getenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS"))
	for _, h := range strings.Split(cur, ",") {
		if strings.TrimSpace(h) == host {
			return
		}
	}
	if cur != "" {
		cur += ","
	}
	_ = os.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", cur+host)
}

// ---------- HTTP: login pages and /auth/* inside the Wails asset server ----------

func toivGateMiddleware(app *DesktopApp) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p := r.URL.Path
			switch {
			case p == "/login":
				app.serveGatePage(w, "login.html")
				return
			case p == "/__toiv/starting":
				app.serveGatePage(w, "starting.html")
				return
			case strings.HasPrefix(p, "/auth/"):
				app.handleToIVAuth(w, r)
				return
			}
			loggedIn := app.gate().current() != nil
			if !loggedIn && (p == "/api" || strings.HasPrefix(p, "/api/") || p == "/__desktop/runtime-config") {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":"unauthenticated","message":"请先登录 ToIV 账号"}`))
				return
			}
			if !loggedIn && r.Method == http.MethodGet && path.Ext(p) == "" {
				app.serveGatePage(w, "login.html") // any SPA navigation while signed out
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

var stylesheetLink = regexp.MustCompile(`<link rel="stylesheet"[^>]*>`)

func (a *DesktopApp) serveGatePage(w http.ResponseWriter, name string) {
	page, err := toivGateFS.ReadFile("toivgate/" + name)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	style, _ := toivGateFS.ReadFile("toivgate/gate-style.html")
	dist, err := fs.Sub(assets, "frontend/dist")
	var links []string
	if err == nil {
		if idx, err := fs.ReadFile(dist, "index.html"); err == nil {
			links = append(links, stylesheetLink.FindAllString(string(idx), -1)...)
		}
		if entries, err := fs.ReadDir(dist, "static"); err == nil {
			for _, e := range entries {
				if strings.HasPrefix(e.Name(), "application-") && strings.HasSuffix(e.Name(), ".css") {
					links = append(links, `<link rel="stylesheet" href="/static/`+e.Name()+`">`)
				}
			}
		}
	}
	html := strings.Replace(string(page), "<!--SPA_CSS-->", strings.Join(links, "\n"), 1)
	html = strings.Replace(html, "<!--GATE_STYLE-->", string(style), 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(html))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *DesktopApp) handleToIVAuth(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/auth/login" && r.Method == http.MethodPost:
		var body struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&body); err != nil || strings.TrimSpace(body.Email) == "" || body.Password == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "请输入账号与密码"})
			return
		}
		s, status, msg := a.gate().login(r.Context(), strings.TrimSpace(body.Email), body.Password)
		if s == nil {
			writeJSON(w, status, map[string]string{"error": "login_failed", "message": msg})
			return
		}
		if err := a.gate().saveSession(s); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session", "message": "保存登录状态失败"})
			return
		}
		if err := a.activateToIVUser(r.Context(), s); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "workspace_unavailable", "message": "本地工作区启动失败：" + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": s.User})
	case r.URL.Path == "/auth/logout" && r.Method == http.MethodPost:
		a.gate().clearSession()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = a.stop(ctx)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case r.URL.Path == "/auth/me" && r.Method == http.MethodGet:
		s := a.gate().current()
		if s == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"user": s.User})
	case r.URL.Path == "/auth/status" && r.Method == http.MethodGet:
		s := a.gate().current()
		if s == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
			return
		}
		a.mu.RLock()
		running := a.runtime() != nil
		a.mu.RUnlock()
		if !running {
			if err := a.activateToIVUser(r.Context(), s); err != nil {
				writeJSON(w, http.StatusOK, map[string]string{"state": "error", "message": "本地工作区启动失败，正在重试…"})
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]string{"state": "ready", "message": "已就绪"})
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
	}
}
