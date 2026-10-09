package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/model"
	httptransport "infinite-canvas/backend/internal/transport/http"
	"infinite-canvas/backend/internal/workspace"
)

func TestTrustedDesktopUICanCommitDocument(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	trust := func(r *http.Request) bool {
		return r.Header.Get("X-Desktop-Token") == "launch" && r.Header.Get("X-Beeftv-UI-Bootstrap") == "ui"
	}
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{DesktopTrust: trust}))
	api := router.Group("/api")
	RegisterAgentOpsRoutes(api, env.service, agentops.NewStore(env.service.Database()), env.clients)

	code, body := postOps(t, router, "canvas.document.commit", "ui-doc-1", map[string]string{
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}, `{"canvasId":"`+env.canvasID+`","expectedRevision":1,"document":{"title":"桌面提交","nodes":[{"id":"n1","type":"text","title":"桌面"}],"connections":[]}}`)
	if code != http.StatusOK {
		t.Fatalf("受信任桌面 UI 提交失败: %d %s", code, body)
	}
	var envelope struct {
		Data struct {
			Caller   string `json:"caller"`
			Revision int64  `json:"revision"`
			Replayed bool   `json:"replayed"`
			OpID     string `json:"opId"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Caller != string(agentops.CallerManual) || envelope.Data.Replayed || envelope.Data.OpID != "ui-doc-1" {
		t.Fatalf("手工写入应可观察为 caller=manual: %s", body)
	}
	var receipts int64
	if err := env.service.Database().Model(&model.AgentOpRecord{}).Where("op_id = ?", "ui-doc-1").Count(&receipts).Error; err != nil {
		t.Fatal(err)
	}
	if receipts != 1 {
		t.Fatalf("回执数 = %d", receipts)
	}

	untrusted, untrustedBody := postOps(t, router, "canvas.document.commit", "loopback-doc", map[string]string{},
		`{"canvasId":"`+env.canvasID+`","expectedRevision":2,"document":{"title":"未授权"}}`)
	if untrusted != http.StatusForbidden {
		t.Fatalf("未授信 loopback 不得写: %d %s", untrusted, untrustedBody)
	}

	hostCode, hostBody := postOps(t, env.router, "canvas.document.commit", "host-doc", map[string]string{
		"X-Beeftv-Agent-Token": assistantTestHostToken,
	}, `{"canvasId":"`+env.canvasID+`","expectedRevision":2,"document":{"title":"宿主整页"}}`)
	if hostCode != http.StatusForbidden {
		t.Fatalf("宿主不得整页提交: %d %s", hostCode, hostBody)
	}

	reg, token, err := env.clients.RegisterKind("codex", "readonly", agentops.ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	roCode, roBody := postOps(t, env.router, "canvas.document.commit", "ro-doc", map[string]string{
		"X-Beeftv-Client": reg.ID, "Authorization": "Bearer " + token,
	}, `{"canvasId":"`+env.canvasID+`","expectedRevision":2,"document":{"title":"只读"}}`)
	if roCode != http.StatusForbidden {
		t.Fatalf("只读客户端不得整页提交: %d %s", roCode, roBody)
	}
}

func TestHostedWorkspaceSessionCanCommitDocument(t *testing.T) {
	// B1: ProfileServer leaves DesktopTrust unset; layer-A identity → CallerManual.
	env := newAssistantTestEnv(t, nil)
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	resolver := fakeResolver{workspaces: map[string]string{"hosted-user": owner.ID}}
	router := gin.New()
	router.Use(MultiTenantWorkspaceMiddleware(resolver, env.service.DataDir()))
	// DesktopTrust omitted (= nil) simulates cmd/server ProfileServer.
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{}))
	api := router.Group("/api")
	RegisterAgentOpsRoutes(api, env.service, agentops.NewStore(env.service.Database()), env.clients)

	identity := httptransport.Identity{UID: "hosted-user", Role: httptransport.RoleUser, Kind: httptransport.IdentityUser}
	code, body := postOpsWithIdentity(t, router, "canvas.document.commit", "hosted-doc-1", identity, nil,
		`{"canvasId":"`+env.canvasID+`","expectedRevision":1,"document":{"title":"托管提交","nodes":[{"id":"n1","type":"text","title":"托管"}],"connections":[]}}`)
	if code != http.StatusOK {
		t.Fatalf("托管已过层 A 的工作区会话应可提交: %d %s", code, body)
	}
	var envelope struct {
		Data struct {
			Caller   string `json:"caller"`
			Revision int64  `json:"revision"`
			OpID     string `json:"opId"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Caller != string(agentops.CallerManual) || envelope.Data.OpID != "hosted-doc-1" {
		t.Fatalf("应观察为 caller=manual (hosted-workspace): %s", body)
	}

	// Same ProfileServer, no layer-A identity → still errUnidentified (403).
	// Without MultiTenant identity the middleware aborts 401 first; probe resolveCaller
	// via WorkspaceMiddleware-only router (DesktopTrust nil, no identity).
	bare := gin.New()
	bare.Use(WorkspaceMiddleware(workspace.Context{ID: owner.ID, DataDir: env.service.DataDir()}))
	bare.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{}))
	RegisterAgentOpsRoutes(bare.Group("/api"), env.service, agentops.NewStore(env.service.Database()), env.clients)
	unauth, unauthBody := postOps(t, bare, "canvas.document.commit", "hosted-bare", nil,
		`{"canvasId":"`+env.canvasID+`","expectedRevision":2,"document":{"title":"裸打"}}`)
	if unauth != http.StatusForbidden || !strings.Contains(unauthBody, "缺少可信身份") {
		t.Fatalf("托管无层 A 身份仍须 403 errUnidentified: %d %s", unauth, unauthBody)
	}
}

