package desktopupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func isolateUserCache(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, "xdg-cache"))
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "LocalAppData"))
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	return cache
}

func TestUpdatesRootDefaultToIV(t *testing.T) {
	cache := isolateUserCache(t)
	e := &Engine{}
	got, err := e.updatesRoot()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(cache, "ToIV", "updates")
	if got != want {
		t.Fatalf("default root = %q, want %q", got, want)
	}
	if info, err := os.Stat(want); err != nil || !info.IsDir() {
		t.Fatalf("ToIV updates dir should be created, err=%v", err)
	}
	legacy := filepath.Join(cache, "BeefTV", "updates")
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("should not create legacy cache, err=%v", err)
	}
}

func TestUpdatesRootFallsBackToLegacyBeefTV(t *testing.T) {
	cache := isolateUserCache(t)
	legacy := filepath.Join(cache, "BeefTV", "updates")
	if err := os.MkdirAll(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(legacy, "partial.bin")
	if err := os.WriteFile(marker, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}

	e := &Engine{}
	got, err := e.updatesRoot()
	if err != nil {
		t.Fatal(err)
	}
	if got != legacy {
		t.Fatalf("legacy-only root = %q, want %q", got, legacy)
	}
	toiv := filepath.Join(cache, "ToIV", "updates")
	if _, err := os.Stat(toiv); !os.IsNotExist(err) {
		t.Fatalf("fallback must not create ToIV/updates, err=%v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("legacy cache must stay untouched: %v", err)
	}
}

func TestUpdatesRootPrefersToIVWhenBothExist(t *testing.T) {
	cache := isolateUserCache(t)
	toiv := filepath.Join(cache, "ToIV", "updates")
	legacy := filepath.Join(cache, "BeefTV", "updates")
	for _, dir := range []string{toiv, legacy} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(legacy, "old.bin"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	e := &Engine{}
	got, err := e.updatesRoot()
	if err != nil {
		t.Fatal(err)
	}
	if got != toiv {
		t.Fatalf("both-exist root = %q, want %q", got, toiv)
	}
	if _, err := os.Stat(filepath.Join(legacy, "old.bin")); err != nil {
		t.Fatalf("legacy cache must not be deleted: %v", err)
	}
}

func TestUpdatesRootHonorsStagingRoot(t *testing.T) {
	_ = isolateUserCache(t)
	explicit := filepath.Join(t.TempDir(), "explicit-staging")
	e := &Engine{stagingRoot: explicit}
	got, err := e.updatesRoot()
	if err != nil {
		t.Fatal(err)
	}
	if got != explicit {
		t.Fatalf("stagingRoot = %q, want %q", got, explicit)
	}
	if info, err := os.Stat(explicit); err != nil || !info.IsDir() {
		t.Fatalf("explicit staging should be created, err=%v", err)
	}
}
