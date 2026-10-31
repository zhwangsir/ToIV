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
		t.Fatal("toiv-comfy-video must expose prepare steps for LongCat/Continue/Avatar/VACE/Animate routing")
	}
	return preparer
}

func vid(id, role string) MediaReference {
	return MediaReference{ID: id, URL: "/api/resources/" + id + ".mp4", Kind: "video", Role: role, MIMEType: "video/mp4"}
}

func aud(id, role string) MediaReference {
	return MediaReference{ID: id, URL: "/api/resources/" + id + ".wav", Kind: "audio", Role: role, MIMEType: "audio/wav"}
}

func TestToivComfyVideoRoutesLongCatVaceWanAnimate(t *testing.T) {
	preparer := loadToivComfyVideoPreparer(t)
	cases := []struct {
		name       string
		model      string
		engine     string
		images     []MediaReference
		videos     []MediaReference
		audios     []MediaReference
		path       string
		uploads    int
		uploadKind string
	}{
		{name: "wan alias", model: "local-wan", path: "/api/generate/txt2video"},
		{name: "wan basename", model: "Wan2_2-T2V-A14B_HIGH_fp8.safetensors", path: "/api/generate/txt2video"},
		{name: "longcat alias t2v", model: "local-longcat", path: "/api/longcat/t2v"},
		{name: "longcat name t2v", model: "LongCat_TI2V_comfy_fp8.safetensors", path: "/api/longcat/t2v"},
		{name: "longcat engine opt", model: "custom.safetensors", engine: "longcat", path: "/api/longcat/t2v"},
		{name: "longcat i2v", model: "local-longcat", images: []MediaReference{img("a", "first_frame")}, path: "/api/longcat/i2v", uploads: 1, uploadKind: "wan_vace"},
		{name: "vace alias", model: "local-vace", images: []MediaReference{img("a", "reference_image")}, path: "/api/wan/vace", uploads: 1, uploadKind: "wan_vace"},
		{name: "vace name", model: "Wan2_1-VACE_module_14B_fp8.safetensors", images: []MediaReference{img("a", ""), img("b", "")}, path: "/api/wan/vace", uploads: 2, uploadKind: "wan_vace"},
		{name: "animate alias", model: "local-wan-animate", images: []MediaReference{img("a", "reference_image")}, videos: []MediaReference{vid("d", "drive_video")}, path: "/api/wan/animate2", uploads: 2, uploadKind: "wan_animate2"},
		{name: "animate2 name", model: "wan2.2-animate-2-14b.safetensors", images: []MediaReference{img("a", "")}, videos: []MediaReference{vid("d", "")}, path: "/api/wan/animate2", uploads: 2, uploadKind: "wan_animate2"},
		{name: "animate engine opt", model: "custom.safetensors", engine: "animate2", images: []MediaReference{img("a", "")}, videos: []MediaReference{vid("d", "")}, path: "/api/wan/animate2", uploads: 2, uploadKind: "wan_animate2"},
		{name: "continue alias", model: "local-longcat-continue", videos: []MediaReference{vid("s", "drive_video")}, path: "/api/longcat/continue", uploads: 0},
		{name: "continue engine opt", model: "custom.safetensors", engine: "continue", videos: []MediaReference{vid("s", "")}, path: "/api/longcat/continue", uploads: 0},
		{name: "avatar alias", model: "local-longcat-avatar", images: []MediaReference{img("a", "reference_image")}, audios: []MediaReference{aud("w", "drive_audio")}, path: "/api/avatar/talk", uploads: 2, uploadKind: "avatar"},
		{name: "avatar name", model: "LongCat-Avatar-15_comfy-Q8_0.gguf", images: []MediaReference{img("a", "")}, audios: []MediaReference{aud("w", "")}, path: "/api/avatar/talk", uploads: 2, uploadKind: "avatar"},
		{name: "avatar engine opt", model: "custom.safetensors", engine: "avatar", images: []MediaReference{img("a", "")}, audios: []MediaReference{aud("w", "")}, path: "/api/avatar/talk", uploads: 2, uploadKind: "avatar"},
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
				Videos:          tc.videos,
				Audios:          tc.audios,
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
				wantKind := tc.uploadKind
				if wantKind == "" {
					wantKind = "wan_vace"
				}
				if call.Path != "/api/upload" || call.Query["kind"][0] != wantKind {
					t.Fatalf("upload=%+v want kind=%s", call, wantKind)
				}
			}
			body := manifestTestBody(t, spec)
			if body["positive"] != "p" {
				t.Fatalf("positive=%v", body["positive"])
			}
			switch {
			case tc.path == "/api/longcat/continue":
				if _, ok := body["length"]; ok {
					t.Fatal("continue must not send Wan length")
				}
				if _, ok := body["duration_sec"]; !ok {
					t.Fatal("continue must send duration_sec")
				}
				// source video is product/resource URL — not /api/upload
				if body["video"] == nil {
					t.Fatalf("continue body=%v", body)
				}
				video, _ := body["video"].(string)
				if !strings.Contains(video, "/api/") {
					t.Fatalf("continue video want product/resource URL, got %q", video)
				}
			case tc.path == "/api/avatar/talk":
				if _, ok := body["length"]; ok {
					t.Fatal("avatar must not send Wan length")
				}
				if _, ok := body["duration_sec"]; !ok {
					t.Fatal("avatar must send duration_sec")
				}
				if body["image"] == nil || body["audio"] == nil || body["worker"] == nil {
					t.Fatalf("avatar body=%v", body)
				}
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
			case tc.path == "/api/wan/animate2":
				if body["image"] == nil || body["video"] == nil || body["worker"] == nil {
					t.Fatalf("animate body=%v", body)
				}
				if _, ok := body["duration_sec"]; !ok {
					t.Fatal("animate must send duration_sec")
				}
				if _, ok := body["length"]; ok {
					t.Fatal("animate must not send Wan length")
				}
			default:
				if _, ok := body["length"]; !ok {
					t.Fatal("wan must send length")
				}
			}
		})
	}
}

func TestToivComfyVideoManifestMentionsLongCatVaceAnimateRoutes(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "toiv-comfy-video", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	for _, needle := range []string{"/api/longcat/t2v", "/api/longcat/i2v", "/api/longcat/continue", "/api/avatar/talk", "/api/wan/vace", "/api/wan/animate2", "/api/generate/txt2video", "wan_animate2", "avatar"} {
		if !strings.Contains(s, needle) {
			t.Fatalf("manifest missing %s", needle)
		}
	}
}