func TestHostedWorkspaceSessionDoesNotBypassDesktopTrust(t *testing.T) {
	// Desktop profile keeps DesktopTrust set: identity alone must not become CallerManual.
	env := newAssistantTestEnv(t, nil)
	trust := func(r *http.Request) bool {
		return r.Header.Get("X-Desktop-Token") == "launch" && r.Header.Get("X-Beeftv-UI-Bootstrap") == "ui"
	}
	owner, err := env.service.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	resolver := fakeResolver{workspaces: map[string]string{"desk-user": owner.ID}}
	router := gin.New()
	router.Use(MultiTenantWorkspaceMiddleware(resolver, env.service.DataDir()))
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{DesktopTrust: trust}))
	RegisterAgentOpsRoutes(router.Group("/api"), env.service, agentops.NewStore(env.service.Database()), env.clients)

	identity := httptransport.Identity{UID: "desk-user", Role: httptransport.RoleUser, Kind: httptransport.IdentityUser}
	code, body := postOpsWithIdentity(t, router, "canvas.document.commit", "desk-id-only", identity, nil,
		`{"canvasId":"`+env.canvasID+`","expectedRevision":1,"document":{"title":"仅身份"}}`)
	if code != http.StatusForbidden || !strings.Contains(body, "缺少可信身份") {
		t.Fatalf("桌面形态不得仅凭层 A 身份写 ops: %d %s", code, body)
	}

	okCode, okBody := postOpsWithIdentity(t, router, "canvas.document.commit", "desk-trusted", identity, map[string]string{
		"X-Desktop-Token": "launch", "X-Beeftv-UI-Bootstrap": "ui",
	}, `{"canvasId":"`+env.canvasID+`","expectedRevision":1,"document":{"title":"桌面+身份","nodes":[{"id":"n1","type":"text","title":"ok"}],"connections":[]}}`)
	if okCode != http.StatusOK {
		t.Fatalf("桌面双 token + 层 A 应成功: %d %s", okCode, okBody)
	}
}

func postOpsWithIdentity(t *testing.T, router http.Handler, op, opID string, identity httptransport.Identity, headers map[string]string, params string) (int, string) {
	t.Helper()
	body := `{"opId":` + strconvQuote(opID) + `,"params":` + params + `}`
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:18090/api/ops/"+op, strings.NewReader(body))
	request = request.WithContext(httptransport.WithIdentity(request.Context(), identity))
	request.Host = "127.0.0.1:18090"
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.String()
}

func postOps(t *testing.T, router http.Handler, op, opID string, headers map[string]string, params string) (int, string) {
	t.Helper()
	body := `{"opId":` + strconvQuote(opID) + `,"params":` + params + `}`
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:18090/api/ops/"+op, strings.NewReader(body))
	request.Host = "127.0.0.1:18090"
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.String()
}

func strconvQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
