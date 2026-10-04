package main

// Launch smoke for CI (`ToIV --toiv-smoke=<report.json>`): runs the real startup chain headless
// (no WebView) and checks that the app's local backend starts, the bundled agent-host comes up,
// the ToIV login page is served and the ToIV login endpoint answers. Exit 0 only if all pass.
// It uses a throwaway session ("smoke") and the data dir from CANVAS_DESKTOP_DATA_DIR; no real
// credentials are needed or written.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"time"

	httptransport "infinite-canvas/backend/internal/transport/http"
)

const smokeFlag = "--toiv-smoke="

func smokeReportPath(args []string) (string, bool) {
	for _, a := range args {
		if strings.HasPrefix(a, smokeFlag) {
			return strings.TrimPrefix(a, smokeFlag), true
		}
	}
	return "", false
}

type smokeReport struct {
	OK             bool              `json:"ok"`
	Backend        bool              `json:"backend"`
	AgentHost      bool              `json:"agentHost"`
	AgentHostState string            `json:"agentHostState,omitempty"`
	LoginPage      bool              `json:"loginPage"`
	LoginEndpoint  int               `json:"loginEndpoint"`
	APIBase        string            `json:"apiBase"`
	Errors         []string          `json:"errors,omitempty"`
	Timings        map[string]string `json:"timings"`
}

func runToIVSmoke(dataDir, out string) int {
	rep := smokeReport{Timings: map[string]string{}}
	t0 := time.Now()
	fail := func(format string, a ...any) { rep.Errors = append(rep.Errors, fmt.Sprintf(format, a...)) }
	defer func() {
		rep.OK = rep.Backend && rep.AgentHost && rep.LoginPage && rep.LoginEndpoint > 0 && rep.LoginEndpoint < 500
		raw, _ := json.MarshalIndent(rep, "", "  ")
		_ = os.WriteFile(out, append(raw, '\n'), 0o600)
		fmt.Println(string(raw))
	}()
	if os.Getenv("ENABLE_PROVIDER_PLUGINS") == "" {
		_ = os.Setenv("ENABLE_PROVIDER_PLUGINS", "true")
	}
	app := newDesktopApp(dataDir)
	g := app.enableToIV(dataDir)
	rep.APIBase = g.apiBase()
	toivAllowPrivateUpstream(rep.APIBase)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	// 1) login page through the same middleware the WebView asset server uses (signed out).
	rec := httptest.NewRecorder()
	toivGateMiddleware(app)(http.NotFoundHandler()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	rep.LoginPage = rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), "ToIV")
	if !rep.LoginPage {
		fail("login page: status %d", rec.Code)
	}

	// 2) ToIV login endpoint reachable (an empty body must be rejected with 4xx, not fail to connect).
	if status, _, err := g.do(ctx, http.MethodPost, "/api/auth/login", "", map[string]string{}); err != nil {
		fail("login endpoint: %v", err)
	} else {
		rep.LoginEndpoint = status
	}

	// 3) local backend + channels with a throwaway session (same path as a real login).
	s := &toivSession{Token: "smoke", User: toivUser{ID: "smoke", Name: "smoke"}, APIBase: rep.APIBase, SavedAt: time.Now()}
	g.mu.Lock()
	g.session = s
	g.mu.Unlock()
	if err := app.start(ctx); err != nil {
		fail("backend start: %v", err)
		return 1
	}
	defer func() { _ = app.stop(context.Background()) }()
	rep.Timings["backend"] = time.Since(t0).Round(time.Millisecond).String()
	if err := app.provisionToIVChannels(ctx, s); err != nil {
		fail("provision: %v", err)
	}
	base := app.RuntimeConfig().BaseURL
	client := &http.Client{Timeout: 15 * time.Second}
	if resp, err := client.Get(base + "/health"); err == nil {
		rep.Backend = resp.StatusCode < 500
		_ = resp.Body.Close()
	} else {
		fail("backend health: %v", err)
	}

	// 4) agent-host: /assistant/status launches it and reports available once its health probe passes.
	deadline := time.Now().Add(150 * time.Second)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/assistant/status", nil)
		req.Header.Set(httptransport.LaunchTokenHeader, app.RuntimeConfig().LaunchToken)
		if resp, err := client.Do(req); err == nil {
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
			_ = resp.Body.Close()
			var body struct {
				Data struct {
					Available bool   `json:"available"`
					Reason    string `json:"reason"`
				} `json:"data"`
			}
			_ = json.Unmarshal(raw, &body)
			rep.AgentHostState = body.Data.Reason
			if body.Data.Available {
				rep.AgentHost = true
				rep.AgentHostState = "available"
				break
			}
		}
		time.Sleep(2 * time.Second)
	}
	rep.Timings["agentHost"] = time.Since(t0).Round(time.Millisecond).String()
	if !rep.AgentHost {
		fail("agent-host not available: %s", rep.AgentHostState)
	}
	if rep.Backend && rep.AgentHost && rep.LoginPage && rep.LoginEndpoint > 0 && rep.LoginEndpoint < 500 {
		return 0
	}
	return 1
}
