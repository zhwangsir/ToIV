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

func TestToivComfyImageCreateBodyFields(t *testing.T) {
	adapter := loadToivComfy(t, "toiv-comfy-image")
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{
		BaseURL: "http://127.0.0.1:8090",
		Request: GenerationRequest{
			Model:  "majicMIX.safetensors",
			Prompt: "a cat",
			ProviderOptions: map[string]map[string]any{
				"toiv-comfy-image": {
					"width":    640,
					"height":   480,
					"steps":    28,
					"cfg":      3.5,
					"negative": "blur",
					"seed":     42,
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, spec)
	if body["positive"] != "a cat" {
		t.Fatalf("positive=%v", body["positive"])
	}
	if body["ckpt_name"] != "majicMIX.safetensors" {
		t.Fatalf("ckpt_name=%v", body["ckpt_name"])
	}
	if body["engine"] != "comfyui" {
		t.Fatalf("engine=%v", body["engine"])
	}
	if int(body["width"].(float64)) != 640 || int(body["height"].(float64)) != 480 {
		t.Fatalf("size=%v x %v (providerOptions not applied?)", body["width"], body["height"])
	}
	if int(body["steps"].(float64)) != 28 {
		t.Fatalf("steps=%v", body["steps"])
	}
	if body["cfg"].(float64) != 3.5 {
		t.Fatalf("cfg=%v", body["cfg"])
	}
	if body["negative"] != "blur" {
		t.Fatalf("negative=%v", body["negative"])
	}
	if int(body["seed"].(float64)) != 42 {
		t.Fatalf("seed=%v", body["seed"])
	}
}

func TestToivComfyVideoCreateBodyFields(t *testing.T) {
	adapter := loadToivComfy(t, "toiv-comfy-video")
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{
		BaseURL: "http://127.0.0.1:8090",
		Request: GenerationRequest{
			Model:    "local-wan",
			Prompt:   "waves",
			Duration: 3,
			ProviderOptions: map[string]map[string]any{
				"toiv-comfy-video": {
					"width":  704,
					"height": 384,
					"fps":    12,
					"length": 25,
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, spec)
	if body["positive"] != "waves" {
		t.Fatalf("positive=%v", body["positive"])
	}
	if int(body["width"].(float64)) != 704 || int(body["height"].(float64)) != 384 {
		t.Fatalf("size=%v x %v (providerOptions not applied?)", body["width"], body["height"])
	}
	if int(body["fps"].(float64)) != 12 {
		t.Fatalf("fps=%v", body["fps"])
	}
	if int(body["length"].(float64)) != 25 {
		t.Fatalf("length=%v", body["length"])
	}
	if _, bad := body["ckpt_name"]; bad {
		t.Fatal("txt2video must not send ckpt_name")
	}
}
