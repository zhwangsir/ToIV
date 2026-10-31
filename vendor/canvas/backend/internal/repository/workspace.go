package repository

import (
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *Repository) Workspace(id string) (*model.Workspace, error) {
	var value model.Workspace
	if err := r.db.First(&value, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &value, nil
}

func (r *Repository) DefaultWorkspace() (*model.Workspace, error) {
	var value model.Workspace
	if err := r.db.Order("created_at ASC").First(&value).Error; err != nil {
		return nil, err
	}
	return &value, nil
}

// WorkspaceIdentity returns the binding for an external subject (gorm.ErrRecordNotFound if none).
func (r *Repository) WorkspaceIdentity(subject string) (*model.WorkspaceIdentity, error) {
	var value model.WorkspaceIdentity
	if err := r.db.First(&value, "subject = ?", subject).Error; err != nil {
		return nil, err
	}
	return &value, nil
}

// EnsureWorkspaceIdentity returns the workspace bound to subject, creating an empty
// workspace (id = subject) and the binding on first sight. Concurrent first requests
// converge on one row through ON CONFLICT DO NOTHING + re-read.
func (r *Repository) EnsureWorkspaceIdentity(subject, name, source string) (*model.Workspace, bool, error) {
	if binding, err := r.WorkspaceIdentity(subject); err == nil {
		ws, wsErr := r.Workspace(binding.WorkspaceID)
		return ws, false, wsErr
	}
	created := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		ws := model.Workspace{ID: subject, Name: name, CreatedAt: now, UpdatedAt: now}
		res := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&ws)
		if res.Error != nil {
			return res.Error
		}
		created = res.RowsAffected > 0
		binding := model.WorkspaceIdentity{Subject: subject, WorkspaceID: subject, Source: source, CreatedAt: now}
		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&binding).Error
	})
	if err != nil {
		return nil, false, err
	}
	binding, err := r.WorkspaceIdentity(subject)
	if err != nil {
		return nil, false, err
	}
	ws, err := r.Workspace(binding.WorkspaceID)
	return ws, created, err
}

// AssistantTurnOwner returns the workspace that opened an assistant turn.
func (r *Repository) AssistantTurnOwner(turnID string) (string, error) {
	var owner string
	err := r.db.Model(&model.AssistantTurn{}).Select("user_id").Where("turn_id = ?", turnID).Limit(1).Scan(&owner).Error
	if err != nil {
		return "", err
	}
	if owner == "" {
		return "", gorm.ErrRecordNotFound
	}
	return owner, nil
}
