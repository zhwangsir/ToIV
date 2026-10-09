package protocol

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loadToivComfyVideoPreparer(t *testing.T) PrepareAdapter {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "toiv-comfy-video", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := LoadManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	preparer, ok := adapter.(PrepareAdapter)
	if !ok || preparer.PrepareStepCount() == 0 {
		t.Fatal("toiv-comfy-video must expose prepare steps for LongCat/VACE routing")
	}
	return preparer
}

func TestToivComfyVideoRoutesLongCatVaceWan(t *testing.T) {
	preparer := loadToivComfyVideoPreparer(t)
	cases := []struct {
		name    string
		model   string
		engine  string
		images  []MediaReference
		path    string
		uploads int
	}{
		{name: "wan alias", model: "local-wan", path: "/api/generate/txt2video"},
		{name: "wan basename", model: "Wan2_2-T2V-A14B_HIGH_fp8.safetensors", path: "/api/generate/txt2video"},
		{name: "longcat alias t2v", model: "local-longcat", path: "/api/longcat/t2v"},
		{name: "longcat name t2v", model: "LongCat_TI2V_comfy_fp8.safetensors", path: "/api/longcat/t2v"},
		{name: "longcat engine opt", model: "custom.safetensors", engine: "longcat", path: "/api/longcat/t2v"},
		{name: "longcat i2v", model: "local-longcat", images: []MediaReference{img("a", "first_frame")}, path: "/api/longcat/i2v", uploads: 1},
		{name: "vace alias", model: "local-vace", images: []MediaReference{img("a", "reference_image")}, path: "/api/wan/vace", uploads: 1},
		{name: "vace name", model: "Wan2_1-VACE_module_14B_fp8.safetensors", images: []MediaReference{img("a", ""), img("b", "")}, path: "/api/wan/vace", uploads: 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			uploads := &fakeUpload{}
			opts := map[string]map[string]any{}
			if tc.engine != "" {
				opts["toiv-comfy-video"] = map[string]any{"engine": tc.engine}
			}
			spec, prepared, err := runPrepare(t, preparer, GenerationRequest{
				Capability:      CapabilityVideo,
				Model:           tc.model,
				Prompt:          "p",
				Images:          tc.images,
				Duration:        3,
				ProviderOptions: opts,
			}, uploads)
			if err != nil {
				t.Fatal(err)
			}
			if spec.Path != tc.path {
				t.Fatalf("path=%q want %q prepared=%v", spec.Path, tc.path, prepared)
			}
			if len(uploads.calls) != tc.uploads {
				t.Fatalf("uploads=%d want %d", len(uploads.calls), tc.uploads)
			}
			for _, call := range uploads.calls {
				if call.Path != "/api/upload" || call.Query["kind"][0] != "wan_vace" {
					t.Fatalf("upload=%+v", call)
				}
			}
			body := manifestTestBody(t, spec)
			if body["positive"] != "p" {
				t.Fatalf("positive=%v", body["positive"])
			}
			switch {
			case strings.HasPrefix(tc.path, "/api/longcat/"):
				if _, ok := body["length"]; ok {
					t.Fatal("longcat must not send Wan length")
				}
				if _, ok := body["duration_sec"]; !ok {
					t.Fatal("longcat must send duration_sec")
				}
				if tc.uploads > 0 {
					if body["image"] == nil || body["worker"] == nil {
						t.Fatalf("i2v body=%v", body)
					}
				}
			case tc.path == "/api/wan/vace":
				if body["images"] == nil || body["worker"] == nil {
					t.Fatalf("vace body=%v", body)
				}
			default:
				if _, ok := body["length"]; !ok {
					t.Fatal("wan must send length")
				}
			}
		})
	}
}

func TestToivComfyVideoManifestMentionsLongCatVaceRoutes(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "toiv-comfy-video", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	for _, needle := range []string{"/api/longcat/t2v", "/api/longcat/i2v", "/api/wan/vace", "/api/generate/txt2video"} {
		if !strings.Contains(s, needle) {
			t.Fatalf("manifest missing %s", needle)
		}
	}
}
