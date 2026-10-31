package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type projectReconcileHarness struct {
	router *gin.Engine
	svc    *app.Service
	db     *gorm.DB
	user   *model.User
}

func newProjectReconcileHarness(t *testing.T) projectReconcileHarness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "project-reconcile-routes.db")),
		&gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateLocalSchema(db); err != nil {
		t.Fatal(err)
	}
	svc := app.NewLocal(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	owner, err := svc.LocalWorkspaceOwner()
	if err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	RegisterProjectRoutes(router.Group("/api"), svc)
	return projectReconcileHarness{router: router, svc: svc, db: db, user: owner}
}

func (h projectReconcileHarness) do(t *testing.T, method string, path string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	recorder := httptest.NewRecorder()
	h.router.ServeHTTP(recorder, httptest.NewRequest(method, path, reader))
	return recorder
}

type reconcileEnvelope struct {
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
	Msg  string          `json:"msg"`
}

func decodeReconcileEnvelope(t *testing.T, recorder *httptest.ResponseRecorder) reconcileEnvelope {
	t.Helper()
	var envelope reconcileEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("response is not an envelope: %v body=%s", err, recorder.Body.String())
	}
	return envelope
}

func seedReconcileRouteProject(t *testing.T, h projectReconcileHarness, name string) model.Project {
	t.Helper()
	project, err := h.svc.CreateProject(h.user.ID, app.CreateProjectRequest{Name: name})
	if err != nil {
		t.Fatal(err)
	}
	return project
}

