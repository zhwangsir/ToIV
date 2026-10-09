package protocol

import (
	"encoding/json"
	"testing"
)

// Regression: ProviderOptions is map[string]map[string]any; without JSON-normalize,
// $ref paths like request.providerOptions.toiv-h3.width cannot navigate past the
// outer typed map (manifestPathValue only accepts map[string]any).
func TestProviderOptionsPathAfterNormalize(t *testing.T) {
	req := GenerationRequest{
		ProviderOptions: map[string]map[string]any{
			"toiv-comfy-image": {"width": 640, "negative": "blur"},
		},
	}
	values := manifestRequestValues(req)
	if _, ok := values["providerOptions"].(map[string]any); !ok {
		t.Fatalf("providerOptions type=%T, want map[string]any", values["providerOptions"])
	}
	raw, _ := json.Marshal(values["providerOptions"])
	if string(raw) == "null" || string(raw) == "" {
		t.Fatalf("providerOptions empty: %s", raw)
	}
	width := manifestPathValue(map[string]any{"request": values}, "request.providerOptions.toiv-comfy-image.width")
	if width != float64(640) {
		t.Fatalf("width=%v", width)
	}
	neg := manifestPathValue(map[string]any{"request": values}, "request.providerOptions.toiv-comfy-image.negative")
	if neg != "blur" {
		t.Fatalf("negative=%v", neg)
	}
}
