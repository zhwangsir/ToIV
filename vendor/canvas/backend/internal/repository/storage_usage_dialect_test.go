package repository_test

import (
	"os"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 2026-10-08 生产事故:canvas-api PG 单实例模式下 POST /api/tasks 一律 500
// (local_storage_failed)——存储配额查询用了 SQLite 方言 CAST(... AS BLOB),
// Postgres 无 blob 类型(SQLSTATE 42704)。两种方言都必须能跑配额查询。

func seedUsage(t *testing.T, db *gorm.DB, userID string) {
	t.Helper()
	now := time.Now()
	if err := db.Create(&model.Task{ID: "task-usage-1", UserID: userID, Type: "canvas_video", Status: model.TaskStatusQueued, Prompt: "提示词", InputJSON: `{"a":1}`, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
}

func assertUsage(t *testing.T, r *repository.Repository, userID string) {
	t.Helper()
	usage, err := r.UserStorageUsage(userID)
	if err != nil {
		t.Fatalf("UserStorageUsage(%s): %v", r.Dialect(), err)
	}
	if usage.TaskCount != 1 {
		t.Fatalf("task count = %d, want 1", usage.TaskCount)
	}
	// "提示词" = 9 bytes in UTF-8, `{"a":1}` = 7 bytes: byte length, not rune count.
	if usage.TaskBytes != 16 {
		t.Fatalf("task bytes = %d, want 16 (UTF-8 bytes)", usage.TaskBytes)
	}
	if _, _, err := r.CreationStorageUsage(userID); err != nil {
		t.Fatalf("CreationStorageUsage(%s): %v", r.Dialect(), err)
	}
}

func TestStorageUsageSQLite(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	seedUsage(t, db, "user-usage")
	assertUsage(t, repository.New(db), "user-usage")
}

func TestStorageUsagePostgres(t *testing.T) {
	dsn := os.Getenv("CANVAS_PG_DSN")
	if dsn == "" {
		t.Skip("需要 CANVAS_PG_DSN")
	}
	db, err := database.Open(database.Config{Driver: "postgres", DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	db.Logger = logger.Discard
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	userID := "user-usage-" + strings.ReplaceAll(time.Now().Format("150405.000000"), ".", "")
	seedUsage(t, db.Session(&gorm.Session{}), userID)
	t.Cleanup(func() { db.Exec("DELETE FROM tasks WHERE user_id = ?", userID) })
	assertUsage(t, repository.New(db), userID)
}

// 同一事故第二处:任务准入走 withImmediateTransaction,原实现发 "BEGIN IMMEDIATE"
// (SQLite 专有),Postgres 报 syntax error(SQLSTATE 42601)。PG 下必须能建任务。
func TestCreateTaskWithActiveLimitPostgres(t *testing.T) {
	dsn := os.Getenv("CANVAS_PG_DSN")
	if dsn == "" {
		t.Skip("需要 CANVAS_PG_DSN")
	}
	db, err := database.Open(database.Config{Driver: "postgres", DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	db.Logger = logger.Discard
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	userID := "user-admit-" + strings.ReplaceAll(time.Now().Format("150405.000000"), ".", "")
	t.Cleanup(func() { db.Exec("DELETE FROM tasks WHERE user_id = ?", userID) })
	r := repository.New(db)
	now := time.Now()
	task := &model.Task{ID: userID + "-t1", UserID: userID, Type: "canvas_video", Status: model.TaskStatusQueued, Prompt: "p", InputJSON: "{}", CreatedAt: now, UpdatedAt: now}
	if err := r.CreateTaskWithActiveLimit(task, 5); err != nil {
		t.Fatalf("CreateTaskWithActiveLimit(postgres): %v", err)
	}
	var count int64
	db.Model(&model.Task{}).Where("user_id = ?", userID).Count(&count)
	if count != 1 {
		t.Fatalf("task rows = %d, want 1", count)
	}
}