func TestProjectAssetReconciliationRouteReturnsLedger(t *testing.T) {
	h := newProjectReconcileHarness(t)
	project := seedReconcileRouteProject(t, h, "短剧")
	unit, err := h.svc.CreateProjectUnit(h.user.ID, project.ID, app.CreateProjectUnitRequest{Title: "第1集"})
	if err != nil {
		t.Fatal(err)
	}
	shot, err := h.svc.CreateProjectShot(h.user.ID, project.ID, app.CreateProjectShotRequest{
		UnitID: unit.ID, Title: "SC.01", Description: "人物抬头", DurationMs: 3000,
	})
	if err != nil {
		t.Fatal(err)
	}
	created, err := h.svc.CreateProjectAssetCandidates(h.user.ID, project.ID, app.CreateAssetCandidatesRequest{
		Candidates: []app.AssetCandidateInput{{UnitID: unit.ID, Name: "雨伞", Category: string(model.AssetCategoryProp), Details: map[string]any{"note": "道具"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 {
		t.Fatalf("seed candidates = %d, want 1", len(created))
	}

	recorder := h.do(t, http.MethodGet, "/api/projects/"+project.ID+"/asset-reconciliation", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	envelope := decodeReconcileEnvelope(t, recorder)
	if envelope.Code != 0 {
		t.Fatalf("envelope = %#v", envelope)
	}
	var ledger app.AssetReconciliation
	if err := json.Unmarshal(envelope.Data, &ledger); err != nil {
		t.Fatalf("data is not a reconciliation ledger: %v body=%s", err, envelope.Data)
	}
	if len(ledger.Units) != 1 || ledger.Units[0].UnitID != unit.ID || ledger.Units[0].UnitTitle != "第1集" {
		t.Fatalf("units = %#v", ledger.Units)
	}
	if ledger.Units[0].Entries == nil {
		t.Fatalf("entries must be an array, got nil: %#v", ledger.Units[0])
	}
	missingReference := false
	for _, drift := range ledger.Drifts {
		if drift.Kind == "shot_missing_reference" && drift.ShotID == shot.ID && drift.Reason != "" {
			missingReference = true
		}
	}
	if !missingReference {
		t.Fatalf("drifts = %#v, want explainable shot_missing_reference for %s", ledger.Drifts, shot.ID)
	}
	if len(ledger.CandidateIdentities) != 1 || ledger.CandidateIdentities[0].Suggestion.Action != "create" {
		t.Fatalf("candidate identities = %#v", ledger.CandidateIdentities)
	}
}

func envelopeDataIsNull(data json.RawMessage) bool {
	return len(data) == 0 || string(data) == "null"
}

func TestProjectAssetReconciliationRoutesRejectForeignProject(t *testing.T) {
	h := newProjectReconcileHarness(t)
	now := time.Now()
	foreign := model.Project{ID: "foreign-project", UserID: "someone-else", Name: "别人的项目", Status: model.ProjectStatusActive, Revision: 1, CreatedAt: now, UpdatedAt: now}
	if err := h.db.Create(&foreign).Error; err != nil {
		t.Fatal(err)
	}
	probes := []struct{ method, path, body string }{
		{http.MethodGet, "/api/projects/foreign-project/asset-reconciliation", ""},
		{http.MethodPost, "/api/projects/foreign-project/asset-reconciliation/apply", `{"decisions":[]}`},
		{http.MethodGet, "/api/projects/missing-project/asset-reconciliation", ""},
	}
	for _, probe := range probes {
		recorder := h.do(t, probe.method, probe.path, probe.body)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s %s: status = %d, want 404; body=%s", probe.method, probe.path, recorder.Code, recorder.Body.String())
		}
		envelope := decodeReconcileEnvelope(t, recorder)
		if envelope.Code != http.StatusNotFound || !envelopeDataIsNull(envelope.Data) {
			t.Fatalf("%s %s: envelope = %#v, want 404 with null data", probe.method, probe.path, envelope)
		}
	}
}

func TestAssetReconciliationApplyRouteConfirmsThenReplays(t *testing.T) {
	h := newProjectReconcileHarness(t)
	project := seedReconcileRouteProject(t, h, "短剧")
	unit, err := h.svc.CreateProjectUnit(h.user.ID, project.ID, app.CreateProjectUnitRequest{Title: "第1集"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := h.svc.CreateProjectAssetCandidates(h.user.ID, project.ID, app.CreateAssetCandidatesRequest{
		Candidates: []app.AssetCandidateInput{{UnitID: unit.ID, Name: "雨伞", Category: string(model.AssetCategoryProp), Details: map[string]any{"note": "道具"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"decisions":[{"candidateId":"` + created[0].ID + `","action":"create"}]}`
	path := "/api/projects/" + project.ID + "/asset-reconciliation/apply"

	recorder := h.do(t, http.MethodPost, path, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("apply status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	envelope := decodeReconcileEnvelope(t, recorder)
	if envelope.Code != 0 {
		t.Fatalf("apply envelope = %#v", envelope)
	}
	var result app.ReconcileApplyResult
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		t.Fatalf("apply data: %v body=%s", err, envelope.Data)
	}
	if result.Replayed || len(result.Results) != 1 || result.Results[0].Outcome != "applied" || result.Results[0].AssetID == "" {
		t.Fatalf("first apply = %#v", result)
	}

	replay := h.do(t, http.MethodPost, path, body)
	if replay.Code != http.StatusOK {
		t.Fatalf("replay status = %d body=%s", replay.Code, replay.Body.String())
	}
	replayEnvelope := decodeReconcileEnvelope(t, replay)
	var replayed app.ReconcileApplyResult
	if err := json.Unmarshal(replayEnvelope.Data, &replayed); err != nil {
		t.Fatalf("replay data: %v", err)
	}
	if !replayed.Replayed || len(replayed.Results) != 1 || replayed.Results[0] != result.Results[0] {
		t.Fatalf("replay = %#v, want replayed=%#v", replayed, result)
	}
	var assetCount int64
	if err := h.db.Model(&model.Asset{}).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 1 {
		t.Fatalf("assets = %d, want 1 (replay must not create)", assetCount)
	}
}

func TestAssetReconciliationApplyRouteRejectsInvalidRequests(t *testing.T) {
	h := newProjectReconcileHarness(t)
	project := seedReconcileRouteProject(t, h, "短剧")
	unit, err := h.svc.CreateProjectUnit(h.user.ID, project.ID, app.CreateProjectUnitRequest{Title: "第1集"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := h.svc.CreateProjectAssetCandidates(h.user.ID, project.ID, app.CreateAssetCandidatesRequest{
		Candidates: []app.AssetCandidateInput{{UnitID: unit.ID, Name: "雨伞", Category: string(model.AssetCategoryProp), Details: map[string]any{"note": "道具"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/projects/" + project.ID + "/asset-reconciliation/apply"
	probes := []struct{ name, body string }{
		{"malformed", `{"decisions":`},
		{"empty", `{"decisions":[]}`},
		{"duplicate", `{"decisions":[{"candidateId":"` + created[0].ID + `","action":"create"},{"candidateId":"` + created[0].ID + `","action":"create"}]}`},
		{"merge-without-asset", `{"decisions":[{"candidateId":"` + created[0].ID + `","action":"merge"}]}`},
		{"create-with-asset", `{"decisions":[{"candidateId":"` + created[0].ID + `","action":"create","assetId":"asset-1"}]}`},
		{"unknown-action", `{"decisions":[{"candidateId":"` + created[0].ID + `","action":"drop"}]}`},
		{"missing-candidate", `{"decisions":[{"candidateId":"missing","action":"create"}]}`},
	}
	for _, probe := range probes {
		recorder := h.do(t, http.MethodPost, path, probe.body)
		if recorder.Code != http.StatusBadRequest && recorder.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, want 400 or 404; body=%s", probe.name, recorder.Code, recorder.Body.String())
		}
		envelope := decodeReconcileEnvelope(t, recorder)
		if envelope.Code != recorder.Code || !envelopeDataIsNull(envelope.Data) {
			t.Fatalf("%s: envelope = %#v", probe.name, envelope)
		}
	}
	var candidate model.ProjectAssetCandidate
	if err := h.db.First(&candidate, "id = ?", created[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if candidate.Status != "pending_confirmation" {
		t.Fatalf("candidate status = %s after rejected applies, want pending_confirmation", candidate.Status)
	}
}
