package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	httptransport "infinite-canvas/backend/internal/transport/http"
	"infinite-canvas/backend/internal/workspace"
)

const h3ServiceToken = "h3-service-token-must-stay-on-the-server"

func h3ModelConfig(apiKey string) []byte {
	body, _ := json.Marshal(map[string]any{"config": map[string]any{"channels": []any{map[string]any{
		"id": "toiv-h3", "name": "ToIV H3", "baseUrl": "http://127.0.0.1:8090", "apiKey": apiKey,
		"modelProfiles": []any{map[string]any{"model": "h3", "protocol": "toiv-h3", "capability": "video"}},
	}}}})
	return body
}

// The browser reaches canvas-api through the ToIV login door; server-side callers do not.
func TestModelConfigKeepsChannelCredentialsServerSide(t *testing.T) {
	router, store := newModelConfigTestRouter(t)
	browser := httptransport.RequireAlternativeAuth(func(*http.Request) bool { return true })(router)

	// a server-side writer (gate-signed refresh script / no door) stores the service token
	put := httptest.NewRecorder()
	router.ServeHTTP(put, httptest.NewRequest(http.MethodPut, "/api/workspace/model-config", bytes.NewReader(h3ModelConfig(h3ServiceToken))))
	if put.Code != http.StatusOK {
		t.Fatalf("server-side put = %d %s", put.Code, put.Body.String())
	}

	// browser read: marker only
	got := httptest.NewRecorder()
	browser.ServeHTTP(got, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
	if got.Code != http.StatusOK || bytes.Contains(got.Body.Bytes(), []byte(h3ServiceToken)) || !bytes.Contains(got.Body.Bytes(), []byte(workspace.RedactedSecret)) {
		t.Fatalf("browser read leaked or lost the marker: %d %s", got.Code, got.Body.String())
	}

	// browser saves the config back with the marker: stored token preserved
	save := httptest.NewRecorder()
	browser.ServeHTTP(save, httptest.NewRequest(http.MethodPut, "/api/workspace/model-config", bytes.NewReader(h3ModelConfig(workspace.RedactedSecret))))
	if save.Code != http.StatusOK || bytes.Contains(save.Body.Bytes(), []byte(h3ServiceToken)) {
		t.Fatalf("browser save = %d %s", save.Code, save.Body.String())
	}
	raw, err := store.ReadLocalModelConfig()
	if err != nil || !bytes.Contains(raw, []byte(h3ServiceToken)) {
		t.Fatalf("stored service token lost after a browser save: %v", err)
	}

	// server-side read (refresh script read-back) still sees the stored value
	srv := httptest.NewRecorder()
	router.ServeHTTP(srv, httptest.NewRequest(http.MethodGet, "/api/workspace/model-config", nil))
	if !bytes.Contains(srv.Body.Bytes(), []byte(h3ServiceToken)) {
		t.Fatalf("server-side read lost the credential: %s", srv.Body.String())
	}
}
