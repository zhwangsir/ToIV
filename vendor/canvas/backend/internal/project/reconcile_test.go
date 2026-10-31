package project

import (
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func seedReconcileAsset(t *testing.T, db *gorm.DB, projectID string, asset model.Asset, versions ...model.AssetVersion) model.Asset {
	t.Helper()
	now := time.Now()
	if asset.ID == "" || asset.UserID == "" || asset.Title == "" {
		t.Fatalf("asset fixture incomplete: %#v", asset)
	}
	if asset.Status == "" {
		asset.Status = model.AssetVersionStatusConfirmed
	}
	if asset.CreatedAt.IsZero() {
		asset.CreatedAt = now
	}
	asset.UpdatedAt = now
	if asset.PrimaryVersionID == "" && len(versions) > 0 {
		asset.PrimaryVersionID = versions[len(versions)-1].ID
	}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	for _, version := range versions {
		if version.AssetID == "" {
			version.AssetID = asset.ID
		}
		if version.CreatedAt.IsZero() {
			version.CreatedAt = now
		}
		version.UpdatedAt = now
		if err := db.Create(&version).Error; err != nil {
			t.Fatal(err)
		}
	}
	link := model.ProjectAssetLink{ID: kernel.NewID(), ProjectID: projectID, AssetID: asset.ID, CreatedAt: now}
	if err := db.Create(&link).Error; err != nil {
		t.Fatal(err)
	}
	return asset
}

func seedReconcileShot(t *testing.T, svc *Service, projectID string, unitID string, title string, versionIDs ...string) model.Shot {
	t.Helper()
	shot, err := svc.CreateProjectShot("user-1", projectID, CreateProjectShotRequest{
		UnitID: unitID, Title: title, Description: "画面描述", DurationMs: 3000,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, versionID := range versionIDs {
		if _, err := svc.LinkShotAsset("user-1", projectID, shot.ID, LinkShotAssetRequest{AssetVersionID: versionID, Role: "reference"}); err != nil {
			t.Fatal(err)
		}
	}
	return shot
}

func findUnitInventory(t *testing.T, reconciliation AssetReconciliation, unitID string) UnitAssetInventory {
	t.Helper()
	for _, unit := range reconciliation.Units {
		if unit.UnitID == unitID {
			return unit
		}
	}
	t.Fatalf("unit %s missing from inventory %#v", unitID, reconciliation.Units)
	return UnitAssetInventory{}
}

func findInventoryEntry(t *testing.T, inventory UnitAssetInventory, assetID string) UnitAssetEntry {
	t.Helper()
	for _, entry := range inventory.Entries {
		if entry.AssetID == assetID {
			return entry
		}
	}
	t.Fatalf("asset %s missing from unit %s inventory %#v", assetID, inventory.UnitID, inventory.Entries)
	return UnitAssetEntry{}
}

func findDrifts(reconciliation AssetReconciliation, kind string) []AssetDrift {
	found := make([]AssetDrift, 0)
	for _, drift := range reconciliation.Drifts {
		if drift.Kind == kind {
			found = append(found, drift)
		}
	}
	return found
}

func TestAssetReconciliationInventoryListsPerUnitVersions(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit1 := seedChapter(t, svc, project.ID)
	unit2 := seedChapter(t, svc, project.ID)
	character, err := svc.CreateProjectCharacter("user-1", project.ID, CreateProjectCharacterRequest{Name: "小红帽", Definition: map[string]any{"role": "主角"}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	environment := seedReconcileAsset(t, db, project.ID, model.Asset{ID: "env-forest", UserID: "user-1", Kind: "image", Category: model.AssetCategoryEnvironment, Title: "森林", PrimaryVersionID: "env-forest-v1"},
		model.AssetVersion{ID: "env-forest-v1", Version: 1})
	prop := seedReconcileAsset(t, db, project.ID, model.Asset{ID: "prop-basket", UserID: "user-1", Kind: "image", Category: model.AssetCategoryProp, Title: "篮子", PrimaryVersionID: "prop-basket-v1"},
		model.AssetVersion{ID: "prop-basket-v1", Version: 1})
	_ = now
	shotA := seedReconcileShot(t, svc, project.ID, unit1.ID, "SC.01", character.Asset.PrimaryVersionID, "env-forest-v1")
	seedReconcileShot(t, svc, project.ID, unit1.ID, "SC.02", "prop-basket-v1")
	shotC := seedReconcileShot(t, svc, project.ID, unit2.ID, "SC.03", character.Asset.PrimaryVersionID)

	reconciliation, err := svc.ProjectAssetReconciliation("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(reconciliation.Units) != 2 {
		t.Fatalf("units = %d, want 2", len(reconciliation.Units))
	}
	first := findUnitInventory(t, reconciliation, unit1.ID)
	if first.UnitTitle == "" || first.Kind != string(model.ProjectUnitKindChapter) {
		t.Fatalf("unit inventory header = %#v", first)
	}
	if len(first.Entries) != 3 {
		t.Fatalf("unit1 entries = %#v, want 3", first.Entries)
	}
	charEntry := findInventoryEntry(t, first, character.Asset.ID)
	if charEntry.Category != model.AssetCategoryCharacter || charEntry.PrimaryVersionID != character.Asset.PrimaryVersionID {
		t.Fatalf("character entry = %#v", charEntry)
	}
	if len(charEntry.Versions) != 1 || charEntry.Versions[0].VersionID != character.Asset.PrimaryVersionID || !charEntry.Versions[0].IsPrimary {
		t.Fatalf("character versions = %#v", charEntry.Versions)
	}
	if len(charEntry.Versions[0].ShotIDs) != 1 || charEntry.Versions[0].ShotIDs[0] != shotA.ID {
		t.Fatalf("character version shots = %#v", charEntry.Versions[0].ShotIDs)
	}
	envEntry := findInventoryEntry(t, first, environment.ID)
	if envEntry.Category != model.AssetCategoryEnvironment || envEntry.Versions[0].VersionID != "env-forest-v1" {
		t.Fatalf("environment entry = %#v", envEntry)
	}
	propEntry := findInventoryEntry(t, first, prop.ID)
	if propEntry.Category != model.AssetCategoryProp {
		t.Fatalf("prop entry = %#v", propEntry)
	}
	second := findUnitInventory(t, reconciliation, unit2.ID)
	if len(second.Entries) != 1 {
		t.Fatalf("unit2 entries = %#v, want 1", second.Entries)
	}
	otherChar := findInventoryEntry(t, second, character.Asset.ID)
	if len(otherChar.Versions) != 1 || otherChar.Versions[0].ShotIDs[0] != shotC.ID {
		t.Fatalf("unit2 character entry = %#v", otherChar)
	}
}

func TestAssetReconciliationDriftsAreExplainable(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit1 := seedChapter(t, svc, project.ID)
	unit2 := seedChapter(t, svc, project.ID)
	character, err := svc.CreateProjectCharacter("user-1", project.ID, CreateProjectCharacterRequest{Name: "小红帽", Definition: map[string]any{"role": "主角"}})
	if err != nil {
		t.Fatal(err)
	}
	shotA := seedReconcileShot(t, svc, project.ID, unit1.ID, "SC.01", character.Asset.PrimaryVersionID)
	seedReconcileShot(t, svc, project.ID, unit1.ID, "SC.02")
	if _, err := svc.UpdateProjectCharacter("user-1", project.ID, character.Asset.ID, UpdateProjectCharacterRequest{Name: "小红帽", Definition: map[string]any{"role": "主角", "appearance": "红色斗篷"}}); err != nil {
		t.Fatal(err)
	}
	environment := seedReconcileAsset(t, db, project.ID, model.Asset{ID: "env-forest", UserID: "user-1", Kind: "image", Category: model.AssetCategoryEnvironment, Title: "森林", PrimaryVersionID: "env-forest-v2"},
		model.AssetVersion{ID: "env-forest-v1", Version: 1},
		model.AssetVersion{ID: "env-forest-v2", Version: 2})
	seedReconcileShot(t, svc, project.ID, unit2.ID, "SC.03", "env-forest-v1")
	seedReconcileShot(t, svc, project.ID, unit2.ID, "SC.04", "env-forest-v2")
	now := time.Now()
	staleArtifact := model.ShotArtifact{ID: "artifact-stale", ProjectID: project.ID, UnitID: unit1.ID, ShotID: shotA.ID, Type: "video", Version: 1, Status: "stale", CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&staleArtifact).Error; err != nil {
		t.Fatal(err)
	}

	reconciliation, err := svc.ProjectAssetReconciliation("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	behind := findDrifts(reconciliation, AssetDriftVersionBehindPrimary)
	characterBehind := make([]AssetDrift, 0, 1)
	for _, drift := range behind {
		if drift.ShotID == shotA.ID && drift.AssetID == character.Asset.ID {
			characterBehind = append(characterBehind, drift)
		}
	}
	if len(characterBehind) != 1 {
		t.Fatalf("behind-primary drifts = %#v", behind)
	}
	if characterBehind[0].UnitID != unit1.ID {
		t.Fatalf("behind-primary drift = %#v", characterBehind[0])
	}
	if len(characterBehind[0].VersionIDs) != 1 || strings.TrimSpace(characterBehind[0].Reason) == "" {
		t.Fatalf("behind-primary drift detail = %#v", characterBehind[0])
	}
	missing := findDrifts(reconciliation, AssetDriftShotMissingReference)
	if len(missing) != 1 || missing[0].UnitID != unit1.ID || strings.TrimSpace(missing[0].Reason) == "" {
		t.Fatalf("missing-reference drifts = %#v", missing)
	}
	multi := findDrifts(reconciliation, AssetDriftAssetMultiVersion)
	if len(multi) != 1 || multi[0].AssetID != environment.ID {
		t.Fatalf("multi-version drifts = %#v", multi)
	}
	if len(multi[0].VersionIDs) != 2 || strings.TrimSpace(multi[0].Reason) == "" {
		t.Fatalf("multi-version drift detail = %#v", multi[0])
	}
	stale := findDrifts(reconciliation, AssetDriftStaleArtifact)
	if len(stale) != 1 || stale[0].ShotID != shotA.ID || stale[0].ArtifactID != "artifact-stale" || strings.TrimSpace(stale[0].Reason) == "" {
		t.Fatalf("stale-artifact drifts = %#v", stale)
	}
	missingRepresentation := findDrifts(reconciliation, AssetDriftCharacterMissingRepresentation)
	if len(missingRepresentation) == 0 {
		t.Fatalf("character missing representation drifts = %#v", reconciliation.Drifts)
	}
	for _, drift := range reconciliation.Drifts {
		if strings.TrimSpace(drift.Reason) == "" {
			t.Fatalf("drift without explainable reason = %#v", drift)
		}
	}
}

func TestAssetReconciliationSuggestsMergeAndCreate(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit1 := seedChapter(t, svc, project.ID)
	unit2 := seedChapter(t, svc, project.ID)
	details := validChapterCharacterDetails()
	created, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Source: AssetCandidateSourceChapterCharacter,
		Candidates: []AssetCandidateInput{
			{UnitID: unit1.ID, Name: "小红帽", Category: string(model.AssetCategoryCharacter), Details: details},
			{UnitID: unit2.ID, Name: "小红帽", Category: string(model.AssetCategoryCharacter), Details: details},
			{UnitID: unit2.ID, Name: "黑伞", Category: string(model.AssetCategoryProp), Details: map[string]any{"note": "道具"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 3 {
		t.Fatalf("created = %d, want 3", len(created))
	}
	if _, err := svc.ConfirmProjectAssetCandidate("user-1", project.ID, created[0].ID, ConfirmProjectAssetCandidateRequest{}); err != nil {
		t.Fatal(err)
	}

	reconciliation, err := svc.ProjectAssetReconciliation("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	var characterGroup, propGroup *CandidateIdentityGroup
	for index := range reconciliation.CandidateIdentities {
		group := &reconciliation.CandidateIdentities[index]
		switch group.Category {
		case model.AssetCategoryCharacter:
			characterGroup = group
		case model.AssetCategoryProp:
			propGroup = group
		}
	}
	if characterGroup == nil || propGroup == nil {
		t.Fatalf("candidate identities = %#v", reconciliation.CandidateIdentities)
	}
	if len(characterGroup.Appearances) != 2 {
		t.Fatalf("character appearances = %#v", characterGroup.Appearances)
	}
	if characterGroup.Suggestion.Action != ReconcileActionMerge || characterGroup.Suggestion.AssetID == "" || strings.TrimSpace(characterGroup.Suggestion.Reason) == "" {
		t.Fatalf("character suggestion = %#v", characterGroup.Suggestion)
	}
	if characterGroup.Suggestion.Match != CandidateSuggestionMatchResolved {
		t.Fatalf("character suggestion match = %q, want %q", characterGroup.Suggestion.Match, CandidateSuggestionMatchResolved)
	}
	if propGroup.Suggestion.Action != ReconcileActionCreate || propGroup.Suggestion.Match != CandidateSuggestionMatchNone {
		t.Fatalf("prop suggestion = %#v", propGroup.Suggestion)
	}

	if _, err := svc.CreateProjectCharacter("user-1", project.ID, CreateProjectCharacterRequest{Name: "黑伞", Definition: map[string]any{"role": "道具"}}); err != nil {
		t.Fatal(err)
	}
	seedReconcileAsset(t, db, project.ID, model.Asset{ID: "prop-umbrella", UserID: "user-1", Kind: "image", Category: model.AssetCategoryProp, Title: "黑伞", PrimaryVersionID: "prop-umbrella-v1"},
		model.AssetVersion{ID: "prop-umbrella-v1", Version: 1})
	reconciliation, err = svc.ProjectAssetReconciliation("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	for index := range reconciliation.CandidateIdentities {
		group := &reconciliation.CandidateIdentities[index]
		if group.Category != model.AssetCategoryProp {
			continue
		}
		if group.Suggestion.Action != ReconcileActionMerge || group.Suggestion.Match != CandidateSuggestionMatchAssetName {
			t.Fatalf("prop suggestion after matching asset = %#v", group.Suggestion)
		}
	}
}

func TestReconcileApplyCreateIsIdempotent(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	created, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Candidates: []AssetCandidateInput{
			{UnitID: unit.ID, Name: "雨伞", Category: string(model.AssetCategoryProp), Details: map[string]any{"note": "道具"}},
			{UnitID: unit.ID, Name: "黑猫", Category: string(model.AssetCategoryProp), Details: map[string]any{"note": "道具"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 2 {
		t.Fatalf("created = %d, want 2", len(created))
	}
	request := ReconcileApplyRequest{Decisions: []ReconcileDecision{{CandidateID: created[0].ID, Action: ReconcileActionCreate}}}
	result, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Replayed || len(result.Results) != 1 || result.Results[0].Outcome != ReconcileOutcomeApplied || result.Results[0].AssetID == "" {
		t.Fatalf("first apply = %#v", result)
	}
	replayed, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	if !replayed.Replayed || len(replayed.Results) != 1 || replayed.Results[0] != result.Results[0] {
		t.Fatalf("replayed apply = %#v, want %#v", replayed, result)
	}
	var assetCount, versionCount int64
	if err := db.Model(&model.Asset{}).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.AssetVersion{}).Count(&versionCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 1 || versionCount != 1 {
		t.Fatalf("assets=%d versions=%d after replay, want 1/1", assetCount, versionCount)
	}

	second, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, ReconcileApplyRequest{Decisions: []ReconcileDecision{
		{CandidateID: created[0].ID, Action: ReconcileActionCreate},
		{CandidateID: created[1].ID, Action: ReconcileActionCreate},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if second.Replayed {
		t.Fatalf("second decision set was wrongly replayed: %#v", second)
	}
	if len(second.Results) != 2 {
		t.Fatalf("second results = %#v", second.Results)
	}
	outcomes := map[string]string{}
	for _, item := range second.Results {
		outcomes[item.CandidateID] = item.Outcome
	}
	if outcomes[created[0].ID] != ReconcileOutcomeAlreadyConfirmed || outcomes[created[1].ID] != ReconcileOutcomeApplied {
		t.Fatalf("second outcomes = %#v", outcomes)
	}
	if err := db.Model(&model.Asset{}).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 2 {
		t.Fatalf("assets = %d, want 2", assetCount)
	}
}

func TestReconcileApplyMergeKeepsManualEditsAndReplayIsNoop(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	created, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Source: AssetCandidateSourceChapterCharacter,
		Candidates: []AssetCandidateInput{{
			UnitID: unit.ID, Name: "小红帽", Category: string(model.AssetCategoryCharacter),
			Details: map[string]any{
				"role": "主角", "aliases": []any{"小红"}, "appearance": "红色斗篷", "clothing": "红色兜帽",
				"physique": "儿童", "personality": "AI 提取的勇敢", "voiceLanguage": "普通话", "voiceAge": "儿童", "voiceTimbre": "清亮",
			},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	character, err := svc.CreateProjectCharacter("user-1", project.ID, CreateProjectCharacterRequest{Name: "小红帽", Definition: map[string]any{"personality": "人工设定的温柔", "role": "主角"}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, ReconcileApplyRequest{Decisions: []ReconcileDecision{
		{CandidateID: created[0].ID, Action: ReconcileActionMerge, AssetID: character.Asset.ID},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Results[0].Outcome != ReconcileOutcomeApplied {
		t.Fatalf("merge result = %#v", result.Results[0])
	}
	detail, err := svc.ProjectCharacter("user-1", project.ID, character.Asset.ID)
	if err != nil {
		t.Fatal(err)
	}
	definition := detail.Character.Definition
	if definition["personality"] != "人工设定的温柔" {
		t.Fatalf("manual personality overwritten: %#v", definition)
	}
	if definition["appearance"] != "红色斗篷" {
		t.Fatalf("empty field not filled from candidate: %#v", definition)
	}
	aliases, _ := definition["aliases"].([]any)
	foundAlias := false
	for _, alias := range aliases {
		if alias == "小红" {
			foundAlias = true
		}
	}
	if !foundAlias {
		t.Fatalf("aliases = %#v, want candidate alias merged", definition["aliases"])
	}
	if detail.Character.Version < 2 {
		t.Fatalf("character version = %d, want merge to add a version", detail.Character.Version)
	}

	human, err := svc.UpdateProjectCharacter("user-1", project.ID, character.Asset.ID, UpdateProjectCharacterRequest{Name: "小红帽", Definition: map[string]any{"personality": "人工设定的温柔", "role": "主角", "appearance": "人工重画的斗篷"}})
	if err != nil {
		t.Fatal(err)
	}
	humanPrimary := human.Asset.PrimaryVersionID
	var versionCount int64
	if err := db.Model(&model.AssetVersion{}).Where("asset_id = ?", character.Asset.ID).Count(&versionCount).Error; err != nil {
		t.Fatal(err)
	}
	replayed, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, ReconcileApplyRequest{Decisions: []ReconcileDecision{
		{CandidateID: created[0].ID, Action: ReconcileActionMerge, AssetID: character.Asset.ID},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !replayed.Replayed {
		t.Fatalf("merge replay = %#v", replayed)
	}
	after, err := svc.ProjectCharacter("user-1", project.ID, character.Asset.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Asset.PrimaryVersionID != humanPrimary {
		t.Fatalf("replay overwrote later manual primary: %s -> %s", humanPrimary, after.Asset.PrimaryVersionID)
	}
	if after.Character.Definition["appearance"] != "人工重画的斗篷" {
		t.Fatalf("replay overwrote later manual edit: %#v", after.Character.Definition)
	}
	var replayVersionCount int64
	if err := db.Model(&model.AssetVersion{}).Where("asset_id = ?", character.Asset.ID).Count(&replayVersionCount).Error; err != nil {
		t.Fatal(err)
	}
	if replayVersionCount != versionCount {
		t.Fatalf("replay created versions: %d -> %d", versionCount, replayVersionCount)
	}
}

func TestReconcileApplyAutoLinksSameIdentityAppearances(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit1 := seedChapter(t, svc, project.ID)
	unit2 := seedChapter(t, svc, project.ID)
	details := validChapterCharacterDetails()
	created, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Source: AssetCandidateSourceChapterCharacter,
		Candidates: []AssetCandidateInput{
			{UnitID: unit1.ID, Name: "小红帽", Category: string(model.AssetCategoryCharacter), Details: details},
			{UnitID: unit2.ID, Name: "小红帽", Category: string(model.AssetCategoryCharacter), Details: details},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 2 {
		t.Fatalf("created = %d, want 2 cross-unit appearances", len(created))
	}
	result, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, ReconcileApplyRequest{Decisions: []ReconcileDecision{
		{CandidateID: created[0].ID, Action: ReconcileActionCreate},
	}})
	if err != nil {
		t.Fatal(err)
	}
	outcomes := map[string]string{}
	target := ""
	for _, item := range result.Results {
		outcomes[item.CandidateID] = item.Outcome
		if item.CandidateID == created[0].ID {
			target = item.AssetID
		}
		if item.AssetID != "" && target != "" && item.AssetID != target {
			t.Fatalf("appearance resolved to different assets: %#v", result.Results)
		}
	}
	if outcomes[created[0].ID] != ReconcileOutcomeApplied || outcomes[created[1].ID] != ReconcileOutcomeAutoLinked {
		t.Fatalf("outcomes = %#v", outcomes)
	}
	if target == "" {
		t.Fatalf("create outcome without asset: %#v", result.Results)
	}
	var assetCount int64
	if err := db.Model(&model.Asset{}).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 1 {
		t.Fatalf("assets = %d, want 1", assetCount)
	}
	var resolved int64
	if err := db.Model(&model.ProjectAssetCandidate{}).Where("status = ? AND resolved_asset_id = ?", "confirmed", target).Count(&resolved).Error; err != nil {
		t.Fatal(err)
	}
	if resolved != 2 {
		t.Fatalf("resolved appearances = %d, want 2", resolved)
	}
}

func TestReconcileApplyRejectsInvalidDecisions(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	created, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Candidates: []AssetCandidateInput{{UnitID: unit.ID, Name: "雨伞", Category: string(model.AssetCategoryProp), Details: map[string]any{"note": "道具"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	other := seedProject(t, db, model.Project{ID: "project-2", UserID: "user-1", Name: "另一部"})
	otherUnit := seedChapter(t, svc, other.ID)
	foreign, err := svc.CreateProjectAssetCandidates("user-1", other.ID, CreateAssetCandidatesRequest{
		Candidates: []AssetCandidateInput{{UnitID: otherUnit.ID, Name: "黑猫", Category: string(model.AssetCategoryProp), Details: map[string]any{"note": "道具"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, request := range map[string]ReconcileApplyRequest{
		"empty":        {Decisions: nil},
		"duplicate":    {Decisions: []ReconcileDecision{{CandidateID: created[0].ID, Action: ReconcileActionCreate}, {CandidateID: created[0].ID, Action: ReconcileActionCreate}}},
		"merge-no-id":  {Decisions: []ReconcileDecision{{CandidateID: created[0].ID, Action: ReconcileActionMerge}}},
		"create-with":  {Decisions: []ReconcileDecision{{CandidateID: created[0].ID, Action: ReconcileActionCreate, AssetID: "asset-1"}}},
		"unknown-act":  {Decisions: []ReconcileDecision{{CandidateID: created[0].ID, Action: "drop"}}},
		"foreign":      {Decisions: []ReconcileDecision{{CandidateID: foreign[0].ID, Action: ReconcileActionCreate}}},
		"not-existing": {Decisions: []ReconcileDecision{{CandidateID: "missing", Action: ReconcileActionCreate}}},
	} {
		if _, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, request); err == nil {
			t.Fatalf("%s decision was accepted", name)
		}
	}
	var candidate model.ProjectAssetCandidate
	if err := db.First(&candidate, "id = ?", created[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if candidate.Status != "pending_confirmation" {
		t.Fatalf("candidate status = %s after rejected applies", candidate.Status)
	}
}

func TestCreateProjectAssetCandidatesKeepsCrossUnitAppearance(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit1 := seedChapter(t, svc, project.ID)
	unit2 := seedChapter(t, svc, project.ID)
	unit3 := seedChapter(t, svc, project.ID)
	details := validChapterCharacterDetails()
	input := func(unitID string, name string) CreateAssetCandidatesRequest {
		return CreateAssetCandidatesRequest{
			Source: AssetCandidateSourceChapterCharacter,
			Candidates: []AssetCandidateInput{
				{UnitID: unitID, Name: name, Category: string(model.AssetCategoryCharacter), Details: details},
			},
		}
	}
	first, err := svc.CreateProjectAssetCandidates("user-1", project.ID, input(unit1.ID, "小红帽"))
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 {
		t.Fatalf("first = %d, want 1", len(first))
	}
	second, err := svc.CreateProjectAssetCandidates("user-1", project.ID, input(unit2.ID, "小红帽"))
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 {
		t.Fatalf("cross-unit appearance was dropped: %#v", second)
	}
	if second[0].UnitID != unit2.ID {
		t.Fatalf("cross-unit appearance unit = %q, want %q", second[0].UnitID, unit2.ID)
	}
	repeat, err := svc.CreateProjectAssetCandidates("user-1", project.ID, input(unit1.ID, "小红帽"))
	if err != nil {
		t.Fatal(err)
	}
	if len(repeat) != 0 {
		t.Fatalf("same-unit duplicate candidates = %#v, want single-unit dedup", repeat)
	}
	var candidateCount int64
	if err := db.Model(&model.ProjectAssetCandidate{}).Where("project_id = ? AND name_key = ?", project.ID, model.AssetCandidateNameKey("小红帽")).Count(&candidateCount).Error; err != nil {
		t.Fatal(err)
	}
	if candidateCount != 2 {
		t.Fatalf("candidates = %d, want 2 (one per unit)", candidateCount)
	}

	if _, err := svc.ConfirmProjectAssetCandidate("user-1", project.ID, first[0].ID, ConfirmProjectAssetCandidateRequest{}); err != nil {
		t.Fatal(err)
	}
	afterConfirm, err := svc.CreateProjectAssetCandidates("user-1", project.ID, input(unit3.ID, "小红帽"))
	if err != nil {
		t.Fatal(err)
	}
	if len(afterConfirm) != 0 {
		t.Fatalf("asset identity no longer blocks extraction: %#v", afterConfirm)
	}

	unscoped, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Candidates: []AssetCandidateInput{{Name: "黑伞", Category: string(model.AssetCategoryProp), Details: map[string]any{"note": "道具"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(unscoped) != 1 {
		t.Fatalf("unscoped candidate = %#v", unscoped)
	}
	blocked, err := svc.CreateProjectAssetCandidates("user-1", project.ID, CreateAssetCandidatesRequest{
		Candidates: []AssetCandidateInput{{UnitID: unit1.ID, Name: "黑伞", Category: string(model.AssetCategoryProp), Details: map[string]any{"note": "道具"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocked) != 0 {
		t.Fatalf("unscoped candidate no longer blocks unit extraction: %#v", blocked)
	}
}

func seedPropCandidate(t *testing.T, svc *Service, projectID string, unitID string, name string, details map[string]any) model.ProjectAssetCandidate {
	t.Helper()
	created, err := svc.CreateProjectAssetCandidates("user-1", projectID, CreateAssetCandidatesRequest{
		Candidates: []AssetCandidateInput{{UnitID: unitID, Name: name, Category: string(model.AssetCategoryProp), Details: details}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 {
		t.Fatalf("seed candidate %q = %#v, want 1", name, created)
	}
	return created[0]
}

func candidateStatusByID(t *testing.T, db *gorm.DB, candidateID string) model.ProjectAssetCandidate {
	t.Helper()
	var candidate model.ProjectAssetCandidate
	if err := db.First(&candidate, "id = ?", candidateID).Error; err != nil {
		t.Fatal(err)
	}
	return candidate
}

// H1：同一实体（别名闭包）不得被 create+merge 或 merge 到不同资产劈开；一致决策必须确定性落点。
func TestReconcileApplyRejectsConflictingSameEntityDecisions(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit1 := seedChapter(t, svc, project.ID)
	unit2 := seedChapter(t, svc, project.ID)
	seedReconcileAsset(t, db, project.ID, model.Asset{ID: "prop-x", UserID: "user-1", Kind: "image", Category: model.AssetCategoryProp, Title: "已有道具", PrimaryVersionID: "prop-x-v1"},
		model.AssetVersion{ID: "prop-x-v1", Version: 1})
	seedReconcileAsset(t, db, project.ID, model.Asset{ID: "prop-y", UserID: "user-1", Kind: "image", Category: model.AssetCategoryProp, Title: "另一个道具", PrimaryVersionID: "prop-y-v1"},
		model.AssetVersion{ID: "prop-y-v1", Version: 1})
	first := seedPropCandidate(t, svc, project.ID, unit1.ID, "小红帽", map[string]any{"note": "道具"})
	second := seedPropCandidate(t, svc, project.ID, unit2.ID, "小红帽", map[string]any{"note": "道具"})

	for name, request := range map[string]ReconcileApplyRequest{
		"create-plus-merge": {Decisions: []ReconcileDecision{
			{CandidateID: first.ID, Action: ReconcileActionCreate},
			{CandidateID: second.ID, Action: ReconcileActionMerge, AssetID: "prop-x"},
		}},
		"merge-to-two-assets": {Decisions: []ReconcileDecision{
			{CandidateID: first.ID, Action: ReconcileActionMerge, AssetID: "prop-x"},
			{CandidateID: second.ID, Action: ReconcileActionMerge, AssetID: "prop-y"},
		}},
	} {
		if _, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, request); err == nil {
			t.Fatalf("%s was accepted: same entity split across assets", name)
		}
	}
	for _, id := range []string{first.ID, second.ID} {
		if candidate := candidateStatusByID(t, db, id); candidate.Status != "pending_confirmation" {
			t.Fatalf("candidate %s = %s after rejected conflicts, want pending_confirmation", id, candidate.Status)
		}
	}
	var assetCount int64
	if err := db.Model(&model.Asset{}).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 2 {
		t.Fatalf("assets = %d, want 2 (rejected decisions must not write)", assetCount)
	}

	result, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, ReconcileApplyRequest{Decisions: []ReconcileDecision{
		{CandidateID: first.ID, Action: ReconcileActionCreate},
		{CandidateID: second.ID, Action: ReconcileActionCreate},
	}})
	if err != nil {
		t.Fatal(err)
	}
	appliedID := ""
	target := ""
	for _, item := range result.Results {
		if item.Outcome == ReconcileOutcomeApplied {
			if appliedID != "" {
				t.Fatalf("more than one write in one entity group: %#v", result.Results)
			}
			appliedID = item.CandidateID
			target = item.AssetID
		}
		if item.AssetID != "" && target != "" && item.AssetID != target {
			t.Fatalf("entity group split across assets: %#v", result.Results)
		}
	}
	wantApplied := first.ID
	if second.ID < first.ID {
		wantApplied = second.ID
	}
	if appliedID != wantApplied {
		t.Fatalf("landing candidate = %s, want deterministic %s (%#v)", appliedID, wantApplied, result.Results)
	}
	for _, id := range []string{first.ID, second.ID} {
		candidate := candidateStatusByID(t, db, id)
		if candidate.ResolvedAssetID != target || candidate.Status != "confirmed" {
			t.Fatalf("candidate %s = %#v, want resolved to %s", id, candidate, target)
		}
	}
	if err := db.Model(&model.Asset{}).Count(&assetCount).Error; err != nil {
		t.Fatal(err)
	}
	if assetCount != 3 {
		t.Fatalf("assets = %d, want 3 (one create for the entity group)", assetCount)
	}
}

// H2：自动落点按 GET 同口径的别名传递闭包整组一致落点，不能只落直接 key 相交的出现。
func TestReconcileApplyAutoLinksAliasClosureCluster(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit1 := seedChapter(t, svc, project.ID)
	unit2 := seedChapter(t, svc, project.ID)
	unit3 := seedChapter(t, svc, project.ID)
	alpha := seedPropCandidate(t, svc, project.ID, unit1.ID, "阿尔法", map[string]any{"aliases": []any{"中间"}})
	middle := seedPropCandidate(t, svc, project.ID, unit2.ID, "中间", map[string]any{"aliases": []any{"贝塔"}})
	beta := seedPropCandidate(t, svc, project.ID, unit3.ID, "贝塔", map[string]any{})

	reconciliation, err := svc.ProjectAssetReconciliation("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(reconciliation.CandidateIdentities) != 1 || len(reconciliation.CandidateIdentities[0].Appearances) != 3 {
		t.Fatalf("GET grouping = %#v, want one alias-closure group of 3", reconciliation.CandidateIdentities)
	}

	result, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, ReconcileApplyRequest{Decisions: []ReconcileDecision{
		{CandidateID: alpha.ID, Action: ReconcileActionCreate},
	}})
	if err != nil {
		t.Fatal(err)
	}
	outcomes := map[string]string{}
	target := ""
	for _, item := range result.Results {
		outcomes[item.CandidateID] = item.Outcome
		if item.AssetID != "" {
			if target != "" && item.AssetID != target {
				t.Fatalf("alias closure split across assets: %#v", result.Results)
			}
			target = item.AssetID
		}
	}
	if outcomes[alpha.ID] != ReconcileOutcomeApplied || outcomes[middle.ID] != ReconcileOutcomeAutoLinked || outcomes[beta.ID] != ReconcileOutcomeAutoLinked {
		t.Fatalf("outcomes = %#v, want closure auto-link for middle and beta", outcomes)
	}
	for _, id := range []string{alpha.ID, middle.ID, beta.ID} {
		if candidate := candidateStatusByID(t, db, id); candidate.ResolvedAssetID != target || candidate.Status != "confirmed" {
			t.Fatalf("candidate %s = %#v, want closure landing on %s", id, candidate, target)
		}
	}
}

// M1：merge 必须同分类；resolved 建议同样校验分类。
func TestReconcileMergeRequiresSameCategory(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	character, err := svc.CreateProjectCharacter("user-1", project.ID, CreateProjectCharacterRequest{Name: "小红帽", Definition: map[string]any{"role": "主角"}})
	if err != nil {
		t.Fatal(err)
	}
	candidate := seedPropCandidate(t, svc, project.ID, unit.ID, "雨伞", map[string]any{"note": "道具"})

	if _, err := svc.ConfirmProjectAssetCandidate("user-1", project.ID, candidate.ID, ConfirmProjectAssetCandidateRequest{AssetID: character.Asset.ID}); err == nil {
		t.Fatal("single confirm merged prop candidate into character asset")
	}
	if _, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, ReconcileApplyRequest{Decisions: []ReconcileDecision{
		{CandidateID: candidate.ID, Action: ReconcileActionMerge, AssetID: character.Asset.ID},
	}}); err == nil {
		t.Fatal("apply merged prop candidate into character asset")
	}
	if stored := candidateStatusByID(t, db, candidate.ID); stored.Status != "pending_confirmation" {
		t.Fatalf("candidate = %s, want pending_confirmation after cross-category rejection", stored.Status)
	}

	now := time.Now()
	legacy := model.ProjectAssetCandidate{
		ID: "cross-resolved", ProjectID: project.ID, Name: "黑伞", NameKey: model.AssetCandidateNameKey("黑伞"),
		Category: model.AssetCategoryProp, Status: "confirmed", ResolvedAssetID: character.Asset.ID,
		DetailsJSON: "{}", CreatedAt: now, UpdatedAt: now,
	}
	if err := db.Create(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	reconciliation, err := svc.ProjectAssetReconciliation("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, group := range reconciliation.CandidateIdentities {
		if group.Name != "黑伞" {
			continue
		}
		if group.Suggestion.Match == CandidateSuggestionMatchResolved || group.Suggestion.AssetID == character.Asset.ID {
			t.Fatalf("cross-category resolved suggestion = %#v", group.Suggestion)
		}
		if group.Suggestion.Action != ReconcileActionCreate {
			t.Fatalf("cross-category resolved suggestion = %#v, want create fallback", group.Suggestion)
		}
		return
	}
	t.Fatalf("candidate identities = %#v, want 黑伞 group", reconciliation.CandidateIdentities)
}

// L1：成功回执动作必须是实际生效动作；矛盾 merge（改到另一资产）必须拒绝，已确认出现不得被改走。
func TestReconcileApplyReceiptReportsEffectiveAction(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	seedReconcileAsset(t, db, project.ID, model.Asset{ID: "prop-x", UserID: "user-1", Kind: "image", Category: model.AssetCategoryProp, Title: "已有道具", PrimaryVersionID: "prop-x-v1"},
		model.AssetVersion{ID: "prop-x-v1", Version: 1})
	umbrella := seedPropCandidate(t, svc, project.ID, unit.ID, "雨伞", map[string]any{"note": "道具"})
	blackCat := seedPropCandidate(t, svc, project.ID, unit.ID, "黑猫", map[string]any{"note": "道具"})

	first, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, ReconcileApplyRequest{Decisions: []ReconcileDecision{
		{CandidateID: umbrella.ID, Action: ReconcileActionCreate},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if first.Results[0].Outcome != ReconcileOutcomeApplied || first.Results[0].Action != ReconcileActionCreate {
		t.Fatalf("first apply = %#v, want applied create", first.Results[0])
	}
	createdAssetID := first.Results[0].AssetID

	overlap, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, ReconcileApplyRequest{Decisions: []ReconcileDecision{
		{CandidateID: umbrella.ID, Action: ReconcileActionCreate},
		{CandidateID: blackCat.ID, Action: ReconcileActionCreate},
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range overlap.Results {
		if item.CandidateID != umbrella.ID {
			continue
		}
		if item.Outcome != ReconcileOutcomeAlreadyConfirmed || item.Action != ReconcileActionMerge || item.AssetID != createdAssetID {
			t.Fatalf("already-confirmed receipt = %#v, want effective action merge into %s (not echoing create)", item, createdAssetID)
		}
	}

	if _, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, ReconcileApplyRequest{Decisions: []ReconcileDecision{
		{CandidateID: umbrella.ID, Action: ReconcileActionMerge, AssetID: "prop-x"},
	}}); err == nil {
		t.Fatal("merge into another asset on a resolved candidate was silently accepted")
	}
	if stored := candidateStatusByID(t, db, umbrella.ID); stored.ResolvedAssetID != createdAssetID || stored.Status != "confirmed" {
		t.Fatalf("resolved candidate = %#v, must stay on %s", stored, createdAssetID)
	}
}

// 分类防护：legacy 已确认出现的 ResolvedAssetID 跨分类时，同实体 pending 出现
// 不得经 create/resolved 或统一 auto-link 落点被归并到错误分类资产，整批不写。
func TestReconcileAutoLinkRejectsCrossCategoryResolvedTarget(t *testing.T) {
	svc, db := newTestService(t, nil)
	project := seedProject(t, db, model.Project{ID: "project-1", UserID: "user-1", Name: "短剧"})
	unit := seedChapter(t, svc, project.ID)
	character, err := svc.CreateProjectCharacter("user-1", project.ID, CreateProjectCharacterRequest{Name: "小红帽", Definition: map[string]any{"role": "主角"}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	legacy := model.ProjectAssetCandidate{
		ID: "cross-resolved", ProjectID: project.ID, Name: "黑伞", NameKey: model.AssetCandidateNameKey("黑伞"),
		Category: model.AssetCategoryProp, Status: "confirmed", ResolvedAssetID: character.Asset.ID,
		DetailsJSON: "{}", CreatedAt: now, UpdatedAt: now,
	}
	pending := model.ProjectAssetCandidate{
		ID: "cross-pending", ProjectID: project.ID, UnitID: unit.ID, Name: "黑伞", NameKey: model.AssetCandidateNameKey("黑伞"),
		Category: model.AssetCategoryProp, Status: "pending_confirmation",
		DetailsJSON: "{}", CreatedAt: now.Add(time.Second), UpdatedAt: now,
	}
	for _, row := range []model.ProjectAssetCandidate{legacy, pending} {
		if err := db.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	reconciliation, err := svc.ProjectAssetReconciliation("user-1", project.ID)
	if err != nil {
		t.Fatal(err)
	}
	grouped := false
	for _, group := range reconciliation.CandidateIdentities {
		if group.Name == "黑伞" && len(group.Appearances) == 2 {
			grouped = true
		}
	}
	if !grouped {
		t.Fatalf("candidate identities = %#v, want one 黑伞 group with 2 appearances", reconciliation.CandidateIdentities)
	}

	for name, request := range map[string]ReconcileApplyRequest{
		"create-on-resolved": {Decisions: []ReconcileDecision{
			{CandidateID: pending.ID, Action: ReconcileActionCreate},
		}},
		"merge-into-resolved": {Decisions: []ReconcileDecision{
			{CandidateID: pending.ID, Action: ReconcileActionMerge, AssetID: character.Asset.ID},
		}},
		"closure-auto-link": {Decisions: []ReconcileDecision{
			{CandidateID: legacy.ID, Action: ReconcileActionMerge, AssetID: character.Asset.ID},
		}},
	} {
		if _, err := svc.ApplyAssetReconciliationDecisions("user-1", project.ID, request); err == nil {
			t.Fatalf("%s landed a prop appearance on a character asset", name)
		}
		stored := candidateStatusByID(t, db, pending.ID)
		if stored.Status != "pending_confirmation" || stored.ResolvedAssetID != "" {
			t.Fatalf("%s left writes behind: pending = %#v, want whole batch unwritten", name, stored)
		}
	}
}
