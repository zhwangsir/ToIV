package runtimeinfo

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
)

// windowsRuntimeDescriptorPaths returns the canonical (write) path under
// ~/.toiv/runtime, the legacy read-only fallback under ~/.beeftv/runtime, and
// the dataDir hash embedded in both filenames. Pure: no OS calls; testable on
// any GOOS. The unique location stays outside AppData (no shadow fallback).
func windowsRuntimeDescriptorPaths(home, absDataDir string) (primary, legacy, dataDirHash string) {
	digest := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(absDataDir))))
	dataDirHash = hex.EncodeToString(digest[:])
	name := dataDirHash + ".json"
	primary = filepath.Join(home, ".toiv", "runtime", name)
	legacy = filepath.Join(home, ".beeftv", "runtime", name)
	return primary, legacy, dataDirHash
}
