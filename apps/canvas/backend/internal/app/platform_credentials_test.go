package app

import (
	"testing"

	"infinite-canvas/backend/internal/workspace"
)

func TestBlankOrRedactedAndOrigin(t *testing.T) {
	if !blankOrRedacted(nil) || !blankOrRedacted("") || !blankOrRedacted(workspace.RedactedSecret) || blankOrRedacted("sk-user-own") {
		t.Fatal("blankOrRedacted")
	}
	if originOf("http://127.0.0.1:8090/api/llm/v1") != "http://127.0.0.1:8090" || originOf("::bad") != "" {
		t.Fatal("originOf")
	}
	if !headersCarryRedaction([]any{map[string]any{"name": "x", "value": workspace.RedactedSecret}}) || headersCarryRedaction([]any{map[string]any{"value": "v"}}) {
		t.Fatal("headersCarryRedaction")
	}
}

func TestApplyPlatformChannelSecretsMatchesWorkspaceChannelByOrigin(t *testing.T) {
	snapshot := platformProviderSnapshot{Channels: []platformChannel{
		{ID: "other", BaseURL: "https://api.example.com/v1", APIKey: "sk-other"},
		{ID: "h3", BaseURL: "http://127.0.0.1:8090", APIKey: "platform-h3-token"},
	}}
	run := func(config map[string]any) map[string]any {
		input := map[string]any{"config": config}
		applyPlatformChannelSecrets(input, config, snapshot, blankOrRedacted(config["apiKey"]), false, false)
		return config
	}
	got := run(map[string]any{"channelId": "", "baseUrl": "http://127.0.0.1:8090", "apiKey": workspace.RedactedSecret})
	if got["apiKey"] != "platform-h3-token" {
		t.Fatalf("origin match did not inject: %v", got["apiKey"])
	}
	got = run(map[string]any{"channelId": "", "baseUrl": "http://127.0.0.1:8090", "apiKey": ""})
	if got["apiKey"] != "platform-h3-token" {
		t.Fatalf("blank key not injected: %v", got["apiKey"])
	}
	got = run(map[string]any{"channelId": "h3", "baseUrl": "https://attacker.invalid/x", "apiKey": workspace.RedactedSecret})
	if got["apiKey"] != "platform-h3-token" || got["baseUrl"] != "http://127.0.0.1:8090" {
		t.Fatalf("id match not pinned: %v %v", got["apiKey"], got["baseUrl"])
	}
	got = run(map[string]any{"channelId": "", "baseUrl": "https://attacker.invalid/x", "apiKey": workspace.RedactedSecret})
	if got["apiKey"] != "" || got["baseUrl"] != "https://attacker.invalid/x" {
		t.Fatalf("unknown origin got a credential: %v", got["apiKey"])
	}
	got = run(map[string]any{"channelId": "", "baseUrl": "http://127.0.0.1:8090", "apiKey": "sk-mine"})
	if got["apiKey"] != "sk-mine" {
		t.Fatalf("own key replaced: %v", got["apiKey"])
	}
}
