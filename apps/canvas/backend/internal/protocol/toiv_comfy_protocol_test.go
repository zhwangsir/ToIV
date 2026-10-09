package protocol

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loadToivComfy(t *testing.T, dir string) Adapter {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := LoadManifest(raw)
	if err != nil {
		t.Fatalf("LoadManifest %s: %v", dir, err)
	}
	return adapter
}

func TestToivComfyImageManifest(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "toiv-comfy-image", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	adapter := loadToivComfy(t, "toiv-comfy-image")
	meta := adapter.Metadata()
	if meta.ID != "toiv-comfy-image" {
		t.Fatalf("id = %q", meta.ID)
	}
	hasImage := false
	for _, c := range meta.Categories {
		if string(c) == "image" {
			hasImage = true
		}
	}
	if !hasImage {
		t.Fatalf("categories = %#v, want image", meta.Categories)
	}
	contrib, _ := json.Marshal(wire["contributes"])
	if !strings.Contains(string(contrib), "/api/generate/txt2img") {
		t.Fatal("manifest must POST /api/generate/txt2img")
	}
	if strings.Contains(string(contrib), "openai-images") || strings.Contains(string(contrib), "/v1/images/") {
		t.Fatal("create contrib must not use openai-images")
	}
	if !strings.Contains(string(contrib), "/api/jobs/lookup") {
		t.Fatal("manifest must poll /api/jobs/lookup")
	}

	spec, err := adapter.BuildCreate(context.Background(), RequestContext{
		BaseURL: "http://127.0.0.1:8090",
		Request: GenerationRequest{Model: "majicMIX.safetensors", Prompt: "a cat"},
	})
	if err != nil {
		t.Fatalf("BuildCreate: %v", err)
	}
	if !strings.Contains(spec.Path, "/api/generate/txt2img") {
		t.Fatalf("create path = %q", spec.Path)
	}
}

func TestToivComfyVideoManifest(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "toiv-comfy-video", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	adapter := loadToivComfy(t, "toiv-comfy-video")
	meta := adapter.Metadata()
	if meta.ID != "toiv-comfy-video" {
		t.Fatalf("id = %q", meta.ID)
	}
	hasVideo := false
	for _, c := range meta.Categories {
		if string(c) == "video" {
			hasVideo = true
		}
	}
	if !hasVideo {
		t.Fatalf("categories = %#v, want video", meta.Categories)
	}
	contrib, _ := json.Marshal(wire["contributes"])
	if !strings.Contains(string(contrib), "/api/generate/txt2video") {
		t.Fatal("manifest must POST /api/generate/txt2video")
	}
	if !strings.Contains(string(contrib), "/api/jobs/lookup") {
		t.Fatal("manifest must poll /api/jobs/lookup")
	}

	spec, err := adapter.BuildCreate(context.Background(), RequestContext{
		BaseURL: "http://127.0.0.1:8090",
		Request: GenerationRequest{Model: "local-wan", Prompt: "waves on a beach", Duration: 3},
	})
	if err != nil {
		t.Fatalf("BuildCreate: %v", err)
	}
	if !strings.Contains(spec.Path, "/api/generate/txt2video") {
		t.Fatalf("create path = %q", spec.Path)
	}
}
