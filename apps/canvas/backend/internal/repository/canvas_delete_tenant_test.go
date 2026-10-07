package repository

import (
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

// M7: canvas ids are global keys and canvas_unit_links is keyed by canvas_id alone, so a delete
// issued by another tenant must fail before touching any side table of the owner's canvas.
func TestDeleteCanvasProjectByForeignTenantHasNoSideEffects(t *testing.T) {
	repo, db := newTaskScopeRepo(t)
	canvas := seedScopeCanvas(t, db, model.CanvasProject{ID: "canvas-owned-by-a", UserID: "tenant-a", Title: "A"})
	link := model.CanvasUnitLink{ID: "link-a", ProjectID: "project-a", CanvasID: canvas.ID, UnitID: "unit-a", Role: "primary", CreatedAt: time.Now()}
	if err := db.Create(&link).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteCanvasProject("tenant-b", canvas.ID); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("foreign delete error = %v, want gorm.ErrRecordNotFound", err)
	}
	var links, canvases int64
	db.Model(&model.CanvasUnitLink{}).Where("canvas_id = ?", canvas.ID).Count(&links)
	db.Model(&model.CanvasProject{}).Where("id = ? AND user_id = ?", canvas.ID, "tenant-a").Count(&canvases)
	if links != 1 || canvases != 1 {
		t.Fatalf("foreign delete touched owner data: links=%d canvases=%d", links, canvases)
	}
	if err := repo.DeleteCanvasProject("tenant-a", canvas.ID); err != nil {
		t.Fatalf("owner delete: %v", err)
	}
	db.Model(&model.CanvasUnitLink{}).Where("canvas_id = ?", canvas.ID).Count(&links)
	if links != 0 {
		t.Fatalf("owner delete left %d unit links", links)
	}
}
