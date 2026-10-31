package repository_test

import (
	"os"
	"sort"
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

// 2026-10-08:素材库筛选(收藏/生成/按项目)与项目按节点数排序在 Postgres 下
// 用了 SQLite 专有 JSON 函数。两种方言必须给出相同结果。

func seedJSONFilterData(t *testing.T, db *gorm.DB, userID string) {
	t.Helper()
	now := time.Now().UTC()
	p := userID + "-"
	assets := []model.Asset{
		{ID: p + "fav-bool", Kind: "image", PayloadJSON: `{"metadata":{"favorite":true,"projectName":"  雨夜  "}}`},
		{ID: p + "fav-str", Kind: "image", PayloadJSON: `{"metadata":{"favorite":"true","projectIds":["p1"]}}`},
		{ID: p + "fav-num", Kind: "video", PayloadJSON: `{"metadata":{"favorite":1},"source":"生成任务"}`},
		{ID: p + "not-fav", Kind: "image", PayloadJSON: `{"metadata":{"favorite":false,"generationEffectKey":"k1","projectIds":[]}}`},
		{ID: p + "gen-num-key", Kind: "audio", PayloadJSON: `{"metadata":{"generationEffectKey":5}}`},
		{ID: p + "text-gen", Kind: "text", PayloadJSON: `{"source":"生成任务"}`},
		{ID: p + "empty", Kind: "image", PayloadJSON: ``},
		{ID: p + "broken", Kind: "image", PayloadJSON: `{not json`},
	}
	for i := range assets {
		a := assets[i]
		a.UserID, a.Category, a.Status, a.Title = userID, model.AssetCategoryMaterial, model.AssetVersionStatusConfirmed, a.ID
		a.CreatedAt, a.UpdatedAt = now, now.Add(time.Duration(i)*time.Second)
		if err := db.Create(&a).Error; err != nil {
			t.Fatal(err)
		}
	}
	for i, payload := range []string{`{"nodes":[1,2,3]}`, `{"nodes":[]}`, `{"nodes":[1,2,3,4,5]}`, `{"title":"no nodes"}`, `{"nodes":{"x":1}}`} {
		c := model.CanvasProject{ID: p + "canvas-" + string(rune('a'+i)), UserID: userID, Title: "c", PayloadJSON: payload, Revision: 1, CreatedAt: now, UpdatedAt: now}
		if err := db.Create(&c).Error; err != nil {
			t.Fatal(err)
		}
	}
}

func assetIDs(prefix string, assets []model.Asset) []string {
	out := make([]string, 0, len(assets))
	for _, a := range assets {
		out = append(out, strings.TrimPrefix(a.ID, prefix))
	}
	sort.Strings(out)
	return out
}

func assertJSONFilters(t *testing.T, r *repository.Repository, userID string) {
	t.Helper()
	p := userID + "-"
	d := r.Dialect()
	fav, _, err := r.UserAssetsPage(userID, 1, 50, repository.UserAssetPageFilter{Status: "active", Favorite: true})
	if err != nil {
		t.Fatalf("%s favorite filter: %v", d, err)
	}
	if got := strings.Join(assetIDs(p, fav), ","); got != "fav-bool,fav-num,fav-str" {
		t.Fatalf("%s favorite = %s", d, got)
	}
	gen, _, err := r.UserAssetsPage(userID, 1, 50, repository.UserAssetPageFilter{Status: "active", Generated: true})
	if err != nil {
		t.Fatalf("%s generated filter: %v", d, err)
	}
	if got := strings.Join(assetIDs(p, gen), ","); got != "fav-num,not-fav" {
		t.Fatalf("%s generated = %s", d, got)
	}
	named, _, err := r.UserAssetsPage(userID, 1, 50, repository.UserAssetPageFilter{Status: "active", Project: "雨夜"})
	if err != nil {
		t.Fatalf("%s project filter: %v", d, err)
	}
	if got := strings.Join(assetIDs(p, named), ","); got != "fav-bool" {
		t.Fatalf("%s project 雨夜 = %s", d, got)
	}
	rows, err := r.UserAssetProjectCounts(userID)
	if err != nil {
		t.Fatalf("%s project counts: %v", d, err)
	}
	counts := map[string]int64{}
	for _, row := range rows {
		counts[row.Key] = row.Count
	}
	if counts["雨夜"] != 1 || len(counts) != 3 {
		t.Fatalf("%s project counts = %v", d, counts)
	}
	favorite, _, err := r.UserAssetQuickFilterCounts(userID)
	if err != nil || favorite != 3 {
		t.Fatalf("%s quick favorite = %d, %v", d, favorite, err)
	}
	total, _, err := r.UserAssetGeneratedCounts(userID)
	if err != nil || total != 2 {
		t.Fatalf("%s generated count = %d, %v", d, total, err)
	}
	if _, _, _, err := r.UserAssetFacets(userID, "active"); err != nil {
		t.Fatalf("%s facets: %v", d, err)
	}
	projects, _, err := r.UserCanvasProjectsPage(userID, 1, 50, "", "", "nodes")
	if err != nil {
		t.Fatalf("%s sort by nodes: %v", d, err)
	}
	order := make([]string, 0, len(projects))
	for _, c := range projects {
		order = append(order, strings.TrimPrefix(c.ID, p+"canvas-"))
	}
	// c(5) > a(3) > 其余 0 按 id asc:b, d, e(对象不是数组)
	if got := strings.Join(order, ","); got != "c,a,b,d,e" {
		t.Fatalf("%s nodes order = %s", d, got)
	}
}

func TestJSONFiltersSQLite(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	seedJSONFilterData(t, db, "user-json")
	assertJSONFilters(t, repository.New(db), "user-json")
}

func TestJSONFiltersPostgres(t *testing.T) {
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
	userID := "user-json-" + strings.ReplaceAll(time.Now().Format("150405.000000"), ".", "")
	t.Cleanup(func() {
		db.Exec("DELETE FROM assets WHERE user_id = ?", userID)
		db.Exec("DELETE FROM canvas_projects WHERE user_id = ?", userID)
	})
	seedJSONFilterData(t, db, userID)
	assertJSONFilters(t, repository.New(db), userID)
}
