package runtimeinfo

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsRuntimeDescriptorPaths(t *testing.T) {
	home := filepath.Join("C:", "Users", "fixture")
	data := filepath.Join(home, "AppData", "Roaming", "ToIV")
	primary, legacy, hash := windowsRuntimeDescriptorPaths(home, data)
	if hash == "" || len(hash) != 64 {
		t.Fatalf("hash len=%d value=%q", len(hash), hash)
	}
	wantPrimary := filepath.Join(home, ".toiv", "runtime", hash+".json")
	wantLegacy := filepath.Join(home, ".beeftv", "runtime", hash+".json")
	if primary != wantPrimary {
		t.Fatalf("primary=%q want %q", primary, wantPrimary)
	}
	if legacy != wantLegacy {
		t.Fatalf("legacy=%q want %q", legacy, wantLegacy)
	}
	// same dataDir under different case/clean forms share identity
	alt := filepath.Join(home, "AppData", "Roaming", "ToIV", "child", "..")
	p2, l2, h2 := windowsRuntimeDescriptorPaths(home, alt)
	if h2 != hash || p2 != primary || l2 != legacy {
		t.Fatalf("normalization mismatch: hash %q vs %q", hash, h2)
	}
	other := filepath.Join(home, "AppData", "Roaming", "Other")
	_, _, hOther := windowsRuntimeDescriptorPaths(home, other)
	if hOther == hash {
		t.Fatal("distinct data dirs must not share hash")
	}
	if strings.Contains(primary, "AppData") || strings.Contains(legacy, "AppData") {
		t.Fatal("descriptor must stay outside AppData")
	}
}
