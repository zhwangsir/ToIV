package database

import (
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestV14AddsStudioProjectScopeToExistingAssistantTurns(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "studio-scope.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("ALTER TABLE assistant_turns DROP COLUMN referenced_studio_project_ids").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("DELETE FROM local_schema_migrations WHERE version >= 14").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateLocalSchema(db); err != nil {
		t.Fatalf("已有 v13 工作区必须升级到 v14: %v", err)
	}
	has, err := sqliteHasColumn(db, "assistant_turns", "referenced_studio_project_ids")
	if err != nil || !has {
		t.Fatalf("Studio scope 列缺失: has=%v err=%v", has, err)
	}
	var migration localSchemaMigration
	if err := db.First(&migration, "version = ?", 14).Error; err != nil {
		t.Fatal(err)
	}
	if migration.Name != "assistant-studio-project-scope" {
		t.Fatalf("迁移身份错误: %+v", migration)
	}
	if err := RequireLocalSchema(db); err != nil {
		t.Fatal(err)
	}
}
