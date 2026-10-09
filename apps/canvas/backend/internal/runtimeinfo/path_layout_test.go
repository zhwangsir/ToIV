package runtimeinfo

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsRuntimeDescriptorPathsWriteNewReadLegacyLayout(t *testing.T) {
	home := filepath.FromSlash("/Users/fixture")
	dataDir := filepath.FromSlash("/Users/fixture/AppData/Roaming/ToIV")
	primary, legacy, hash := windowsRuntimeDescriptorPaths(home, dataDir)
	if hash == "" || len(hash) != 64 {
		t.Fatalf("expected sha256 hex hash, got %q", hash)
	}
	wantPrimary := filepath.Join(home, ".toiv", "runtime", hash+".json")
	wantLegacy := filepath.Join(home, ".beeftv", "runtime", hash+".json")
	if primary != wantPrimary {
		t.Fatalf("primary = %q, want %q", primary, wantPrimary)
	}
	if legacy != wantLegacy {
		t.Fatalf("legacy = %q, want %q", legacy, wantLegacy)
	}
	if strings.Contains(primary, ".beeftv") {
		t.Fatal("primary must not use legacy .beeftv root")
	}
	if !strings.Contains(legacy, ".beeftv") {
		t.Fatal("legacy must stay under .beeftv")
	}

	// Same workspace identity under case / slash / ../ normalization.
	equiv := filepath.Join(dataDir, "child", "..")
	p2, l2, h2 := windowsRuntimeDescriptorPaths(home, strings.ToUpper(equiv))
	if p2 != primary || l2 != legacy || h2 != hash {
		t.Fatalf("normalization diverged: %q/%q/%q vs %q/%q/%q", p2, l2, h2, primary, legacy, hash)
	}

	other := filepath.FromSlash("/Users/fixture/AppData/Roaming/Other")
	_, _, otherHash := windowsRuntimeDescriptorPaths(home, other)
	if otherHash == hash {
		t.Fatal("distinct data dirs must not share descriptor hash")
	}
}
