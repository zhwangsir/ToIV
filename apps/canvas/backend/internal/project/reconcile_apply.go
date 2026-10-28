package project

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/operations"

	"gorm.io/gorm"
)

const (
	ReconcileActionMerge  = "merge"
	ReconcileActionCreate = "create"

	ReconcileOutcomeApplied          = "applied"
	ReconcileOutcomeAlreadyConfirmed = "already_confirmed"
	ReconcileOutcomeAutoLinked       = "auto_linked"

	ReconcileApplyOp           = "project.asset.reconcile.apply"
	reconcileApplyOpIDPrefix   = "reconcile-apply:"
	maxReconcileApplyDecisions = 50
)

// ReconcileDecision 是一条候选合并/新建决策；UI 可按对账建议行内改判。
type ReconcileDecision struct {
	CandidateID string `json:"candidateId"`
	Action      string `json:"action"`
	AssetID     string `json:"assetId,omitempty"`
}

type ReconcileApplyRequest struct {
	Decisions []ReconcileDecision `json:"decisions"`
}

type ReconcileApplyOutcome struct {
	CandidateID     string `json:"candidateId"`
	Action          string `json:"action"`
	AssetID         string `json:"assetId,omitempty"`
	Outcome         string `json:"outcome"`
	CandidateStatus string `json:"candidateStatus"`
}

// reconcileApplyReceipt 与写入同事务持久化：同一决策集合重放只回读回执，不新建版本或资产。
type reconcileApplyReceipt struct {
	ProjectID string                  `json:"projectId"`
	Results   []ReconcileApplyOutcome `json:"results"`
}

type ReconcileApplyResult struct {
	Replayed bool                    `json:"replayed"`
	Results  []ReconcileApplyOutcome `json:"results"`
}

func (s *Service) ApplyAssetReconciliationDecisions(userID string, projectID string, req ReconcileApplyRequest) (ReconcileApplyResult, error) {
	if _, err := s.Active(userID, projectID); err != nil {
		return ReconcileApplyResult{}, err
	}
	decisions, err := normalizeReconcileDecisions(req.Decisions)
	if err != nil {
		return ReconcileApplyResult{}, err
	}
	payload, err := marshalReconcileApplyPayload(projectID, decisions)
	if err != nil {
		return ReconcileApplyResult{}, err
	}
	outcome, err := operations.NewStore(s.repo.DB()).Run(context.Background(), operations.RunRequest{
		UserID:      userID,
		OpID:        reconcileApplyOpID(payload),
		Op:          ReconcileApplyOp,
		PayloadHash: operations.PayloadHash(ReconcileApplyOp, payload),
	}, func(tx *gorm.DB) ([]byte, error) {
		txService := s.withRepo(s.repo.WithTx(tx))
		receipt, runErr := txService.applyReconcileDecisions(userID, projectID, decisions)
		if runErr != nil {
			return nil, runErr
		}
		return marshalReconcileApplyReceipt(receipt)
	})
	if err != nil {
		return ReconcileApplyResult{}, mapChapterApplyWriteError(err)
	}
	stored, err := unmarshalReconcileApplyReceipt(outcome.Result)
	if err != nil {
		return ReconcileApplyResult{}, err
	}
	return ReconcileApplyResult{Replayed: outcome.Replayed, Results: stored.Results}, nil
}

