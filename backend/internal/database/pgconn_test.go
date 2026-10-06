package database

import (
	"os"
	"testing"
)

func TestPostgresOpenSmoke(t *testing.T) {
	if os.Getenv("CANVAS_PG_DSN") == "" {
		t.Skip("需要 CANVAS_PG_DSN")
	}
	db, err := Open(Config{Driver: "postgres", DSN: os.Getenv("CANVAS_PG_DSN")})
	if err != nil {
		t.Fatalf("postgres open: %v", err)
	}
	if name := db.Dialector.Name(); name != "postgres" {
		t.Fatalf("dialector=%s", name)
	}
	if err := ConfigurePool(db); err != nil {
		t.Fatalf("pool: %v", err)
	}
	sqlDB, _ := db.DB()
	if sqlDB.Stats().MaxOpenConnections != 16 {
		t.Fatalf("PG 池应为 16,实为 %d", sqlDB.Stats().MaxOpenConnections)
	}
	t.Log("postgres open+pool OK")
}
