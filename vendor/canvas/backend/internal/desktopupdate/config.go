package desktopupdate

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"

	"infinite-canvas/backend/internal/outbound"
)

// Link-time variables. Release builds inject an HTTPS feed and a base64 raw
// 32-byte Ed25519 public key. Both empty disables the updater.
var (
	FeedURL   = ""
	PublicKey = ""
)

const (
	helperFlag = "--beeftv-update-helper"
	// Primary install names (P2 cutover). New builds produce ToIV.app / ToIV.exe.
	appBundleName    = "ToIV.app"
	windowsExeName   = "ToIV.exe"
	darwinBinaryName = "ToIV"
	// Legacy installs the updater must still locate and upgrade.
	legacyAppBundleName    = "BeefTV.app"
	legacyWindowsExeName   = "BeefTV.exe"
	legacyDarwinBinaryName = "BeefTV"
	installLockName        = ".ToIV.update.lock"
	legacyInstallLockName  = ".BeefTV.update.lock"
	helperBaseName         = "ToIV-update-helper"
	legacyHelperBaseName   = "BeefTV-update-helper"
	pluginDirName          = "plugin-packages"
	// 随包 CLI：外部 Agent 的接入入口，升级包里必须带上，否则升级一次就断了接入。
	// 它必须待在自己的 cli 目录里：macOS 与 Windows 的文件名都不分大小写，
	// beeftv 直接放在主程序旁边会和 ToIV / ToIV.exe 撞成同一个文件。
	cliDirName      = "cli"
	darwinCLIName   = "beeftv"
	windowsCLIName  = "beeftv.exe"
	pluginExtension = ".beeftv-plugin"
	payloadSchema   = 1
	maxFeedBytes    = 1 << 20
	maxRedirects    = 8
	maxZipFiles     = 50000
	maxZipEntry     = 1 << 30
	maxZipTotal     = 2 << 30
)

func ParsePublicKey(value string) (ed25519.PublicKey, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, ErrIncompleteConfig
	}
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, ErrIncompleteConfig
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, ErrIncompleteConfig
	}
	return ed25519.PublicKey(raw), nil
}

func CurrentPlatform() (string, error) {
	switch runtime.GOOS + "-" + runtime.GOARCH {
	case "darwin-arm64":
		return "darwin-arm64", nil
	case "darwin-amd64":
		return "darwin-amd64", nil
	case "windows-amd64":
		return "windows-amd64", nil
	default:
		return "", ErrUnsupported
	}
}

func normalizeFeedURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ErrIncompleteConfig
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return "", ErrIncompleteConfig
	}
	// Positive host allowlist (same family as toiv_gate): defaults cover
	// toiv.wineryz.top, updates.beefapi.com, and loopback; extra hosts via
	// CANVAS_OUTBOUND_HOST_ALLOWLIST.
	if _, err := outbound.ValidateAllowlistedOutboundURL(parsed.String()); err != nil {
		return "", err
	}
	return parsed.String(), nil
}

func configFromVars() (feed string, key ed25519.PublicKey, enabled bool, reason string) {
	feedRaw := strings.TrimSpace(FeedURL)
	keyRaw := strings.TrimSpace(PublicKey)
	if feedRaw == "" && keyRaw == "" {
		return "", nil, false, ""
	}
	if feedRaw == "" || keyRaw == "" {
		return "", nil, false, ErrIncompleteConfig.Error()
	}
	feed, err := normalizeFeedURL(feedRaw)
	if err != nil {
		return "", nil, false, "更新地址无效。"
	}
	key, err = ParsePublicKey(keyRaw)
	if err != nil {
		return "", nil, false, "更新配置无效。"
	}
	return feed, key, true, ""
}

func isKnownAppBundle(name string) bool {
	return name == appBundleName || name == legacyAppBundleName
}

func isKnownWindowsExe(name string) bool {
	return strings.EqualFold(name, windowsExeName) || strings.EqualFold(name, legacyWindowsExeName)
}

func darwinBinaryForBundle(bundleBase string) string {
	if bundleBase == legacyAppBundleName {
		return legacyDarwinBinaryName
	}
	return darwinBinaryName
}

func updateLockPath(targetPath string) string {
	parent := filepath.Dir(targetPath)
	base := filepath.Base(targetPath)
	if base == legacyAppBundleName || strings.EqualFold(base, legacyWindowsExeName) {
		return filepath.Join(parent, legacyInstallLockName)
	}
	return filepath.Join(parent, installLockName)
}

func helperFileName() string {
	if runtime.GOOS == "windows" {
		return helperBaseName + ".exe"
	}
	return helperBaseName
}

func helperCleanupNames() []string {
	return []string{
		helperBaseName,
		helperBaseName + ".exe",
		legacyHelperBaseName,
		legacyHelperBaseName + ".exe",
		"backup", "payload", "helper.log", "prepared", "result.json", "request.json",
	}
}

// sameInstallTarget reports whether a persisted helper TargetPath matches the
// currently running install, including BeefTV.* → ToIV.* migration.
func sameInstallTarget(recorded, current string) bool {
	if recorded == current {
		return true
	}
	if filepath.Dir(recorded) != filepath.Dir(current) {
		return false
	}
	rb, cb := filepath.Base(recorded), filepath.Base(current)
	if rb == legacyAppBundleName && cb == appBundleName {
		return true
	}
	if strings.EqualFold(rb, legacyWindowsExeName) && strings.EqualFold(cb, windowsExeName) {
		return true
	}
	return false
}
