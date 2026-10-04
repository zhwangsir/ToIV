package protocol

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// toiv-h3 v0.4: prepare steps pick the H3 route from the inputs, upload the
// references via /api/upload (pinned to the first upload's worker) and create
// posts to /api/h3/{t2v,i2v,fl2v,r2v} with the returned handles.
func loadToIVH3(t *testing.T) PrepareAdapter {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "toiv-h3", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := LoadManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	preparer, ok := adapter.(PrepareAdapter)
	if !ok || preparer.PrepareStepCount() == 0 {
		t.Fatal("toiv-h3 must expose prepare steps")
	}
	return preparer
}

type fakeUpload struct {
	calls []RequestSpec
}

// run mimics the host loop in generation.buildProtocolCreateSpec.
func runPrepare(t *testing.T, preparer PrepareAdapter, request GenerationRequest, uploads *fakeUpload) (RequestSpec, map[string]any, error) {
	t.Helper()
	ctx := context.Background()
	rc := RequestContext{BaseURL: "http://toiv", Request: request}
	prepared := map[string]any{}
	for i := 0; i < preparer.PrepareStepCount(); i++ {
		step, err := preparer.BuildPrepare(ctx, rc, i, prepared)
		if err != nil {
			return RequestSpec{}, prepared, err
		}
		if step.Skip {
			continue
		}
		if step.HasValue {
			prepared[step.ID] = step.Value
			continue
		}
		results := []any{}
		for _, spec := range step.Specs {
			uploads.calls = append(uploads.calls, spec)
			n := len(uploads.calls)
			results = append(results, map[string]any{"filename": "up" + string(rune('0'+n)) + ".png", "worker": "http://w1"})
		}
		if step.Each {
			prepared[step.ID] = results
		} else {
			prepared[step.ID] = results[0]
		}
	}
	spec, err := preparer.BuildCreatePrepared(ctx, rc, prepared)
	return spec, prepared, err
}

func img(id, role string) MediaReference {
	return MediaReference{ID: id, URL: "/api/resources/" + id + ".png", Kind: "image", Role: role, MIMEType: "image/png"}
}

func TestToIVH3PrepareRoutes(t *testing.T) {
	preparer := loadToIVH3(t)
	cases := []struct {
		name      string
		images    []MediaReference
		operation string
		path      string
		uploads   int
		check     func(t *testing.T, body map[string]any)
	}{
		{name: "t2v", path: "/api/h3/t2v", uploads: 0, check: func(t *testing.T, body map[string]any) {
			if _, ok := body["image"]; ok {
				t.Fatalf("t2v must not carry image: %v", body)
			}
		}},
		{name: "i2v single", images: []MediaReference{img("a", "")}, operation: "image_to_video", path: "/api/h3/i2v", uploads: 1, check: func(t *testing.T, body map[string]any) {
			if body["image"] != "up1.png" || body["worker"] != "http://w1" {
				t.Fatalf("i2v body: %v", body)
			}
		}},
		{name: "i2v explicit first + extra ref", images: []MediaReference{img("x", "reference_image"), img("a", "first_frame")}, operation: "image_to_video", path: "/api/h3/i2v", uploads: 1},
		{name: "fl2v roles", images: []MediaReference{img("b", "last_frame"), img("a", "first_frame")}, operation: "image_to_video", path: "/api/h3/fl2v", uploads: 2, check: func(t *testing.T, body map[string]any) {
			if body["image"] != "up1.png" || body["last_frame"] != "up2.png" {
				t.Fatalf("fl2v body: %v", body)
			}
		}},
		{name: "fl2v legacy two", images: []MediaReference{img("a", ""), img("b", "")}, operation: "image_to_video", path: "/api/h3/fl2v", uploads: 2},
		{name: "r2v op", images: []MediaReference{img("a", "reference_image"), img("b", "reference_image"), img("c", "reference_image")}, operation: "reference_to_video", path: "/api/h3/r2v", uploads: 3, check: func(t *testing.T, body map[string]any) {
			if !reflect.DeepEqual(body["images"], []any{"up1.png", "up2.png", "up3.png"}) {
				t.Fatalf("r2v images: %#v", body["images"])
			}
		}},
		{name: "r2v single ref", images: []MediaReference{img("a", "reference_image")}, operation: "reference_to_video", path: "/api/h3/r2v", uploads: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			uploads := &fakeUpload{}
			spec, _, err := runPrepare(t, preparer, GenerationRequest{Capability: CapabilityVideo, Model: "h3", Prompt: "p", Images: tc.images, Operation: tc.operation, AspectRatio: "16:9", Resolution: "480p", Duration: 3}, uploads)
			if err != nil {
				t.Fatal(err)
			}
			if spec.Path != tc.path {
				t.Fatalf("path %q, want %q", spec.Path, tc.path)
			}
			if len(uploads.calls) != tc.uploads {
				t.Fatalf("uploads %d, want %d", len(uploads.calls), tc.uploads)
			}
			for i, call := range uploads.calls {
				if call.Path != "/api/upload" || call.Query["kind"][0] != "h3_i2v" || len(call.Files) != 1 || call.Files[0].Name != "image" {
					t.Fatalf("upload %d spec: %+v", i, call)
				}
				if i > 0 && (len(call.Query["worker"]) != 1 || call.Query["worker"][0] != "http://w1") {
					t.Fatalf("upload %d must be pinned to the first worker: %+v", i, call.Query)
				}
				if i == 0 && len(call.Query["worker"]) != 0 {
					t.Fatalf("first upload must not pin a worker: %+v", call.Query)
				}
			}
			body, _ := spec.Body.(map[string]any)
			if body["positive"] != "p" || body["width"] == nil || body["duration_sec"] == nil {
				t.Fatalf("base body missing: %v", body)
			}
			if tc.check != nil {
				tc.check(t, body)
			}
		})
	}
}

func TestToIVH3PrepareValidationBeforeUpload(t *testing.T) {
	preparer := loadToIVH3(t)
	images := []MediaReference{}
	for i := 0; i < 10; i++ {
		images = append(images, img(string(rune('a'+i)), "reference_image"))
	}
	uploads := &fakeUpload{}
	_, _, err := runPrepare(t, preparer, GenerationRequest{Capability: CapabilityVideo, Model: "h3", Prompt: "p", Images: images, Operation: "reference_to_video"}, uploads)
	if err == nil || len(uploads.calls) != 0 {
		t.Fatalf("10 refs must fail before any upload: err=%v uploads=%d", err, len(uploads.calls))
	}
	_, _, err = runPrepare(t, preparer, GenerationRequest{Capability: CapabilityVideo, Model: "h3", Prompt: "p", Images: []MediaReference{img("b", "last_frame")}, Operation: "image_to_video"}, uploads)
	if err == nil || len(uploads.calls) != 0 {
		t.Fatalf("last frame alone must fail before upload: err=%v", err)
	}
}
