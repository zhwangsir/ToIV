package runtimeinfo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsCanonicalDescriptorIgnoresAppDataShadows(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	dataDir := filepath.Join(home, "AppData", "Roaming", "ToIV")
	shadowDir := filepath.Join(home, "AppData", "Local", "Packages", "fixture", "LocalCache", "Roaming", "ToIV")
	t.Setenv("APPDATA", filepath.Dir(shadowDir))
	t.Setenv("BEEFTV_DATA_DIR", dataDir)
	for _, dir := range []string{dataDir, shadowDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, pid := range []int{os.Getpid(), deadPID(t)} {
		legacy, err := json.Marshal(Info{BaseURL: "http://127.0.0.1:59999/api", PID: pid, Version: "old-shadow"})
		if err != nil {
			t.Fatal(err)
		}
		for _, dir := range []string{dataDir, shadowDir} {
			if err := os.WriteFile(filepath.Join(dir, FileName), legacy, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if err := Write(dataDir, "http://127.0.0.1:53211/api", "canonical"); err != nil {
			t.Fatal(err)
		}
		path := testPath(t, dataDir)
		if !strings.HasPrefix(path, filepath.Join(home, ".toiv", "runtime")+string(os.PathSeparator)) {
			t.Fatalf("descriptor remained inside AppData or legacy root: %s", path)
		}
		if _, err := os.Stat(filepath.Join(home, ".beeftv", "runtime", filepath.Base(path))); !os.IsNotExist(err) {
			t.Fatalf("Write must not create legacy .beeftv path, stat=%v", err)
		}
		info, found := Discover("")
		if !found || info.Version != "canonical" || info.BaseURL != "http://127.0.0.1:53211/api" {
			t.Fatalf("shadow PID %d displaced canonical runtime: %+v, found=%v", pid, info, found)
		}
		// Restart replaces the one canonical file, without changing discovery source.
		if err := Write(dataDir, "http://127.0.0.1:53212/api", "restarted"); err != nil {
			t.Fatal(err)
		}
		info, found = Discover("")
		if !found || info.Version != "restarted" {
			t.Fatalf("canonical replacement not discovered: %+v", info)
		}
		if err := Remove(dataDir); err != nil {
			t.Fatal(err)
		}
		if _, found := Discover(""); found {
			t.Fatalf("missing canonical descriptor fell back to legacy/shadow PID %d", pid)
		}
		for _, dir := range []string{dataDir, shadowDir} {
			if _, err := os.Stat(filepath.Join(dir, FileName)); err != nil {
				t.Fatalf("legacy shadow was modified: %v", err)
			}
		}
	}
}

func TestWindowsReadLegacyWriteNewRuntimeDescriptor(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	dataDir := filepath.Join(home, "AppData", "Roaming", "BeefTV")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}

	primary, legacy, hash := windowsRuntimeDescriptorPaths(home, mustAbs(t, dataDir))
	if err := os.MkdirAll(filepath.Dir(legacy), 0o700); err != nil {
		t.Fatal(err)
	}
	legacyInfo := Info{
		BaseURL:     "http://127.0.0.1:53210/api",
		PID:         os.Getpid(),
		Version:     "legacy-only",
		DataDirHash: hash,
	}
	encoded, err := json.Marshal(legacyInfo)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacy, encoded, 0o600); err != nil {
		t.Fatal(err)
	}

	info, err := Load(dataDir)
	if err != nil || info.Version != "legacy-only" {
		t.Fatalf("Load must read legacy-only file: %+v, %v", info, err)
	}
	got, found := Discover(dataDir)
	if !found || got.Version != "legacy-only" {
		t.Fatalf("Discover must find legacy-only file: %+v, found=%v", got, found)
	}
	if _, err := os.Stat(primary); !os.IsNotExist(err) {
		t.Fatalf("legacy read must not create primary path, stat=%v", err)
	}

	if err := Write(dataDir, "http://127.0.0.1:53211/api", "fresh"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(primary); err != nil {
		t.Fatalf("Write must land on .toiv path: %v", err)
	}
	if raw, err := os.ReadFile(legacy); err != nil || !strings.Contains(string(raw), "legacy-only") {
		t.Fatalf("Write must leave legacy file untouched: %v", err)
	}
	path, err := Path(dataDir)
	if err != nil || path != primary {
		t.Fatalf("Path must return primary write path: %q, %v", path, err)
	}
	info, found = Discover(dataDir)
	if !found || info.Version != "fresh" {
		t.Fatalf("after Write, Discover must prefer primary: %+v", info)
	}

	if err := Remove(dataDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(primary); !os.IsNotExist(err) {
		t.Fatalf("Remove must clear primary: %v", err)
	}
	if _, err := os.Stat(legacy); err != nil {
		t.Fatalf("Remove of primary must not delete legacy sibling: %v", err)
	}

	// Only legacy remains with our PID → Remove clears legacy.
	if err := os.WriteFile(legacy, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Remove(dataDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("Remove must clear legacy when primary missing: %v", err)
	}
}

func TestWindowsCanonicalWorkspaceIdentity(t *testing.T) {
	dataDir, otherDir := t.TempDir(), t.TempDir()
	path := testPath(t, dataDir)
	for _, equivalent := range []string{strings.ToUpper(dataDir), filepath.Join(dataDir, "child", ".."), strings.ReplaceAll(dataDir, `\`, "/")} {
		got, err := Path(equivalent)
		if err != nil || got != path {
			t.Fatalf("Windows normalization differs for %q: %q, %v", equivalent, got, err)
		}
	}
	if path == testPath(t, otherDir) {
		t.Fatal("distinct workspaces share a descriptor")
	}
	if err := Write(dataDir, "http://127.0.0.1:53211/api", "first"); err != nil {
		t.Fatal(err)
	}
	if err := Write(otherDir, "http://127.0.0.1:53212/api", "second"); err != nil {
		t.Fatal(err)
	}
	info, found := Discover(otherDir)
	if !found || info.Version != "second" {
		t.Fatalf("workspace isolation failed: %+v", info)
	}
	wrong, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	otherPath := testPath(t, otherDir)
	if err := os.WriteFile(otherPath, wrong, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, found := Discover(otherDir); found {
		t.Fatal("descriptor from another workspace accepted")
	}
	if err := Remove(otherDir); err == nil {
		t.Fatal("wrong-workspace descriptor must not be removed even with own PID")
	}
	if _, err := os.Stat(otherPath); err != nil {
		t.Fatal("wrong-workspace descriptor was removed")
	}
}

func TestWindowsCanonicalPathFailsClosedWithoutAbsoluteHome(t *testing.T) {
	for _, home := range []string{"", "relative-home"} {
		t.Setenv("USERPROFILE", home)
		dataDir := t.TempDir()
		if path, err := Path(dataDir); err == nil || path != "" {
			t.Fatalf("invalid home %q produced path %q, %v", home, path, err)
		}
		if err := Write(dataDir, "http://127.0.0.1:53211/api", "fixture"); err == nil {
			t.Fatal("Write must fail with no canonical root")
		}
		if _, err := Load(dataDir); err == nil {
			t.Fatal("Load must fail with no canonical root")
		}
		if _, found := Discover(dataDir); found {
			t.Fatal("Discover must fail with no canonical root")
		}
		if err := Remove(dataDir); err == nil {
			t.Fatal("Remove must fail with no canonical root")
		}
	}
}

func mustAbs(t *testing.T, p string) string {
	t.Helper()
	abs, err := filepath.Abs(p)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}
