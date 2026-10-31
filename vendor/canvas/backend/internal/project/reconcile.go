package project

import (
	"encoding/json"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// AssetReconciliation 是跨集资产对账台账的只读模型：
// 逐集的引用版本清单、可解释的漂移点、抽取候选按实体归组后的合并/新建建议。
type AssetReconciliation struct {
	Units               []UnitAssetInventory     `json:"units"`
	Drifts              []AssetDrift             `json:"drifts"`
	CandidateIdentities []CandidateIdentityGroup `json:"candidateIdentities"`
}

type UnitAssetInventory struct {
	UnitID    string           `json:"unitId"`
	UnitTitle string           `json:"unitTitle"`
	Kind      string           `json:"kind"`
	Entries   []UnitAssetEntry `json:"entries"`
}

// UnitAssetEntry 是某集内某资产被镜头引用到的版本清单。
type UnitAssetEntry struct {
	AssetID          string                  `json:"assetId"`
	Title            string                  `json:"title"`
	Category         model.AssetCategory     `json:"category"`
	PrimaryVersionID string                  `json:"primaryVersionId,omitempty"`
	Versions         []UnitAssetVersionUsage `json:"versions"`
}

type UnitAssetVersionUsage struct {
	VersionID string   `json:"versionId"`
	Version   int      `json:"version"`
	IsPrimary bool     `json:"isPrimary"`
	ShotIDs   []string `json:"shotIds"`
	Roles     []string `json:"roles"`
}

// AssetDrift 是可解释的漂移点：Kind 给机器判断，Reason 给人看。
type AssetDrift struct {
	Kind         string   `json:"kind"`
	Reason       string   `json:"reason"`
	UnitID       string   `json:"unitId,omitempty"`
	ShotID       string   `json:"shotId,omitempty"`
	AssetID      string   `json:"assetId,omitempty"`
	AssetTitle   string   `json:"assetTitle,omitempty"`
	VersionIDs   []string `json:"versionIds,omitempty"`
	ArtifactID   string   `json:"artifactId,omitempty"`
	ArtifactType string   `json:"artifactType,omitempty"`
}

const (
	AssetDriftShotMissingReference           = "shot_missing_reference"
	AssetDriftVersionBehindPrimary           = "reference_version_behind_primary"
	AssetDriftAssetMultiVersion              = "asset_multi_version_reference"
	AssetDriftStaleArtifact                  = "stale_artifact"
	AssetDriftCharacterMissingRepresentation = "character_reference_missing_representation"
	AssetDriftReferenceAssetUnlinked         = "reference_asset_unlinked"
)

type CandidateIdentityGroup struct {
	Key         string                `json:"key"`
	Name        string                `json:"name"`
	Category    model.AssetCategory   `json:"category"`
	Appearances []CandidateAppearance `json:"appearances"`
	Suggestion  CandidateSuggestion   `json:"suggestion"`
}

type CandidateAppearance struct {
	CandidateID     string `json:"candidateId"`
	UnitID          string `json:"unitId,omitempty"`
	ShotID          string `json:"shotId,omitempty"`
	Status          string `json:"status"`
	ResolvedAssetID string `json:"resolvedAssetId,omitempty"`
}

// CandidateSuggestion 是确定性的合并/新建建议（名称/别名匹配），UI 可行内改判。
type CandidateSuggestion struct {
	Action     string `json:"action"`
	AssetID    string `json:"assetId,omitempty"`
	AssetTitle string `json:"assetTitle,omitempty"`
	Match      string `json:"match"`
	Reason     string `json:"reason"`
}

const (
	CandidateSuggestionMatchResolved   = "resolved"
	CandidateSuggestionMatchAssetName  = "asset_name"
	CandidateSuggestionMatchAssetAlias = "asset_alias"
	CandidateSuggestionMatchNone       = "none"
)

func (s *Service) ProjectAssetReconciliation(userID string, projectID string) (AssetReconciliation, error) {
	if _, err := s.Owned(userID, projectID); err != nil {
		return AssetReconciliation{}, err
	}
	units, err := s.repo.ProjectUnits(projectID)
	if err != nil {
		return AssetReconciliation{}, err
	}
	shots, err := s.repo.ProjectShots(projectID)
	if err != nil {
		return AssetReconciliation{}, err
	}
	references, err := s.repo.ProjectShotAssetReferences(projectID)
	if err != nil {
		return AssetReconciliation{}, err
	}
	artifacts, err := s.repo.ProjectShotArtifacts(projectID)
	if err != nil {
		return AssetReconciliation{}, err
	}
	assets, err := s.repo.ProjectAssets(userID, projectID)
	if err != nil {
		return AssetReconciliation{}, err
	}
	candidates, err := s.repo.ProjectAssetCandidates(projectID)
	if err != nil {
		return AssetReconciliation{}, err
	}
	versionIDs := make([]string, 0, len(references))
	seenVersion := make(map[string]struct{}, len(references))
	for _, reference := range references {
		if _, exists := seenVersion[reference.AssetVersionID]; exists {
			continue
		}
		seenVersion[reference.AssetVersionID] = struct{}{}
		versionIDs = append(versionIDs, reference.AssetVersionID)
	}
	versions, err := s.repo.AssetVersionsByIDs(versionIDs)
	if err != nil {
		return AssetReconciliation{}, err
	}
	representations, err := s.repo.AssetRepresentationsByVersionIDs(versionIDs)
	if err != nil {
		return AssetReconciliation{}, err
	}
	result := buildAssetReconciliation(units, shots, references, versions, representations, artifacts, assets, candidates)
	return result, nil
}

func buildAssetReconciliation(
	units []model.ProjectUnit,
	shots []model.Shot,
	references []model.ShotAssetReference,
	versions []model.AssetVersion,
	representations []model.AssetRepresentation,
	artifacts []model.ShotArtifact,
	assets []model.Asset,
	candidates []model.ProjectAssetCandidate,
) AssetReconciliation {
	assetByID := make(map[string]model.Asset, len(assets))
	for _, asset := range assets {
		assetByID[asset.ID] = asset
	}
	shotByID := make(map[string]model.Shot, len(shots))
	for _, shot := range shots {
		shotByID[shot.ID] = shot
	}
	versionByID := make(map[string]model.AssetVersion, len(versions))
	for _, version := range versions {
		versionByID[version.ID] = version
	}
	representationCount := make(map[string]int, len(representations))
	for _, representation := range representations {
		representationCount[representation.AssetVersionID]++
	}

	reconciliation := AssetReconciliation{
		Units:               make([]UnitAssetInventory, 0, len(units)),
		Drifts:              make([]AssetDrift, 0),
		CandidateIdentities: make([]CandidateIdentityGroup, 0),
	}
	inventoryIndex := make(map[string]map[string]*UnitAssetEntry, len(units))
	for _, unit := range units {
		inventoryIndex[unit.ID] = make(map[string]*UnitAssetEntry)
		reconciliation.Units = append(reconciliation.Units, UnitAssetInventory{
			UnitID: unit.ID, UnitTitle: unit.Title, Kind: string(unit.Kind), Entries: []UnitAssetEntry{},
		})
	}
	unitPosition := make(map[string]int, len(units))
	for index, unit := range units {
		unitPosition[unit.ID] = index
	}

	referencedVersionsByAsset := make(map[string]map[string]struct{})
	refsByShot := make(map[string]int, len(shots))
	for _, reference := range references {
		refsByShot[reference.ShotID]++
		shot, shotExists := shotByID[reference.ShotID]
		if !shotExists {
			continue
		}
		version, versionExists := versionByID[reference.AssetVersionID]
		asset, assetExists := assetByID[version.AssetID]
		if !versionExists || !assetExists {
			reconciliation.Drifts = append(reconciliation.Drifts, AssetDrift{
				Kind:       AssetDriftReferenceAssetUnlinked,
				Reason:     "镜头引用的资产版本已不在项目素材中，需要重新绑定引用",
				UnitID:     shot.UnitID,
				ShotID:     shot.ID,
				VersionIDs: []string{reference.AssetVersionID},
			})
			continue
		}
		if asset.PrimaryVersionID != "" && version.ID != asset.PrimaryVersionID {
			reconciliation.Drifts = append(reconciliation.Drifts, AssetDrift{
				Kind:       AssetDriftVersionBehindPrimary,
				Reason:     "镜头引用的版本落后于资产当前主版本，旧集需要按新设定重渲",
				UnitID:     shot.UnitID,
				ShotID:     shot.ID,
				AssetID:    asset.ID,
				AssetTitle: asset.Title,
				VersionIDs: []string{version.ID},
			})
		}
		if asset.Category == model.AssetCategoryCharacter && representationCount[version.ID] == 0 {
			reconciliation.Drifts = append(reconciliation.Drifts, AssetDrift{
				Kind:       AssetDriftCharacterMissingRepresentation,
				Reason:     "角色引用版本没有定妆表现，出图缺少视觉锚点",
				UnitID:     shot.UnitID,
				ShotID:     shot.ID,
				AssetID:    asset.ID,
				AssetTitle: asset.Title,
				VersionIDs: []string{version.ID},
			})
		}
		if referencedVersionsByAsset[asset.ID] == nil {
			referencedVersionsByAsset[asset.ID] = make(map[string]struct{})
		}
		referencedVersionsByAsset[asset.ID][version.ID] = struct{}{}

		entries := inventoryIndex[shot.UnitID]
		if entries == nil {
			continue
		}
		entry := entries[asset.ID]
		if entry == nil {
			entry = &UnitAssetEntry{
				AssetID: asset.ID, Title: asset.Title, Category: asset.Category,
				PrimaryVersionID: asset.PrimaryVersionID, Versions: []UnitAssetVersionUsage{},
			}
			entries[asset.ID] = entry
		}
		var usage *UnitAssetVersionUsage
		for index := range entry.Versions {
			if entry.Versions[index].VersionID == version.ID {
				usage = &entry.Versions[index]
				break
			}
		}
		if usage == nil {
			entry.Versions = append(entry.Versions, UnitAssetVersionUsage{
				VersionID: version.ID, Version: version.Version, IsPrimary: version.ID == asset.PrimaryVersionID,
				ShotIDs: []string{}, Roles: []string{},
			})
			usage = &entry.Versions[len(entry.Versions)-1]
		}
		usage.ShotIDs = appendUniqueString(usage.ShotIDs, shot.ID)
		usage.Roles = appendUniqueString(usage.Roles, reference.Role)
	}
	for _, shot := range shots {
		if refsByShot[shot.ID] == 0 {
			reconciliation.Drifts = append(reconciliation.Drifts, AssetDrift{
				Kind:   AssetDriftShotMissingReference,
				Reason: "镜头没有任何资产版本引用，生成时缺少角色/场景/道具锚点",
				UnitID: shot.UnitID,
				ShotID: shot.ID,
			})
		}
	}
	for _, asset := range assets {
		referenced := referencedVersionsByAsset[asset.ID]
		if len(referenced) < 2 {
			continue
		}
		versionIDs := make([]string, 0, len(referenced))
		for versionID := range referenced {
			versionIDs = append(versionIDs, versionID)
		}
		sort.Strings(versionIDs)
		reconciliation.Drifts = append(reconciliation.Drifts, AssetDrift{
			Kind:       AssetDriftAssetMultiVersion,
			Reason:     "同一资产在项目内被多个版本引用，跨集形象可能不一致",
			AssetID:    asset.ID,
			AssetTitle: asset.Title,
			VersionIDs: versionIDs,
		})
	}
	for _, artifact := range artifacts {
		if artifact.Status != "stale" {
			continue
		}
		reconciliation.Drifts = append(reconciliation.Drifts, AssetDrift{
			Kind:         AssetDriftStaleArtifact,
			Reason:       "分镜或资产变更后产物已标记失效，需要重新渲染",
			UnitID:       artifact.UnitID,
			ShotID:       artifact.ShotID,
			ArtifactID:   artifact.ID,
			ArtifactType: artifact.Type,
		})
	}

	for unitIndex := range reconciliation.Units {
		entries := inventoryIndex[reconciliation.Units[unitIndex].UnitID]
		flat := make([]UnitAssetEntry, 0, len(entries))
		for _, entry := range entries {
			for versionIndex := range entry.Versions {
				sort.Strings(entry.Versions[versionIndex].ShotIDs)
				sort.Strings(entry.Versions[versionIndex].Roles)
			}
			sort.Slice(entry.Versions, func(i, j int) bool {
				return entry.Versions[i].Version < entry.Versions[j].Version
			})
			flat = append(flat, *entry)
		}
		sort.Slice(flat, func(i, j int) bool {
			if flat[i].Category != flat[j].Category {
				return flat[i].Category < flat[j].Category
			}
			if flat[i].Title != flat[j].Title {
				return flat[i].Title < flat[j].Title
			}
			return flat[i].AssetID < flat[j].AssetID
		})
		reconciliation.Units[unitIndex].Entries = flat
	}
	sort.SliceStable(reconciliation.Drifts, func(i, j int) bool {
		left, right := reconciliation.Drifts[i], reconciliation.Drifts[j]
		if left.Kind != right.Kind {
			return left.Kind < right.Kind
		}
		if left.UnitID != right.UnitID {
			return left.UnitID < right.UnitID
		}
		if left.ShotID != right.ShotID {
			return left.ShotID < right.ShotID
		}
		return left.AssetID < right.AssetID
	})
	reconciliation.CandidateIdentities = buildCandidateIdentityGroups(candidates, assets)
	return reconciliation
}

func appendUniqueString(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

// candidateIdentityCluster 是同一实体的候选出现闭包：同分类且名称/别名传递相交（A—C—B 链归同一簇）。
// GET 归组与 apply 自动落点必须共用这一个口径，否则别名链会漏落。
type candidateIdentityCluster struct {
	Candidates []model.ProjectAssetCandidate
	Keys       map[string]struct{}
}

// clusterCandidateIdentities 按别名传递闭包把候选聚成簇，簇序按最早出现确定。
func clusterCandidateIdentities(candidates []model.ProjectAssetCandidate) []candidateIdentityCluster {
	ordered := make([]model.ProjectAssetCandidate, len(candidates))
	copy(ordered, candidates)
	sort.SliceStable(ordered, func(i, j int) bool {
		if !ordered[i].CreatedAt.Equal(ordered[j].CreatedAt) {
			return ordered[i].CreatedAt.Before(ordered[j].CreatedAt)
		}
		return ordered[i].ID < ordered[j].ID
	})
	parent := make([]int, len(ordered))
	for index := range parent {
		parent[index] = index
	}
	var find func(int) int
	find = func(node int) int {
		for parent[node] != node {
			parent[node] = parent[parent[node]]
			node = parent[node]
		}
		return node
	}
	union := func(left int, right int) {
		leftRoot, rightRoot := find(left), find(right)
		if leftRoot == rightRoot {
			return
		}
		if leftRoot < rightRoot {
			parent[rightRoot] = leftRoot
		} else {
			parent[leftRoot] = rightRoot
		}
	}
	keyOwner := make(map[string]int)
	for index, candidate := range ordered {
		for _, key := range candidateIdentityKeys(&candidate) {
			if owner, exists := keyOwner[key]; exists {
				union(owner, index)
			} else {
				keyOwner[key] = index
			}
		}
	}
	clusters := make(map[int]*candidateIdentityCluster)
	order := make([]int, 0, len(ordered))
	for index, candidate := range ordered {
		root := find(index)
		cluster, exists := clusters[root]
		if !exists {
			cluster = &candidateIdentityCluster{Candidates: []model.ProjectAssetCandidate{}, Keys: make(map[string]struct{})}
			clusters[root] = cluster
			order = append(order, root)
		}
		cluster.Candidates = append(cluster.Candidates, candidate)
		for _, key := range candidateIdentityKeys(&candidate) {
			cluster.Keys[strings.TrimPrefix(key, string(candidate.Category)+":")] = struct{}{}
		}
	}
	result := make([]candidateIdentityCluster, 0, len(order))
	for _, root := range order {
		result = append(result, *clusters[root])
	}
	return result
}

// buildCandidateIdentityGroups 把同一实体（分类一致且名称/别名相交）的候选出现归成一组。
func buildCandidateIdentityGroups(candidates []model.ProjectAssetCandidate, assets []model.Asset) []CandidateIdentityGroup {
	clusters := clusterCandidateIdentities(candidates)
	result := make([]CandidateIdentityGroup, 0, len(clusters))
	for _, cluster := range clusters {
		first := cluster.Candidates[0]
		group := CandidateIdentityGroup{
			Key:         string(first.Category) + ":" + first.NameKey,
			Name:        first.Name,
			Category:    first.Category,
			Appearances: make([]CandidateAppearance, 0, len(cluster.Candidates)),
		}
		for _, candidate := range cluster.Candidates {
			group.Appearances = append(group.Appearances, CandidateAppearance{
				CandidateID: candidate.ID, UnitID: candidate.UnitID, ShotID: candidate.ShotID,
				Status: candidate.Status, ResolvedAssetID: candidate.ResolvedAssetID,
			})
		}
		group.Suggestion = suggestCandidateDecision(group, cluster.Keys, assets)
		result = append(result, group)
	}
	return result
}

// suggestCandidateDecision 只做确定性的名称/别名匹配：优先已归并结果（须同分类），再匹配项目资产，最后建议新建。
func suggestCandidateDecision(group CandidateIdentityGroup, keys map[string]struct{}, assets []model.Asset) CandidateSuggestion {
	for _, appearance := range group.Appearances {
		if appearance.Status != "pending_confirmation" && strings.TrimSpace(appearance.ResolvedAssetID) != "" {
			for _, asset := range assets {
				if asset.ID == appearance.ResolvedAssetID && asset.Category == group.Category {
					return CandidateSuggestion{
						Action: ReconcileActionMerge, AssetID: asset.ID, AssetTitle: asset.Title,
						Match:  CandidateSuggestionMatchResolved,
						Reason: "同一实体已有归并结果，建议并入资产《" + asset.Title + "》",
					}
				}
			}
		}
	}
	for _, asset := range assets {
		if asset.Category != group.Category {
			continue
		}
		assetKeys := assetIdentityKeys(asset)
		matched := false
		for key := range assetKeys {
			if _, exists := keys[key]; exists {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		match := CandidateSuggestionMatchAssetAlias
		reason := "候选与资产《" + asset.Title + "》别名一致，建议合并"
		if _, nameMatched := keys[model.AssetCandidateNameKey(asset.Title)]; nameMatched {
			match = CandidateSuggestionMatchAssetName
			reason = "候选与资产《" + asset.Title + "》名称一致，建议合并"
		}
		return CandidateSuggestion{Action: ReconcileActionMerge, AssetID: asset.ID, AssetTitle: asset.Title, Match: match, Reason: reason}
	}
	return CandidateSuggestion{
		Action: ReconcileActionCreate,
		Match:  CandidateSuggestionMatchNone,
		Reason: "未找到同名或同别名资产，建议新建资产后归并跨集出现",
	}
}

func assetIdentityKeys(asset model.Asset) map[string]struct{} {
	keys := make(map[string]struct{})
	if key := model.AssetCandidateNameKey(asset.Title); key != "" {
		keys[key] = struct{}{}
	}
	if asset.Category == model.AssetCategoryCharacter {
		var payload struct {
			Data struct {
				Definition map[string]any `json:"definition"`
			} `json:"data"`
		}
		if json.Unmarshal([]byte(asset.PayloadJSON), &payload) == nil {
			for _, key := range assetCandidateAliases(payload.Data.Definition) {
				if key != "" {
					keys[key] = struct{}{}
				}
			}
		}
	}
	return keys
}

// candidateIdentityKeys 与候选创建去重使用同一身份口径：名称 + 别名，带分类前缀。
func candidateIdentityKeys(candidate *model.ProjectAssetCandidate) []string {
	keys := []string{candidate.NameKey}
	if strings.TrimSpace(candidate.DetailsJSON) != "" {
		var details map[string]any
		if json.Unmarshal([]byte(candidate.DetailsJSON), &details) == nil {
			keys = append(keys, assetCandidateAliases(details)...)
		}
	}
	prefixed := make([]string, 0, len(keys))
	for _, key := range keys {
		if key != "" {
			prefixed = append(prefixed, string(candidate.Category)+":"+key)
		}
	}
	return prefixed
}
