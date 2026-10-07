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
