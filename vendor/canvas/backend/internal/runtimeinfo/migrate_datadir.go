package runtimeinfo

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const migratedMarkerName = ".migrated-from-beeftv"

type migratedMarker struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Backup    string `json:"backup"`
	MigratedAt string `json:"migratedAt"`
}

// migrateBeefTVToToIV copies legacy → stamped backup, renames legacy → toiv, writes marker.
// Never deletes the backup. On any failure, leaves legacy in place for the caller to use.
func migrateBeefTVToToIV(root, legacy, toiv string) error {
	if _, err := os.Stat(toiv); err == nil {
		return fmt.Errorf("目标目录已存在: %s", toiv)
	} else if !os.IsNotExist(err) {
		return err
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	backup := filepath.Join(root, "BeefTV.pre-toiv-"+stamp)
	if err := copyDir(legacy, backup); err != nil {
		_ = os.RemoveAll(backup)
		return fmt.Errorf("备份遗留数据目录失败: %w", err)
	}
	if err := os.Rename(legacy, toiv); err != nil {
		// Cross-device or busy: leave legacy + backup; caller keeps using legacy.
		return fmt.Errorf("重命名到 ToIV 失败（备份保留在 %s）: %w", backup, err)
	}
	marker := migratedMarker{
		From:       legacy,
		To:         toiv,
		Backup:     backup,
		MigratedAt: time.Now().UTC().Format(time.RFC3339),
	}
	body, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return nil // data already at toiv; marker is best-effort
	}
	_ = os.WriteFile(filepath.Join(toiv, migratedMarkerName), append(body, '\n'), 0o600)
	return nil
}

func copyDir(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dst, info.Mode()); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		from := filepath.Join(src, entry.Name())
		to := filepath.Join(dst, entry.Name())
		if entry.IsDir() {
			if err := copyDir(from, to); err != nil {
				return err
			}
			continue
		}
		if err := copyFile(from, to); err != nil {
			return err
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}
