package nasmodels

import "testing"

func TestTryObjectInfoRefreshWithoutBaseKeepsHint(t *testing.T) {
	t.Setenv(EnvImageComfyBase, "")
	t.Setenv(EnvH3ComfyBase, "")
	t.Setenv(EnvObjectInfoURL, "")
	ok, detail := tryObjectInfoRefresh("image", ":8196")
	if ok {
		t.Fatal("expected no refresh without base")
	}
	if detail != SwapHint {
		t.Fatalf("detail=%q", detail)
	}
}

func TestDefaultWorkerForGroup(t *testing.T) {
	if DefaultWorkerForGroup("h3") != ":8264" {
		t.Fatal(DefaultWorkerForGroup("h3"))
	}
	if DefaultWorkerForGroup("image") != ":8196" {
		t.Fatal(DefaultWorkerForGroup("image"))
	}
}
