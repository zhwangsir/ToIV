package nasmodels

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalDefaultsH3WorkerIs8264(t *testing.T) {
	d := LocalDefaults()
	if d["h3_worker"] != DefaultH3Worker || DefaultH3Worker != ":8264" {
		t.Fatalf("h3_worker=%v want :8264", d["h3_worker"])
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
			{"basename": "b.safetensors", "rel_path": "checkpoints/b.safetensors", "用途": "出图", "bytes": 2},
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
	job, err := store.StartBind("h3/diffusion_models/a.safetensors", "h3")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ {
		got, ok := store.Job(job.ID)
		if !ok {
			t.Fatal("missing job")
		}
		if got.Status == "done" {
			if got.Binding == nil || got.Binding.RelPath != "h3/diffusion_models/a.safetensors" {
				t.Fatalf("binding=%v", got.Binding)
			}
			return
		}
		if got.Status == "error" {
			t.Fatalf("job error: %s", got.Error)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("bind job did not finish")
}

func TestRejectNonH3BindIntoH3Group(t *testing.T) {
	dir := t.TempDir()
	picker := filepath.Join(dir, "p.json")
	_ = os.WriteFile(picker, []byte(`{"h3":[{"basename":"a","rel_path":"h3/a"}],"main":[{"basename":"b","rel_path":"checkpoints/b"}]}`), 0o644)
	t.Setenv(EnvPickerPath, picker)
	store := NewStore(dir)
	if _, err := store.StartBind("checkpoints/b", "h3"); err == nil {
		t.Fatal("expected reject")
	}
}
