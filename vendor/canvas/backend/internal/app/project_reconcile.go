package app

import (
	localproject "infinite-canvas/backend/internal/project"
)

type AssetReconciliation = localproject.AssetReconciliation
type AssetDrift = localproject.AssetDrift
type CandidateIdentityGroup = localproject.CandidateIdentityGroup
type ReconcileDecision = localproject.ReconcileDecision
type ReconcileApplyRequest = localproject.ReconcileApplyRequest
type ReconcileApplyResult = localproject.ReconcileApplyResult
type ReconcileApplyOutcome = localproject.ReconcileApplyOutcome

func (s *Service) ProjectAssetReconciliation(userID string, projectID string) (AssetReconciliation, error) {
	return s.projectDomain().ProjectAssetReconciliation(userID, projectID)
}

func (s *Service) ApplyAssetReconciliationDecisions(userID string, projectID string, req ReconcileApplyRequest) (ReconcileApplyResult, error) {
	return s.projectDomain().ApplyAssetReconciliationDecisions(userID, projectID, req)
}
