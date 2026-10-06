package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// toiv-h3: the task key must carry the ToIV job_id from the very first submit
// response when ToIV returns it (>=472d69b), and fall back to prompt_id otherwise.
func TestToIVH3TaskIDUsesSubmitJobID(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "toiv-h3", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Contributes struct {
			Providers []struct {
				Response map[string]any `json:"response"`
			} `json:"providers"`
		} `json:"contributes"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	expr := manifest.Contributes.Providers[0].Response["taskId"]
	cases := []struct {
		name     string
		response map[string]any
		taskID   string
		want     string
	}{
		{"new submit with job_id", map[string]any{"job_id": "J1", "prompt_id": "p-1"}, "", "J1~p-1"},
		{"old submit prompt only", map[string]any{"prompt_id": "p-1"}, "", "p-1"},
		{"lookup row upgrades key", map[string]any{"id": "J1", "prompt_id": "p-1", "status": "running"}, "p-1", "J1~p-1"},
		{"lookup keeps composite key", map[string]any{"id": "J1", "prompt_id": "p-1"}, "J1~p-1", "J1~p-1"},
	}
	for _, c := range cases {
		got, err := evaluateManifestValue(expr, map[string]any{"response": c.response, "taskId": c.taskID})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got != c.want {
			t.Fatalf("%s: taskId = %#v, want %q", c.name, got, c.want)
		}
	}
}
