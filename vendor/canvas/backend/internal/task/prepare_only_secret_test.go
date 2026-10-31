package task

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

const platformPlainAPIKey = "platform-h3-plaintext-key"

// injectingSecrets stands in for app.resolvePlatformChannelSecrets + protectTaskSecrets:
// a blank/marker key becomes the platform credential, and Protect replaces it with ciphertext.
type injectingSecrets struct{ passSecrets }

func (injectingSecrets) ResolveManaged(input map[string]any) (map[string]any, error) {
	config, _ := input["config"].(map[string]any)
	if config == nil {
		config = map[string]any{}
		input["config"] = config
	}
	key, _ := config["apiKey"].(string)
	if strings.TrimSpace(key) == "" || key == "__BEEFTV_REDACTED__" {
		config["apiKey"] = platformPlainAPIKey
	}
	return input, nil
}

func (injectingSecrets) Protect(input map[string]any) error {
	config, _ := input["config"].(map[string]any)
	if config == nil {
		return nil
	}
	if key, _ := config["apiKey"].(string); key != "" && !strings.HasPrefix(key, "enc:") {
		sum := sha256.Sum256([]byte(key))
		config["apiKey"] = "enc:" + hex.EncodeToString(sum[:])
	}
	return nil
}

func TestPrepareOnlyQuoteResponseHasNoPlaintextAPIKey(t *testing.T) {
	store := newMemStore()
	svc := domainService(store, func(d *Dependencies) { d.Secrets = injectingSecrets{} })
	task, err := svc.CreateTask("user", CreateRequest{
		Type:        "canvas_video",
		Prompt:      "quote a kite",
		PrepareOnly: true,
		Input:       map[string]any{"config": map[string]any{"apiKey": "__BEEFTV_REDACTED__", "baseUrl": "http://127.0.0.1:8090"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(task.InputJSON, platformPlainAPIKey) {
		t.Fatalf("quote/PrepareOnly response leaked the platform apiKey: %s", task.InputJSON)
	}
	if !strings.Contains(task.InputJSON, "enc:") {
		t.Fatalf("expected ciphertext in InputJSON, got %s", task.InputJSON)
	}
	if listed, _ := store.List("user", 10, "", false); len(listed) != 0 {
		t.Fatal("prepare-only persisted a row")
	}
}
