package database

import (
	"fmt"
	"os"
	"strings"

	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type Config struct {
	Driver  string
	DSN     string
	DataDir string
}

func Open(config Config) (*gorm.DB, error) {
	driver := strings.ToLower(strings.TrimSpace(config.Driver))
	if driver == "" {
		driver = "sqlite"
	}
	switch driver {
	case "sqlite":
		dsn := strings.TrimSpace(config.DSN)
		if dsn == "" {
			if err := os.MkdirAll(config.DataDir, 0o755); err != nil {
				return nil, err
			}
			dsn = config.DataDir + "/open_ai_canvas.db?_busy_timeout=5000&_journal_mode=WAL&_foreign_keys=on&_synchronous=NORMAL"
		}
		return gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	case "postgres", "postgresql":
		// M4(2026-10-07):canvas-api 单实例化——画布数据并入 ToIV PG 同库
		dsn := strings.TrimSpace(config.DSN)
		if dsn == "" {
			return nil, fmt.Errorf("postgres 驱动需要 DSN(CANVAS_DATABASE_URL)")
		}
		return gorm.Open(postgres.Open(dsn), &gorm.Config{})
	default:
		return nil, fmt.Errorf("不支持的数据库驱动：%s", driver)
	}
}

func ConfigurePool(db *gorm.DB) error {
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	if name := db.Dialector.Name(); name != "sqlite" {
		// M4:PG 连接池放开(PG 并发写安全;适度上限防打满 ToIV PG)
		sqlDB.SetMaxOpenConns(16)
		sqlDB.SetMaxIdleConns(8)
		return nil
	}
	// SQLite serializes writers. A single shared connection avoids intermittent
	// SQLITE_BUSY failures under concurrent autosave/task updates while WAL
	// still keeps reads cheap for this single-process desktop application.
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	return nil
}
