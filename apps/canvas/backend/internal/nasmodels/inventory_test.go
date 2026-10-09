package nasmodels

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalDefaultsH3AndImageWorkers(t *testing.T) {
	d := LocalDefaults()
	if d["h3_worker"] != DefaultH3Worker || DefaultH3Worker != ":8264" {
		t.Fatalf("h3_worker=%v want :8264", d["h3_worker"])
	}
	if d["image_worker"] != DefaultImageWorker || DefaultImageWorker != ":8196" {
		t.Fatalf("image_worker=%v want :8196", d["image_worker"])
	}
	if d["image_channel_name"] != "本地·生图" {
		t.Fatalf("image channel=%v", d["image_channel_name"])
	}
	if d["chat_alias"] != "deepseek-v4-flash-dspark" {
		t.Fatalf("chat_alias=%v", d["chat_alias"])
	}
	if d["cloud_presets_default_open"] != false {
		t.Fatalf("cloud presets must not default-open")
	}
	if d["video_channel_name"] != "本地·H3视频" {
		t.Fatalf("video name=%v", d["video_channel_name"])
	}
	if d["swap_hint"] != SwapHint {
		t.Fatalf("swap_hint=%v", d["swap_hint"])
	}
}

func TestPickerH3Filter(t *testing.T) {
	dir := t.TempDir()
	picker := filepath.Join(dir, "NAS_MODEL_PICKER.json")
	doc := map[string]any{
		"nas_root_default": "toiv/comfyui-models",
		"h3": []map[string]any{
			{"basename": "a.safetensors", "rel_path": "h3/diffusion_models/a.safetensors", "用途": "H3主模型", "bytes": 1},
		},
		"main": []map[string]any{
			{"basename": "b.safetensors", "rel_path": "checkpoints/b.safetensors", "用途": "出图主线·checkpoint", "bytes": 2},
			{"basename": "lora.safetensors", "rel_path": "loras/lora.safetensors", "用途": "LoRA", "bytes": 3},
		},
	}
	raw, _ := json.Marshal(doc)
	if err := os.WriteFile(picker, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvPickerPath, picker)
	store := NewStore(dir)
	inv, err := store.Inventory("h3")
	if err != nil {
		t.Fatal(err)
	}
	if len(inv.H3) != 1 || len(inv.Main) != 0 {
		t.Fatalf("h3 filter failed: h3=%d main=%d", len(inv.H3), len(inv.Main))
	}
	if inv.H3Worker != ":8264" {
		t.Fatalf("worker=%s", inv.H3Worker)
	}
	if inv.ImageWorker != ":8196" {
		t.Fatalf("image worker=%s", inv.ImageWorker)
	}
	job, err := store.StartBind("h3/diffusion_models/a.safetensors", "h3", "")
	if err != nil {
		t.Fatal(err)
	}
	waitDone(t, store, job.ID, "h3/diffusion_models/a.safetensors", ":8264")
}

func TestImageBindRequiresChuTuPurposeAnd8196(t *testing.T) {
	dir := t.TempDir()
	picker := filepath.Join(dir, "p.json")
	doc := map[string]any{
		"h3": []map[string]any{},
		"main": []map[string]any{
			{"basename": "b.safetensors", "rel_path": "checkpoints/b.safetensors", "用途": "出图主线·checkpoint"},
			{"basename": "lora.safetensors", "rel_path": "loras/lora.safetensors", "用途": "LoRA"},
		},
	}
	raw, _ := json.Marshal(doc)
	_ = os.WriteFile(picker, raw, 0o644)
	t.Setenv(EnvPickerPath, picker)
	store := NewStore(dir)

	if _, err := store.StartBind("loras/lora.safetensors", "image", ":8196"); err == nil {
		t.Fatal("expected reject non-出图")
	}
	if _, err := store.StartBind("checkpoints/b.safetensors", "image", ":8205"); err == nil {
		t.Fatal("expected reject forbidden worker")
	}
	if _, err := store.StartBind("checkpoints/b.safetensors", "image", ":8195"); err == nil {
		t.Fatal("expected reject trial worker")
	}
	job, err := store.StartBind("checkpoints/b.safetensors", "image", ":8196")
	if err != nil {
		t.Fatal(err)
	}
	bind := waitDone(t, store, job.ID, "checkpoints/b.safetensors", ":8196")
	if bind.Group != "image" {
		t.Fatalf("group=%s", bind.Group)
	}
	// LB :8188 remaps to :8196
	job2, err := store.StartBind("checkpoints/b.safetensors", "main", ":8188")
	if err != nil {
		t.Fatal(err)
	}
	waitDone(t, store, job2.ID, "checkpoints/b.safetensors", ":8196")
}

func TestRejectNonH3BindIntoH3Group(t *testing.T) {
	dir := t.TempDir()
	picker := filepath.Join(dir, "p.json")
	_ = os.WriteFile(picker, []byte(`{"h3":[{"basename":"a","rel_path":"h3/a","用途":"H3"}],"main":[{"basename":"b","rel_path":"checkpoints/b","用途":"出图主线·checkpoint"}]}`), 0o644)
	t.Setenv(EnvPickerPath, picker)
	store := NewStore(dir)
	if _, err := store.StartBind("checkpoints/b", "h3", ""); err == nil {
		t.Fatal("expected reject")
	}
}

func TestResolveWorkerForbidden(t *testing.T) {
	if !IsForbiddenWorker(":8205") || !IsForbiddenWorker(":8261") {
		t.Fatal("forbidden list incomplete")
	}
	if IsForbiddenWorker(":8196") || IsForbiddenWorker(":8264") {
		t.Fatal("production workers must not be forbidden")
	}
}

func waitDone(t *testing.T, store *Store, id, wantPath, wantWorker string) *Binding {
	t.Helper()
	for i := 0; i < 50; i++ {
		got, ok := store.Job(id)
		if !ok {
			t.Fatal("missing job")
		}
		if got.Status == "done" {
			if got.Binding == nil || got.Binding.RelPath != wantPath {
				t.Fatalf("binding=%v", got.Binding)
			}
			if got.Binding.Worker != wantWorker {
				t.Fatalf("worker=%s want %s", got.Binding.Worker, wantWorker)
			}
			if got.Hint == "" {
				t.Fatal("expected hint")
			}
			return got.Binding
		}
		if got.Status == "error" {
			t.Fatalf("job error: %s", got.Error)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("bind job did not finish")
	return nil
}
