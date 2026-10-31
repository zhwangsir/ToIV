package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestDelegatedStudioTokenExpiryAndUserIsolation(t *testing.T) {
	now := time.Unix(1000, 0)
	store := newUISessionStore()
	store.now = func() time.Time { return now }
	session := store.issue("user-1", "delegated-secret")
	if session.Token == "" {
		t.Fatal("UI session missing")
	}
	if token, ok := store.delegatedStudioToken("user-1"); !ok || token != "delegated-secret" {
		t.Fatalf("delegated token unavailable: %q %v", token, ok)
	}
	if _, ok := store.delegatedStudioToken("user-2"); ok {
		t.Fatal("不得跨用户读取 delegated token")
	}
	now = now.Add(31 * time.Minute)
	if _, ok := store.delegatedStudioToken("user-1"); ok {
		t.Fatal("过期 delegated token 必须失效")
	}
	store.issue("user-3")
	if _, ok := store.delegatedStudioToken("user-3"); ok {
		t.Fatal("旧 issue 调用不得凭空产生委托")
	}
}

func TestStudioGatewayUsesOnlyConfiguredBaseAndDelegatedBearer(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer delegated-secret" {
			t.Errorf("missing delegated bearer")
		}
		if r.URL.Path == "/api/studio/projects/p1" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"p1","stage_revision":3,"shots":[{"id":"shot-1"}]}`))
			return
		}
		if (r.URL.Path == "/api/studio/projects/p1/render-estimate" || r.URL.Path == "/api/studio/shots/shot-1/render-estimate") && r.Method == http.MethodPost {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"project_id":"p1","allowed":true}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer upstream.Close()
	store := newUISessionStore()
	store.issue("user-1", "delegated-secret")
	gateway := newStudioGateway(upstream.URL, store)
	detail, err := gateway.Project(context.Background(), "user-1", "p1")
	if err != nil || detail["id"] != "p1" {
		t.Fatalf("detail: %#v %v", detail, err)
	}
	estimate, err := gateway.Estimate(context.Background(), "user-1", "p1", "")
	if err != nil || estimate["project_id"] != "p1" {
		t.Fatalf("estimate: %#v %v", estimate, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("unexpected calls: %d", calls.Load())
	}
	if _, err := gateway.Estimate(context.Background(), "user-1", "p1", "shot-1"); err != nil {
		t.Fatalf("授权项目内的镜头预估失败: %v", err)
	}
	if calls.Load() != 4 {
		t.Fatalf("单镜预估必须先读项目 detail 再预估: %d", calls.Load())
	}
	if _, err := gateway.Estimate(context.Background(), "user-1", "p1", "shot-from-another-project"); err == nil {
		t.Fatal("不得用已授权 projectId 预估其他项目的 shotId")
	}
	if calls.Load() != 5 {
		t.Fatalf("跨项目 shotId 只能在 detail 校验后拒绝，不得调用预估端点: %d", calls.Load())
	}
	if _, err := gateway.Project(context.Background(), "user-2", "p1"); err == nil || !strings.Contains(err.Error(), "studio_delegation_required") {
		t.Fatalf("缺委托必须明确失败: %v", err)
	}
	if calls.Load() != 5 {
		t.Fatal("缺委托不得发上游请求")
	}
}

func TestStudioGatewayDoesNotFollowRedirects(t *testing.T) {
	var redirectedCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirectedCalls.Add(1) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	store := newUISessionStore()
	store.issue("user-1", "delegated-secret")
	gateway := newStudioGateway(redirect.URL, store)
	if _, err := gateway.Project(context.Background(), "user-1", "p1"); err == nil {
		t.Fatal("重定向必须失败")
	}
	if redirectedCalls.Load() != 0 {
		t.Fatal("不得跟随重定向转发 token")
	}
}

func TestNormalizeStudioReferenceChecksRealOwnershipAndDoesNotAcceptCanvasID(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer delegated-secret" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/api/studio/projects/studio-p1" {
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "studio-p1"})
			return
		}
		http.NotFound(w, r)
	}))
	defer upstream.Close()
	store := newUISessionStore()
	store.issue("local", "delegated-secret")
	gateway := newStudioGateway(upstream.URL, store)
	env := newAssistantTestEnv(t, nil)
	references, err := normalizeAssistantReferences(env.service, "local", []assistantReference{{Kind: "studio_project", ID: "studio-p1"}}, gateway)
	if err != nil || len(references) != 1 {
		t.Fatalf("valid Studio reference rejected: %#v %v", references, err)
	}
	if _, err := normalizeAssistantReferences(env.service, "local", []assistantReference{{Kind: "studio_project", ID: env.canvasID}}, gateway); err == nil {
		t.Fatal("Canvas ID 不得被当作 Studio ID")
	}
	if _, err := normalizeAssistantReferences(env.service, "local", []assistantReference{{Kind: "studio_project", ID: "studio-p1"}}); err == nil || !strings.Contains(err.Error(), "studio_delegation_required") {
		t.Fatalf("无 gateway/委托时必须拒绝: %v", err)
	}
}

func TestNonToivTrustDoesNotDelegateAuthorizationBearer(t *testing.T) {
	env := newAssistantTestEnv(t, nil)
	store := newUISessionStore()
	trust := func(r *http.Request) bool { return r.Header.Get("X-Desktop-Token") == "launch" }
	router := gin.New()
	router.Use(RuntimeDependenciesMiddleware(RuntimeDependencies{DesktopTrust: trust}))
	RegisterAgentUISessionRoutes(router.Group("/api"), env.service, store, trust)
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:18090/api/assistant/ui-session", strings.NewReader(`{}`))
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Desktop-Token", "launch")
	req.Header.Set("Authorization", "Bearer must-not-be-delegated")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("desktop issue failed: %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "must-not-be-delegated") {
		t.Fatal("响应不得包含 delegated token")
	}
	if _, ok := store.delegatedStudioToken("local"); ok {
		t.Fatal("非 Toiv 信任不得借 bearer 提权")
	}
}
