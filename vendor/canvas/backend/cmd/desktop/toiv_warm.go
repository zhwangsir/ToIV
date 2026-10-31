package main

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	httptransport "infinite-canvas/backend/internal/transport/http"
)

// warmAssistant starts the built-in assistant host right after the workspace is activated, so the
// first time the user opens the panel it is already available instead of cold-starting.
// GET /assistant/status launches the host when it is not running; we poll until it reports
// available, or stop on any reason other than host_starting (the panel shows its own notice then).
func (a *DesktopApp) warmAssistant(timeout time.Duration) bool {
	cfg := a.RuntimeConfig()
	if cfg.BaseURL == "" {
		return false
	}
	client := &http.Client{Timeout: 10 * time.Second}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		req, err := http.NewRequest(http.MethodGet, cfg.BaseURL+"/assistant/status", nil)
		if err != nil {
			return false
		}
		req.Header.Set(httptransport.LaunchTokenHeader, cfg.LaunchToken)
		if resp, err := client.Do(req); err == nil {
			var body struct {
				Data struct {
					Available bool   `json:"available"`
					Reason    string `json:"reason"`
				} `json:"data"`
			}
			_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body)
			_ = resp.Body.Close()
			if body.Data.Available {
				return true
			}
			if body.Data.Reason != "" && body.Data.Reason != "host_starting" {
				return false
			}
		}
		time.Sleep(time.Second)
	}
	return false
}