// applyReconcileDecisions 在同一事务里按决策集合执行候选确认。
// 同一实体（别名传递闭包）先整体校验再写入：create/merge 混合、merge 到不同资产、
// 已归并实体改到其他资产都在任何写入前整批拒绝；一致决策只有确定性的一次落点写入
// （集合内 ID 最小的待确认显式决策），其余出现按闭包自动归并，不各建资产/版本。
// 显式决策复用 candidate confirm 写入（角色合并只补空字段与别名并加新版本）。
func (s *Service) applyReconcileDecisions(userID string, projectID string, decisions []ReconcileDecision) (reconcileApplyReceipt, error) {
	receipt := reconcileApplyReceipt{ProjectID: projectID, Results: make([]ReconcileApplyOutcome, 0, len(decisions)+4)}
	all, err := s.repo.ProjectAssetCandidates(projectID)
	if err != nil {
		return receipt, err
	}
	byID := make(map[string]*model.ProjectAssetCandidate, len(all))
	for index := range all {
		byID[all[index].ID] = &all[index]
	}
	clusters := clusterCandidateIdentities(all)
	clusterOf := make(map[string]int, len(all))
	for index := range clusters {
		for _, member := range clusters[index].Candidates {
			clusterOf[member.ID] = index
		}
	}

	// 落点计划：每个实体簇一次写入（或整簇已归并时零写入），回执动作按实际生效动作回显。
	type clusterPlan struct {
		mode       string
		targetID   string
		landing    *model.ProjectAssetCandidate
		explicit   []*model.ProjectAssetCandidate
		resolvedID string
	}
	plans := map[int]*clusterPlan{}
	planOrder := make([]int, 0, len(decisions))
	for _, decision := range decisions {
		candidate := byID[decision.CandidateID]
		if candidate == nil {
			return receipt, gorm.ErrRecordNotFound
		}
		index := clusterOf[candidate.ID]
		cluster := &clusters[index]
		resolvedID := ""
		for _, member := range cluster.Candidates {
			if member.Status == "pending_confirmation" || strings.TrimSpace(member.ResolvedAssetID) == "" {
				continue
			}
			if resolvedID == "" {
				resolvedID = member.ResolvedAssetID
			} else if resolvedID != member.ResolvedAssetID {
				return receipt, kernel.BadAuthRequest("同一实体已归并到多个资产，无法自动归并，请先人工拆分")
			}
		}
		plan, exists := plans[index]
		if !exists {
			plan = &clusterPlan{mode: decision.Action, resolvedID: resolvedID}
			if decision.Action == ReconcileActionMerge {
				plan.targetID = decision.AssetID
			}
			plans[index] = plan
			planOrder = append(planOrder, index)
		}
		if plan.mode != decision.Action {
			return receipt, kernel.BadAuthRequest("同一实体的归并决策互相矛盾：不能同时新建和合并")
		}
		if plan.mode == ReconcileActionMerge && plan.targetID != decision.AssetID {
			return receipt, kernel.BadAuthRequest("同一实体的归并决策互相矛盾：不能并入多个资产")
		}
		if plan.mode == ReconcileActionMerge && plan.resolvedID != "" && plan.targetID != plan.resolvedID {
			return receipt, kernel.BadAuthRequest("该实体已归并到其他资产，不能改到别的资产")
		}
		plan.explicit = append(plan.explicit, candidate)
		if plan.landing == nil && candidate.Status == "pending_confirmation" {
			plan.landing = candidate
		}
	}

	for _, index := range planOrder {
		plan := plans[index]
		cluster := &clusters[index]
		targetID := plan.targetID
		if plan.mode == ReconcileActionCreate && plan.resolvedID != "" {
			// 实体已有归并结果：新建只作幂等确认，不做写入，整簇一致落到已有资产。
			targetID = plan.resolvedID
			plan.landing = nil
			for _, candidate := range plan.explicit {
				if candidate.Status == "pending_confirmation" {
					continue
				}
				receipt.Results = append(receipt.Results, ReconcileApplyOutcome{
					CandidateID: candidate.ID, Action: ReconcileActionMerge, AssetID: targetID,
					Outcome: ReconcileOutcomeAlreadyConfirmed, CandidateStatus: candidate.Status,
				})
			}
		} else if plan.landing != nil {
			// 落点写入逐候选复用候选确认事务（每候选约十余条 SQL，含 CAS 与人工设定保护）。
			// 批量合批会拆散 expectedPrimary 乐观锁与逐候选状态翻转，暂不做；N+1 开销已知，留待后续安全合批。
			landing := plan.landing
			req := ConfirmProjectAssetCandidateRequest{AssetID: plan.targetID}
			if plan.mode == ReconcileActionCreate {
				req.AssetID = ""
			}
			if _, err := s.confirmLoadedAssetCandidate(userID, projectID, landing, req); err != nil {
				return receipt, err
			}
			targetID = landing.ResolvedAssetID
			receipt.Results = append(receipt.Results, ReconcileApplyOutcome{
				CandidateID: landing.ID, Action: plan.mode, AssetID: targetID,
				Outcome: ReconcileOutcomeApplied, CandidateStatus: landing.Status,
			})
		} else {
			// 显式决策都已确认且目标一致：只回执实际生效动作，不写入。
			targetID = plan.resolvedID
			for _, candidate := range plan.explicit {
				receipt.Results = append(receipt.Results, ReconcileApplyOutcome{
					CandidateID: candidate.ID, Action: ReconcileActionMerge, AssetID: targetID,
					Outcome: ReconcileOutcomeAlreadyConfirmed, CandidateStatus: candidate.Status,
				})
			}
		}
		// 闭包内其余待确认出现（含仅别名链相连的）一律落到同一资产；已确认出现保持原资产不动。
		for memberIndex := range cluster.Candidates {
			member := &cluster.Candidates[memberIndex]
			if member.Status != "pending_confirmation" {
				continue
			}
			if plan.landing != nil && member.ID == plan.landing.ID {
				continue
			}
			if err := s.resolveCandidateToAsset(userID, projectID, member, targetID); err != nil {
				return receipt, err
			}
			receipt.Results = append(receipt.Results, ReconcileApplyOutcome{
				CandidateID: member.ID, Action: ReconcileActionMerge, AssetID: targetID,
				Outcome: ReconcileOutcomeAutoLinked, CandidateStatus: member.Status,
			})
		}
	}
	return receipt, nil
}

// resolveCandidateToAsset 只把跨集出现落到已定实体资产上：不写设定、不新建版本。
// 落点资产必须与候选同分类：legacy 跨分类 ResolvedAssetID 或误指目标不得经自动落点绕过分类校验。
func (s *Service) resolveCandidateToAsset(userID string, projectID string, candidate *model.ProjectAssetCandidate, assetID string) error {
	asset, err := s.repo.AssetForUser(userID, assetID)
	if err != nil {
		return err
	}
	if asset.Category != candidate.Category {
		return kernel.BadAuthRequest("候选与目标资产分类不一致，不能归并")
	}
	now := time.Now()
	candidate.Status = "confirmed"
	candidate.ResolvedAssetID = assetID
	candidate.UpdatedAt = now
	folderID, err := s.resolveAssetFolderID(projectID, nil)
	if err != nil {
		return err
	}
	position, err := s.repo.NextProjectAssetPosition(projectID, folderID)
	if err != nil {
		return err
	}
	link := model.ProjectAssetLink{ID: kernel.NewID(), ProjectID: projectID, AssetID: assetID, FolderID: folderID, Position: position, CreatedAt: now}
	emptyVersion := model.AssetVersion{}
	if err := s.repo.ConfirmProjectAssetCandidateActive(userID, candidate, asset, &emptyVersion, &link, false); err != nil {
		return mapProjectWriteError(err)
	}
	return nil
}

func normalizeReconcileDecisions(input []ReconcileDecision) ([]ReconcileDecision, error) {
	if len(input) == 0 {
		return nil, kernel.BadAuthRequest("至少要有一条归并决策")
	}
	if len(input) > maxReconcileApplyDecisions {
		return nil, kernel.BadAuthRequest("一次最多确认 50 条归并决策")
	}
	decisions := make([]ReconcileDecision, 0, len(input))
	seen := make(map[string]struct{}, len(input))
	for _, raw := range input {
		candidateID := strings.TrimSpace(raw.CandidateID)
		assetID := strings.TrimSpace(raw.AssetID)
		action := strings.TrimSpace(raw.Action)
		if candidateID == "" {
			return nil, kernel.BadAuthRequest("归并决策缺少候选 ID")
		}
		if _, duplicate := seen[candidateID]; duplicate {
			return nil, kernel.BadAuthRequest("同一条候选不能在一个批次里确认两次")
		}
		seen[candidateID] = struct{}{}
		switch action {
		case ReconcileActionMerge:
			if assetID == "" {
				return nil, kernel.BadAuthRequest("合并决策必须指定目标资产")
			}
		case ReconcileActionCreate:
			if assetID != "" {
				return nil, kernel.BadAuthRequest("新建决策不能指定已有资产")
			}
		default:
			return nil, kernel.BadAuthRequest("不支持的归并决策动作")
		}
		decisions = append(decisions, ReconcileDecision{CandidateID: candidateID, Action: action, AssetID: assetID})
	}
	sort.Slice(decisions, func(i, j int) bool { return decisions[i].CandidateID < decisions[j].CandidateID })
	return decisions, nil
}

func marshalReconcileApplyPayload(projectID string, decisions []ReconcileDecision) ([]byte, error) {
	encoded, err := json.Marshal(map[string]any{"projectId": projectID, "decisions": decisions})
	if err != nil {
		return nil, kernel.BadAuthRequest("归并决策无法校验")
	}
	return operations.CanonicalJSON(encoded), nil
}

func reconcileApplyOpID(payload []byte) string {
	return reconcileApplyOpIDPrefix + operations.PayloadHash(ReconcileApplyOp, payload)
}

func marshalReconcileApplyReceipt(receipt reconcileApplyReceipt) ([]byte, error) {
	encoded, err := json.Marshal(receipt)
	if err != nil {
		return nil, kernel.BadAuthRequest("归并回执无法保存")
	}
	return encoded, nil
}

func unmarshalReconcileApplyReceipt(raw []byte) (reconcileApplyReceipt, error) {
	var stored reconcileApplyReceipt
	if err := json.Unmarshal(raw, &stored); err != nil || stored.ProjectID == "" {
		return reconcileApplyReceipt{}, kernel.NewAppError(kernel.CodeInternal, "已写入回执无法读取")
	}
	return stored, nil
}
